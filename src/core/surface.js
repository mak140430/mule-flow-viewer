// An app's surface, from its own files: what starts it (HTTP paths and the API resources an APIkit router
// dispatches to, schedules, queues and other listeners), what it calls (each connector configuration with the
// operations that use it), which entry points reach a flow, and for each entry point which errors can reach it,
// which handler takes each one and what HTTP status it answers with.

import { walkFlow, scriptsOf } from './model.js';

// ------------------------------------------------------------------ entry points

const joinPath = (...parts) => `/${parts.map((p) => (p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
const SOURCE_ATTRS = ['path', 'destination', 'queueName', 'queue', 'topic', 'topicName', 'directory', 'objectType', 'channel', 'subject', 'table', 'url', 'eventType'];
const UNITS = { MILLISECONDS: 'ms', SECONDS: 's', MINUTES: 'min', HOURS: 'h', DAYS: 'd' };

/** `get:\orders\(id):application\json:api-config` -> {method: 'GET', path: '/orders/{id}', type, config} */
export function apikitRoute(name) {
  const m = /^(get|post|put|patch|delete|head|options):(\\[^:]*)(?::([^:]+))?:([^:]+)$/i.exec(name || '');
  if (!m) return null;
  return {
    method: m[1].toUpperCase(),
    path: m[2].replace(/\\/g, '/').replace(/\(([^)]+)\)/g, '{$1}') || '/',
    type: m[3] ? m[3].replace(/\\/g, '/') : null,
    config: m[4],
  };
}

function schedule(source) {
  const strategy = source.node.children.find((c) => c.local === 'scheduling-strategy')?.children[0];
  if (!strategy) return 'on a schedule';
  if (strategy.local === 'cron') return `cron ${strategy.attrs.expression || ''}${strategy.attrs.timeZone ? ` (${strategy.attrs.timeZone})` : ''}`;
  const n = strategy.attrs.frequency || '60000';
  return `every ${n} ${UNITS[strategy.attrs.timeUnit || 'MILLISECONDS'] || strategy.attrs.timeUnit.toLowerCase()}`;
}

/**
 * Where the app starts: [{key, kind ('http' | 'api' | 'schedule' | 'source'), method, path, label, flow, source,
 * via (the HTTP entry an API resource is reached through), router (its APIkit router)}], HTTP first.
 */
export function entryPoints(project) {
  const out = [];
  for (const flow of project.flows.values()) {
    const s = flow.source;
    if (!s || flow.kind !== 'flow') continue;
    const a = s.node.attrs;
    if (s.key === 'http:listener') {
      const cfg = project.globals.get(a['config-ref']);
      const path = joinPath(cfg?.node.attrs.basePath, a.path || '/');
      const method = a.allowedMethods ? a.allowedMethods.split(',').map((x) => x.trim().toUpperCase()).join(', ') : 'ANY';
      const entry = { key: `${method} ${path} ${flow.name}`, kind: 'http', method, path, label: `${method} ${path}`, config: a['config-ref'], flow, source: s, routes: [] };
      out.push(entry);
      const routers = [];
      walkFlow(flow, (p) => { if (p.key === 'apikit:router') routers.push(p); });
      const prefix = path.replace(/\/\*$/, '');
      for (const router of routers) {
        for (const t of project.apikitTargets(router.node.attrs['config-ref'])) {
          const target = project.flows.get(t.flow);
          if (!target) continue;
          const r = apikitRoute(t.flow) || (([m, p]) => ({ method: (m || '').toUpperCase(), path: p || '/' }))(t.label.split(' '));
          const api = { key: `${r.method} ${prefix}${r.path}${r.type ? ` ${r.type}` : ''}`, kind: 'api', method: r.method, path: joinPath(prefix, r.path), type: r.type || null, flow: target, source: s, via: entry, router };
          api.label = `${api.method} ${api.path}`;
          entry.routes.push(api);
          out.push(api);
        }
      }
    } else if (s.key === 'core:scheduler') {
      out.push({ key: `schedule ${flow.name}`, kind: 'schedule', label: schedule(s), flow, source: s });
    } else {
      const detail = SOURCE_ATTRS.map((k) => a[k]).find(Boolean);
      out.push({ key: `${s.key} ${flow.name}`, kind: 'source', label: `${s.label}${detail ? ` ${detail}` : ''}`, flow, source: s });
    }
  }
  const order = { http: 0, api: 0, schedule: 1, source: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || (x.kind === 'api' && y.kind === 'api' ? x.path.localeCompare(y.path) || x.method.localeCompare(y.method) : 0));
}

/**
 * reach(flowName) -> Set of the entry points that run that flow, following who calls whom (flow references, APIkit
 * routes, error handlers by reference, lookup()) up to the nearest entry point. A flow that is an API resource
 * stops at that resource (not the listener every resource shares).
 */
export function reacher(project, entries = entryPoints(project)) {
  const byFlow = new Map();
  for (const e of entries) {
    if (!byFlow.has(e.flow.name)) byFlow.set(e.flow.name, []);
    byFlow.get(e.flow.name).push(e);
  }
  // the default error handler runs for every flow without its own
  const unhandled = entries.filter((e) => !e.flow.errorHandler);
  const memo = new Map();
  return (name) => {
    if (memo.has(name)) return memo.get(name);
    const found = new Set();
    const seen = new Set();
    const stack = [name];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      const own = byFlow.get(n);
      if (own) { own.forEach((e) => found.add(e)); continue; }
      if (n === project.defaultErrorHandler) unhandled.forEach((e) => found.add(e));
      for (const c of project.callers.get(n) || []) if (c.flow?.name) stack.push(c.flow.name);
    }
    memo.set(name, found);
    return found;
  };
}

// ------------------------------------------------------------------ what it calls

// configurations that are not something the app calls out to
const NOT_OUTBOUND = /^(core:|ee:|doc:|http:listener-config$|apikit:|secure-properties:|api-gateway:|tls:|spring:|os:|vm:config$|validation:|java:|scripting:|munit|crypto:|compression:|tracing:|json-logger:|batch:)/;
const CONNECTION_ATTRS = ['protocol', 'host', 'port', 'basePath', 'url', 'address', 'wsdlLocation', 'service', 'port', 'database', 'baseUri', 'endpoint', 'brokerUrl', 'serverUrl', 'workingDir', 'region', 'bucket', 'instance', 'clientId'];
const SECRET = /pass|secret|token|key|credential|pwd/i;

/**
 * [{config, connector (prefix), label, settings: [{name, raw}], uses: [{processor, flow, label}]}] for every
 * configuration the app reaches other systems through, most used first.
 */
export function outboundCalls(project) {
  const uses = new Map();
  for (const flow of project.flows.values()) {
    walkFlow(flow, (p) => {
      const ref = p.node.attrs['config-ref'];
      if (!ref || p.kind === 'source') return;
      if (!uses.has(ref)) uses.set(ref, []);
      const a = p.node.attrs;
      const method = a.method ? (a.method.includes('#[') ? a.method : a.method.toUpperCase()) : 'GET';
      const what = p.key === 'http:request' ? `${method} ${a.path || a.url || '/'}`
        : a.path || a.queueName || a.destination || a.type || a.objectType || a.key || '';
      uses.get(ref).push({ processor: p, flow, label: p.label, what });
    });
  }
  const out = [];
  for (const g of project.globals.values()) {
    if (!g.name || NOT_OUTBOUND.test(g.key)) continue;
    const settings = [];
    const add = (node) => {
      for (const k of CONNECTION_ATTRS) {
        if (node.attrs[k] && !SECRET.test(k) && !settings.some((s) => s.name === k)) settings.push({ name: k, raw: node.attrs[k] });
      }
    };
    add(g.node);
    for (const c of g.node.children) if (/connection$/i.test(c.local)) add(c);
    const u = uses.get(g.name) || [];
    if (!u.length && !settings.length) continue;
    out.push({ config: g, connector: g.key.split(':')[0], label: g.node.attrs['doc:name'] && g.node.attrs['doc:name'] !== g.name ? `${g.name} (${g.node.attrs['doc:name']})` : g.name, settings, uses: u });
  }
  return out.sort((x, y) => y.uses.length - x.uses.length || x.label.localeCompare(y.label));
}

// ------------------------------------------------------------------ errors per entry point

const VALIDATION = {
  'is-true': 'INVALID_BOOLEAN', 'is-false': 'INVALID_BOOLEAN', 'is-not-null': 'NULL', 'is-null': 'NOT_NULL',
  'is-not-blank-string': 'BLANK_STRING', 'is-blank-string': 'NOT_BLANK_STRING', 'is-not-empty-collection': 'EMPTY_COLLECTION',
  'is-empty-collection': 'NOT_EMPTY_COLLECTION', 'is-number': 'INVALID_NUMBER', 'validate-size': 'INVALID_SIZE',
  'matches-regex': 'MISMATCH', 'is-email': 'INVALID_EMAIL', 'is-url': 'INVALID_URL', 'is-ip': 'INVALID_IP', 'is-time': 'INVALID_TIME', all: 'MULTIPLE',
};
// what an APIkit router raises: for one resource (the request does not match its spec), for the API as a whole
const APIKIT_RESOURCE = ['APIKIT:BAD_REQUEST', 'APIKIT:NOT_ACCEPTABLE', 'APIKIT:UNSUPPORTED_MEDIA_TYPE'];
const APIKIT_ROUTER = ['APIKIT:NOT_FOUND', 'APIKIT:METHOD_NOT_ALLOWED', 'APIKIT:NOT_IMPLEMENTED'];
export const OTHER = 'ANY';
const MAX_DEPTH = 12;

/** Whether an on-error's type list takes an error of type t (OTHER: an error of no type it names). */
export function takes(handlerType, t) {
  const list = (handlerType || 'ANY').split(',').map((x) => x.trim()).filter(Boolean);
  const [ns, id] = t.includes(':') ? t.split(':') : ['MULE', t];
  return list.some((x) => {
    if (x === 'ANY' || x === 'MULE:ANY' || x === '*' || x === '*:*') return true;
    if (t === OTHER) return false;
    const [xns, xid] = x.includes(':') ? x.split(':') : ['MULE', x];
    if (xns === ns && (xid === id || xid === '*')) return true;
    if (xns === '*' && xid === id) return true;
    // MULE:CONNECTIVITY, MULE:SECURITY, ... are the parents of every connector's errors of the same name
    return xns === 'MULE' && xid === id;
  });
}

const typesOf = (handlerType) => (handlerType || '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'ANY' && x !== 'MULE:ANY' && !x.includes('*'));

/**
 * The errors that can reach an entry point and what happens to each: [{type, raisedBy: [step labels], outcomes:
 * [{handlers: [{label, where, kind}], end ('continue' | 'propagate' | 'unhandled'), inner (caught inside a flow it
 * calls or a Try: the request goes on), status: {code} | {setBy} | {default}}]}]. opts.libraryFlows: Map(name ->
 * {project, flow, lib}).
 */
export function errorsOf(project, entry, { libraryFlows = new Map() } = {}) {
  const findFlow = (name, proj) => {
    const own = proj.flows.get(name);
    if (own) return { flow: own, project: proj };
    const lib = libraryFlows.get(name);
    return lib ? { flow: lib.flow, project: lib.project, lib: lib.lib } : null;
  };
  // the handlers of a flow: its own error handler, a global one by reference, else the app's default one
  const flowGroup = (flow, proj) => {
    let eh = flow.errorHandler;
    let where = flow.name;
    let found = proj;
    if (eh?.ref) {
      const named = findFlow(eh.ref, proj);
      eh = named?.flow;
      where = eh ? `${eh.name}${named.lib ? ` (${named.lib.artifactId})` : ''}` : eh?.ref;
      found = named?.project || proj;
    }
    if (!eh?.handlers?.length && project.defaultErrorHandler) {
      const named = findFlow(project.defaultErrorHandler, project);
      if (named?.flow?.handlers) return { where: `${named.flow.name} (default)`, handlers: named.flow.handlers, project: named.project, top: false };
    }
    return eh?.handlers?.length ? { where, handlers: eh.handlers, project: found } : { where, handlers: [], project: proj };
  };

  // where errors start, with the handlers around each (outer first). A group is `inner` when catching there lets
  // the request go on (a Try, a flow that another one calls): the answer then depends on what follows.
  const raises = [];         // {types | ns, label, stack}
  const handlerTypes = new Set();
  const note = (group) => { for (const hnd of group.handlers) typesOf(hnd.errorType).forEach((t) => handlerTypes.add(t)); };
  function walk(list, proj, stack, seen, depth) {
    for (const p of list || []) {
      const ns = p.key.split(':')[0];
      if (p.key === 'core:raise-error' && p.node.attrs.type) raises.push({ types: [p.node.attrs.type], label: p.label, stack });
      else if (ns === 'validation') raises.push({ types: [`VALIDATION:${VALIDATION[p.key.slice(11)] || 'INVALID_INPUT'}`], label: p.label, stack });
      else if (ns !== 'core' && ns !== 'ee' && p.kind === 'processor') raises.push({ ns: ns.toUpperCase(), label: p.label, stack });
      p.routes?.forEach((r) => walk(r.processors, proj, stack, seen, depth));
      if (p.key === 'core:try' && p.errorHandler) {
        const group = { where: p.label === 'Try' ? 'Try' : `Try ${p.label}`, handlers: p.errorHandler.handlers || [], project: proj, inner: true };
        note(group);
        walk(p.body, proj, [...stack, group], seen, depth);
      } else walk(p.body, proj, stack, seen, depth);
      if (p.kind === 'flow-ref' && !p.dynamic && depth < MAX_DEPTH && !seen.has(p.target)) {
        const t = findFlow(p.target, proj);
        if (t) enter(t.flow, t.project, stack, new Set([...seen, p.target]), depth + 1, true);
      }
    }
  }
  function enter(flow, proj, stack, seen, depth, inner) {
    let s = stack;
    if (flow.kind === 'flow') {
      const group = { ...flowGroup(flow, proj), inner };
      note(group);
      s = [...stack, group];
    }
    walk(flow.processors, proj, s, seen, depth);
    return s;
  }
  // the stack inside a flow, down to one of its steps (the Try scopes around it)
  function stackAt(flow, target, outer) {
    let found = null;
    const find = (list, stack) => (list || []).some((p) => {
      if (p === target) { found = stack; return true; }
      const s = p.key === 'core:try' && p.errorHandler ? [...stack, { where: 'Try', handlers: p.errorHandler.handlers || [], project, inner: true }] : stack;
      return p.routes?.some((r) => find(r.processors, s)) || find(p.body, s);
    });
    find(flow.processors, outer);
    return found || outer;
  }

  const mainFlow = entry.kind === 'api' ? entry.via.flow : entry.flow;
  const mainGroup = { ...flowGroup(mainFlow, project), inner: false };
  note(mainGroup);
  let top;
  if (entry.kind === 'api') {
    const routerStack = stackAt(mainFlow, entry.router, [mainGroup]);
    routerStack.forEach(note);
    for (const t of APIKIT_RESOURCE) raises.push({ types: [t], label: entry.router.label, stack: routerStack });
    // a resource flow's own handler answers the request (the router returns to the listener's flow)
    top = enter(entry.flow, project, routerStack, new Set([entry.flow.name]), 1, false);
  } else {
    top = [mainGroup];
    if (entry.source) raises.push({ ns: entry.source.key.split(':')[0].toUpperCase(), label: entry.source.label, stack: top });
    walk(mainFlow.processors, project, top, new Set([mainFlow.name]), 0);
    if (entry.routes?.length) {
      walkFlow(mainFlow, (p) => {
        if (p.key === 'apikit:router') for (const t of APIKIT_ROUTER) raises.push({ types: [t], label: p.label, stack: stackAt(mainFlow, p, top) });
      });
    }
  }

  // a row per type raised here, or named by a handler on the way for errors that can happen here (a connector's
  // own for its operations, Mule's own anywhere)
  const rows = new Map();
  const addRow = (type, raise) => {
    if (!rows.has(type)) rows.set(type, { type, raisedBy: new Set(), raises: [] });
    rows.get(type).raisedBy.add(raise.label);
    rows.get(type).raises.push(raise);
  };
  for (const r of raises) {
    if (r.types) r.types.forEach((t) => addRow(t, r));
    else for (const t of handlerTypes) if (t.includes(':') && t.split(':')[0] === r.ns) addRow(t, r);
  }
  for (const t of handlerTypes) {
    if (!t.includes(':') || t.startsWith('MULE:')) addRow(t.includes(':') ? t : `MULE:${t}`, { label: 'any step', stack: top });
  }
  rows.set(OTHER, { type: OTHER, raisedBy: new Set(), raises: [{ label: 'anything else', stack: top }] });

  const respond = responseOf(entry);
  return [...rows.values()].map((row) => {
    const outcomes = new Map();
    for (const raise of row.raises) {
      const o = outcome(row.type, raise.stack, respond, findFlow);
      const key = JSON.stringify([o.handlers.map((x) => x.where + x.label), o.end, o.status, o.inner]);
      if (!outcomes.has(key)) outcomes.set(key, o);
    }
    return { type: row.type, raisedBy: [...row.raisedBy], outcomes: [...outcomes.values()] };
  }).sort((a, b) => (a.type === OTHER) - (b.type === OTHER) || a.type.localeCompare(b.type));
}

/** What the listener answers with: the variable its (error) response's status reads, and its fallback. */
function responseOf(entry) {
  const listener = entry.kind === 'api' ? entry.via.source : entry.source;
  if (listener?.key !== 'http:listener') return null;
  const read = (local, fallback) => {
    const el = listener.node.children.find((c) => c.local === local);
    const expr = el?.attrs.statusCode || '';
    const literal = /^\s*(?:#\[\s*)?(\d{3})\s*\]?\s*$/.exec(expr);
    return {
      variable: /vars\.(\w+)/.exec(expr)?.[1] || null,
      fallback: literal ? literal[1] : /default\s+(\d{3})/.exec(expr)?.[1] || (expr ? null : fallback),
      expr,
    };
  };
  return { ok: read('response', '200'), error: read('error-response', '500') };
}

function outcome(type, stack, respond, findFlow) {
  const handlers = [];
  let end = 'unhandled';
  let inner = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    const g = stack[i];
    const hnd = g.handlers.find((x) => takes(x.errorType, type));
    if (!hnd) continue;
    const cont = hnd.key === 'core:on-error-continue';
    handlers.push({ label: `${cont ? 'On Error Continue' : 'On Error Propagate'}${hnd.errorType ? ` ${hnd.errorType}` : ''}${hnd.when ? ` when ${hnd.when}` : ''}`, where: g.where, kind: cont ? 'continue' : 'propagate', handler: hnd, project: g.project });
    if (cont) {
      end = 'continue';
      inner = !!g.inner;
      break;
    }
    end = 'propagate';
  }
  let status = null;
  if (respond && !(end === 'continue' && inner)) {
    const r = end === 'continue' ? respond.ok : respond.error;
    const set = r.variable ? lastSet(r.variable, handlers, findFlow) : null;
    status = set || (r.fallback ? { code: r.fallback, default: true } : { expr: r.expr });
    if (end === 'unhandled' && !r.variable && !r.fallback) status = { code: '500', default: true };
  }
  return { handlers, end, inner, status };
}

const DW_HEADER = /^[\s\S]*?^---\s*$/m;
const literalOf = (code) => /^\s*(?:#\[\s*)?(\d{3})\s*\]?\s*$/.exec((code || '').replace(DW_HEADER, ''))?.[1] || null;

/** The last value the executed handlers give vars.<name>: {code} when it is a number, else {setBy} the step. */
function lastSet(name, handlers, findFlow) {
  let found = null;
  const visit = (list, proj, depth) => {
    for (const p of list || []) {
      if (p.key === 'core:set-variable' && p.node.attrs.variableName === name) {
        const c = literalOf(p.node.attrs.value);
        found = c ? { code: c } : { setBy: p.label };
      }
      if (p.key === 'ee:transform') {
        for (const s of scriptsOf(p)) {
          if (s.label !== `vars.${name}`) continue;
          const c = literalOf(proj.scriptCode(s));
          found = c ? { code: c } : { setBy: p.label };
        }
      }
      p.routes?.forEach((r) => visit(r.processors, proj, depth));
      visit(p.body, proj, depth);
      if (p.kind === 'flow-ref' && !p.dynamic && depth < 6) {
        const before = found;
        const t = findFlow(p.target, proj);
        if (t) visit(t.flow.processors, t.project, depth + 1);
        // a value worked out inside a called flow: name the flow, which is what a reader can open
        if (found !== before && found?.setBy) found = { setBy: `${p.target}${t?.lib ? ` (${t.lib.artifactId})` : ''}` };
      }
    }
  };
  for (const hnd of handlers) visit(hnd.handler.body, hnd.project, 0);
  return found;
}
