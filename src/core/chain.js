// Runs a flow from an MUnit test's event up to a script, so the script gets the event it would see:
// transforms, set-variable / set-payload and the Choice routes taken are executed with the local
// engine, mocked processors return their then-return, flow references run in line. A processor that
// is neither (a connector call the test doesn't mock) leaves the payload unknown; the last value is
// kept as the guess and the sample is marked approximate.

import { mockFor, evaluateValue, expressionScript, JSON_MIME } from './munit.js';
import { scriptsOf } from './model.js';
import { dwImports, modulePath } from './dataweave.js';

const NO_EFFECT = new Set(['core:logger']);
const INLINE_SCOPES = new Set(['core:try', 'core:until-successful', 'ee:cache']);
// the payload afterwards is the one before (For Each restores it); what runs inside is skipped
const SIDE_SCOPES = new Set(['core:async', 'core:foreach', 'core:parallel-foreach', 'batch:job']);
const MAX_STEPS = 300;

/** Project modules imported directly or transitively, as {path: code}. */
export function modulesOf(code, project) {
  const out = {};
  const queue = dwImports(code).map(modulePath).filter(Boolean);
  while (queue.length) {
    const path = queue.shift();
    const d = project.dwl.get(path);
    if (!d || out[path]) continue;
    out[path] = d.code;
    queue.push(...d.imports.map(modulePath).filter(Boolean));
  }
  return out;
}

// ------------------------------------------------------------ where a script sits in a test's run

/** Lists a processor leads into, with how the event enters them. */
function inner(project, p, viaRouter) {
  const out = [];
  p.routes?.forEach((route) => out.push({ list: route.processors, enter: { kind: 'route', processor: p, route } }));
  if (p.body) out.push({ list: p.body, enter: { kind: /foreach$/.test(p.key) ? 'foreach' : 'scope', processor: p } });
  p.errorHandler?.handlers?.forEach((h) => out.push({ list: h.body, enter: { kind: 'handler', processor: h } }));
  const flows = p.kind === 'flow-ref' && !p.dynamic ? [p.target]
    : viaRouter && p.key === 'apikit:router' ? project.apikitTargets(p.node.attrs['config-ref']).map((t) => t.flow) : [];
  for (const name of flows) {
    const flow = project.flows.get(name);
    if (!flow) continue;
    out.push({ list: flow.processors, enter: { kind: 'flow', flow } });
    flow.errorHandler?.handlers?.forEach((h) => out.push({ list: h.body, enter: { kind: 'handler', processor: h }, flow }));
  }
  return out;
}

/** [{list, index, enter}] from the test's flow references down to `target`, or null. */
function pathTo(project, list, target, seen, viaRouter) {
  for (const [index, q] of list.entries()) {
    if (q === target) return [{ list, index }];
    for (const c of inner(project, q, viaRouter)) {
      const flow = c.enter.flow || c.flow;
      if (flow) {
        if (seen.has(flow.name + c.enter.kind)) continue;
        seen.add(flow.name + c.enter.kind);
      }
      const rest = pathTo(project, c.list, target, seen, viaRouter);
      if (rest) return [{ list, index, enter: c.enter }, ...rest];
    }
  }
  return null;
}

const flowRef = (name) => ({ key: 'core:flow-ref', kind: 'flow-ref', target: name, dynamic: false, label: name });

/** Without running anything: does every step before the script have a known effect? */
function likelyExact(project, test, frames) {
  const known = (list, depth = 0) => depth < 20 && list.every((q) => {
    if (mockFor(test, q) || NO_EFFECT.has(q.key) || SIDE_SCOPES.has(q.key) || q.node?.attrs.target || q.key.startsWith('validation:')) return true;
    if (['core:set-variable', 'core:remove-variable', 'core:set-payload', 'ee:transform'].includes(q.key)) return true;
    if (q.key === 'core:choice') return q.routes.every((r) => known(r.processors, depth + 1));
    if (INLINE_SCOPES.has(q.key)) return known(q.body, depth + 1);
    if (q.kind === 'flow-ref' && project.flows.has(q.target)) return known(project.flows.get(q.target).processors, depth + 1);
    return false;
  });
  return frames.every((f) => f.enter?.kind !== 'handler' && known(f.list.slice(0, f.index)));
}

