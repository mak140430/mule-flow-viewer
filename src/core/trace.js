// Following a flow as Mule runs it: each step in order, into the flows it calls (an APIkit router's flows and
// library flows too), with the variables each step sets and reads. A variable read before anything on the way to it
// sets it is flagged when the trace starts at an entry point (a flow with a source, so nothing outside sets it).

import { walkFlow, scriptsOf } from './model.js';

const MAX_DEPTH = 14;
const VAR_READ = /\bvars\s*(?:\.\s*([A-Za-z_$][\w$-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/** Variable names an expression or script reads. */
export function varsRead(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(VAR_READ)) out.add(m[1] || m[2]);
  return out;
}

/** Variables an expression reads with a fallback (vars.x default ...): fine when nothing set them. */
function varsWithDefault(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(/\bvars\s*(?:\.\s*([A-Za-z_$][\w$-]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*default\b/g)) out.add(m[1] || m[2]);
  return out;
}

/** What a step sets: set-variable, a Transform's variables, a target, a For Each's counter, an APIkit router's. */
function varsSet(p, project) {
  const out = new Set();
  const a = p.node.attrs;
  if (p.key === 'apikit:router') {
    const cfg = project.globals.get(a['config-ref'])?.node.attrs || {};
    out.add(cfg.outboundHeadersMapName || 'outboundHeaders');
    out.add(cfg.httpStatusVarName || 'httpStatus');
  }
  if (p.key === 'core:set-variable' && a.variableName) out.add(a.variableName);
  if (a.target) out.add(a.target);
  if (p.key === 'ee:transform') for (const s of scriptsOf(p)) if (s.label.startsWith('vars.')) out.add(s.label.slice(5));
  if (p.key === 'core:foreach' || p.key === 'core:parallel-foreach') {
    out.add(a.counterVariableName || 'counter');
    out.add(a.rootMessageVariableName || 'rootMessage');
  }
  return out;
}

/** What a step reads: its own attributes, its scripts (DataWeave files too), a router's conditions; and which of
 * those it reads with a default. */
function varsOf(p, project) {
  const read = new Set();
  const safe = new Set();
  const add = (t) => { varsRead(t).forEach((v) => read.add(v)); varsWithDefault(t).forEach((v) => safe.add(v)); };
  for (const [k, v] of Object.entries(p.node.attrs)) if (k !== 'doc:name' && k !== 'doc:id') add(v);
  for (const s of scriptsOf(p)) add(project.scriptCode(s));
  for (const r of p.routes || []) add(r.expr);
  return { read, safe };
}

/**
 * The steps of a flow, nested: {label, key, item, flow, project, sets, reads, unset (read, not set before),
 * children, branch (route / handler label), note}. opts.libraryFlows: Map(name -> {project, flow, lib}).
 * Returns {root, vars: Map(name -> {sets: [step], reads: [step]}), entry}.
 */
export function trace(project, flowName, { libraryFlows = new Map() } = {}) {
  const vars = new Map();
  const v = (name) => (vars.has(name) || vars.set(name, { sets: [], reads: [] }), vars.get(name));
  const start = project.flows.get(flowName);
  if (!start) return null;
  const entry = !!start.source;

  function step(p, flow, proj, known, stack, depth) {
    const sets = varsSet(p, proj);
    const { read: reads, safe } = varsOf(p, proj);
    const node = { label: p.label, key: p.key, item: p, flow, project: proj, sets: [...sets], reads: [...reads], safe: [...safe], unset: [], children: [] };
    for (const r of reads) {
      v(r).reads.push(node);
      // a source reads its response expressions once the flow is done (flowSteps checks those at the end)
      if (entry && p.kind !== 'source' && !known.has(r) && !sets.has(r) && !safe.has(r)) node.unset.push(r);
    }
    // the steps inside: routes and scopes run with what is known so far; what they set is known after them
    if (p.routes) {
      const after = new Set(known);
      for (const r of p.routes) {
        const k = new Set(known);
        node.children.push({ branch: r.label + (r.expr ? ` ${r.expr}` : ''), steps: chain(r.processors, flow, proj, k, stack, depth) });
        k.forEach((x) => after.add(x));
      }
      after.forEach((x) => known.add(x));
    }
    if (p.body) {
      sets.forEach((x) => known.add(x));       // a For Each's counter is there inside it
      node.children.push({ branch: null, steps: chain(p.body, flow, proj, known, stack, depth) });
    }
    if (p.errorHandler) handlers(node, p.errorHandler, flow, proj, known, stack, depth);
    if (p.kind === 'flow-ref') {
      const own = proj.flows.get(p.target);
      const lib = !own && libraryFlows.get(p.target);
      const target = own || lib?.flow;
      if (p.dynamic) node.note = 'dynamic: the flow is chosen at run time';
      else if (!target) node.note = 'not in this project or its libraries';
      else if (stack.has(p.target)) node.note = 'calls itself (stops here)';
      else if (depth >= MAX_DEPTH) node.note = 'deeper calls not shown';
      else node.children.push({ branch: null, call: p.target, lib: lib?.lib || null, steps: flowSteps(target, own ? proj : lib.project, known, new Set([...stack, p.target]), depth + 1) });
    }
    if (p.key === 'apikit:router') {
      for (const t of proj.apikitTargets(p.node.attrs['config-ref'])) {
        const f = proj.flows.get(t.flow);
        if (f && !stack.has(t.flow) && depth < MAX_DEPTH) node.children.push({ branch: t.label, call: t.flow, steps: flowSteps(f, proj, new Set(known), new Set([...stack, t.flow]), depth + 1) });
      }
    }
    sets.forEach((x) => { v(x).sets.push(node); known.add(x); });
    return node;
  }

  function chain(list, flow, proj, known, stack, depth) {
    return (list || []).map((p) => step(p, flow, proj, known, stack, depth));
  }

  function handlers(node, eh, flow, proj, known, stack, depth) {
    const list = eh.handlers || (eh.ref ? proj.flows.get(eh.ref)?.handlers : null) || [];
    for (const hnd of list) {
      const label = `${hnd.key === 'core:on-error-continue' ? 'On Error Continue' : 'On Error Propagate'}${hnd.errorType ? ` ${hnd.errorType}` : ''}`;
      node.children.push({ branch: label, error: true, steps: chain(hnd.body, flow, proj, new Set(known), stack, depth) });
    }
  }

  function flowSteps(flow, proj, known, stack, depth) {
    const steps = [];
    const source = flow.source ? step(flow.source, flow, proj, known, stack, depth) : null;
    if (source) steps.push(source);
    steps.push(...chain(flow.processors, flow, proj, known, stack, depth));
    if (source && entry) source.unset = source.reads.filter((r) => !known.has(r) && !source.safe.includes(r));
    if (flow.errorHandler) {
      const holder = { label: 'Error handling', key: 'core:error-handler', item: null, flow, project: proj, sets: [], reads: [], safe: [], unset: [], children: [] };
      handlers(holder, flow.errorHandler, flow, proj, known, stack, depth);
      if (holder.children.length) steps.push(holder);
    }
    return steps;
  }

  const root = { flow: start, steps: flowSteps(start, project, new Set(), new Set([flowName]), 0) };
  return { root, vars, entry };
}

/** Every step of a trace, in order (for counting and tests). */
export function traceSteps(t) {
  const out = [];
  const walk = (steps) => steps.forEach((s) => { out.push(s); s.children.forEach((c) => walk(c.steps)); });
  walk(t.root.steps);
  return out;
}

export { walkFlow };