/** Tests that run a script used by processors `sites` ([{processor, flow}]), likely-exact ones first. */
export function testSamples(project, sites) {
  const collect = (viaRouter) => {
    const out = [];
    for (const test of project.tests || []) {
      if (test.ignored) continue;
      const start = test.targets.map(flowRef);
      for (const site of sites) {
        const frames = pathTo(project, start, site.processor, new Set(), viaRouter);
        if (frames) { out.push({ test, site, frames, likely: likelyExact(project, test, frames) }); break; }
      }
    }
    return out;
  };
  const out = collect(false);
  return (out.length ? out : collect(true)).sort((a, b) => b.likely - a.likely);
}

// ------------------------------------------------------------ running it

/** Runner inputs for the current event: vars as one JSON object, other formats one by one. */
export function eventInputs(state) {
  const vars = [...state.vars];
  return {
    payload: state.payload || { text: 'null', mime: JSON_MIME },
    attributes: state.attributes || { text: 'null', mime: JSON_MIME },
    vars: { text: jsonObject(vars.filter(([, v]) => v.mime === JSON_MIME), []), mime: JSON_MIME },
    ...Object.fromEntries(vars.filter(([, v]) => v.mime !== JSON_MIME).map(([k, v]) => [`vars.${k}`, v])),
  };
}

export function jsonObject(entries, missing) {
  const lines = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${v.text.trim().replace(/\n/g, '\n  ')}`)
    .concat(missing.map((k) => `  ${JSON.stringify(k)}: null`));
  return lines.length ? `{\n${lines.join(',\n')}\n}` : '{}';
}

/** A script with its output as JSON when it would be Java or DataWeave values; {script, mime}. */
function chainScript(code) {
  const lines = code.split('\n');
  const sep = lines.findIndex((l) => l.trim() === '---');
  if (sep < 0) return { script: code, mime: JSON_MIME };
  const at = lines.slice(0, sep).findIndex((l) => /^\s*output\s+/.test(l));
  const mime = at >= 0 ? /^\s*output\s+([\w/+.-]+)/.exec(lines[at])[1] : null;
  if (mime && !/^application\/(java|dw)$/.test(mime)) return { script: code, mime };
  if (at >= 0) lines[at] = 'output application/json';
  else lines.splice(Math.max(0, lines.findIndex((l) => /^\s*%dw/.test(l)) + 1), 0, 'output application/json');
  return { script: lines.join('\n'), mime: JSON_MIME };
}

/**
 * Runs the test up to the script. Returns the event there: {payload, attributes, vars: Map,
 * exact, blocker, errors, unknownVars: Map(name -> processor that sets it), offRoute}. onStep(count) reports progress.
 */
export async function runSample(sample, env, onStep = () => {}) {
  const { project, engine, properties } = env;
  const { test, frames } = sample;
  const state = {
    payload: null, attributes: null, vars: new Map(), exact: true, blocker: null, errors: [], unknownVars: new Map(),
    offRoute: null,   // {choice, taken}: the test takes another route, so it never reaches the script
  };
  let steps = 0;

  const run = async (code, script) => {
    const r = await engine.run({ script, modules: modulesOf(code, project), properties, inputs: eventInputs(state) });
    if (!r.ok) throw new Error(r.error.split('\n')[0]);
    if (r.truncated) throw new Error('its output is larger than 1 MB');
    return r.output;
  };
  const value = (v) => evaluateValue(v, env, eventInputs(state));
  /** `#[expr]` or a literal, as {text, mime}. */
  const expression = async (raw, mimeType = '') => {
    const code = /^#\[([\s\S]*)\]$/.exec((raw ?? '').trim())?.[1];
    if (code == null) return /json|xml|csv|yaml/.test(mimeType) ? { text: raw ?? '', mime: mimeType } : { text: JSON.stringify(raw ?? null), mime: JSON_MIME };
    const { script, mime } = expressionScript(code, JSON_MIME);
    return { text: await run(code, script), mime };
  };
  const opaque = (q) => {
    const target = q.node?.attrs.target;
    if (target) { state.vars.delete(target); state.unknownVars.set(target, q); return; }
    state.exact = false;
    state.blocker = q;
  };

  async function mock(m, q) {
    for (const v of m.vars) state.vars.set(v.key, await value(v));
    if (!m.payload) return;
    const target = q.node?.attrs.target;
    if (target) { state.vars.set(target, await value(m.payload)); return; }
    const attributes = m.attributes ? await value(m.attributes) : state.attributes;
    state.payload = await value(m.payload);
    state.attributes = attributes;
    state.exact = true;
    state.blocker = null;
  }

  async function transform(q) {
    // every script of a Transform Message reads the same event; results apply together
    const results = await Promise.all(scriptsOf(q).map(async (s) => {
      const code = project.scriptCode(s);
      if (code == null) throw new Error(`${s.resource} is not in the project`);
      const { script, mime } = chainScript(code);
      return [s.label, { text: await run(code, script), mime }];
    }));
    for (const [label, v] of results) {
      if (label === 'payload') state.payload = v;
      else if (label === 'attributes') state.attributes = v;
      else state.vars.set(label.slice('vars.'.length), v);
    }
  }

  async function route(q) {
    for (const r of q.routes) {
      if (r.label === 'Default') return r;
      const v = await expression(r.expr);
      if (v.text.trim() === 'true') return r;
    }
    return null;
  }

  async function step(q, depth) {
    if (++steps > MAX_STEPS) throw new Error(`stopped after ${MAX_STEPS} steps`);
    onStep(steps);
    const m = mockFor(test, q);
    if (m) return mock(m, q);
    const a = q.node?.attrs || {};
    if (NO_EFFECT.has(q.key) || SIDE_SCOPES.has(q.key) || q.key.startsWith('validation:')) return;
    if (q.key === 'core:remove-variable') return void state.vars.delete(a.variableName);
    if (q.key === 'core:set-variable') return void state.vars.set(a.variableName, await expression(a.value, a.mimeType));
    if (q.key === 'core:set-payload') return void (state.payload = await expression(a.value, a.mimeType));
    if (q.key === 'ee:transform') return transform(q);
    if (q.key === 'core:choice') {
      const r = await route(q);
      return r && list(r.processors, depth + 1);
    }
    if (INLINE_SCOPES.has(q.key)) return list(q.body, depth + 1);
    if (q.kind === 'flow-ref' && !q.dynamic && project.flows.has(q.target) && depth < 40) {
      return list(project.flows.get(q.target).processors, depth + 1);
    }
    return opaque(q);
  }

  async function list(processors, depth = 0) {
    for (const q of processors) {
      try {
        await step(q, depth);
      } catch (e) {
        if (/^stopped after/.test(e.message)) throw e;
        state.errors.push(`“${q.label}”: ${e.message}`);
        opaque(q);
      }
    }
  }

  async function enter({ kind, processor, route: wanted }) {
    if (kind === 'route' && processor.key === 'core:choice' && !state.offRoute) {
      try {
        const taken = await route(processor);
        if (taken && taken !== wanted) state.offRoute = { choice: processor, taken };
      } catch { /* the condition can't be evaluated with this event: assume the route is taken */ }
    } else if (kind === 'handler') {
      state.exact = false;
      state.blocker = processor;
    } else if (kind === 'foreach') {
      // inside a For Each the payload is one item; the first one stands in
      const a = processor.node.attrs;
      const collection = /^#\[([\s\S]*)\]$/.exec((a.collection || '#[payload]').trim())?.[1] ?? 'payload';
      try {
        state.payload = await expression(`#[(${collection})[0]]`);
        if (processor.key === 'core:foreach') state.vars.set(a.counterVariableName || 'counter', { text: '1', mime: JSON_MIME });
      } catch (e) {
        state.errors.push(`“${processor.label}”: ${e.message}`);
        opaque(processor);
      }
    }
  }

  try {
    if (test.event.payload) state.payload = await value(test.event.payload);
    if (test.event.attributes) state.attributes = await value(test.event.attributes);
    for (const v of test.event.vars) state.vars.set(v.key, await value(v));
  } catch (e) {
    state.errors.push(`The test's event: ${e.message}`);
  }
  try {
    for (const f of frames) {
      await list(f.list.slice(0, f.index));
      if (f.enter) await enter(f.enter);
    }
  } catch (e) {
    state.errors.push(e.message);
    state.exact = false;
  }
  return state;
}
