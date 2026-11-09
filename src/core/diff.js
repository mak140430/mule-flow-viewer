// Visual diff between two versions of a project, in the shape the canvas draws.
// Flows match by name; processors by doc:id (Studio keeps it stable across edits),
// else by type + name in order. A processor also counts as changed when a DataWeave
// file or a property value it uses changed, so script- or config-only commits still
// show where they land in the flows.

import { scriptsOf, walkFlow } from './model.js';
import { placeholderKeys } from './properties.js';
import { dwPropertyRefs } from './dataweave.js';

const RES_DIR = 'src/main/resources/';

/**
 * Items of the merged model carry `diff`: 'added' | 'removed' | 'changed' | 'inner'
 * (only something inside changed) | null, plus `base` (the old version) and
 * `reasons` for 'changed'. Removed items come from the base project, with ids prefixed `was:`.
 */
export function diffProjects(base, head) {
  const files = [];
  for (const path of new Set([...base.texts.keys(), ...head.texts.keys()])) {
    const a = base.texts.get(path);
    const b = head.texts.get(path);
    if (a !== b) files.push({ path, status: a == null ? 'added' : b == null ? 'removed' : 'changed' });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  const cx = { base, head, dwl: changedDwl(base, head), props: changedProps(base, head) };
  const configs = new Map();
  const byId = new Map();
  const paths = [...new Set([...base.configs, ...head.configs].map((c) => c.path))].sort();
  for (const path of paths) {
    const d = diffConfig(base.configFor(path), head.configFor(path), cx);
    d.textChanged = files.some((f) => f.path === path);
    configs.set(path, d);
    for (const flow of d.flows) {
      byId.set(flow.id, { item: flow, flow });
      walkFlow(flow, (p) => byId.set(p.id, { item: p, flow }));
    }
    for (const g of d.globals) byId.set(g.id, { item: g, flow: null });
  }
  return { base, head, files, configs, byId, dwl: cx.dwl, props: cx.props };
}

// ------------------------------------------------------------------ what changed outside the XML

/** resources-relative .dwl path -> 'added' | 'removed' | 'changed' | 'dependency' (imports a changed module) */
function changedDwl(base, head) {
  const out = new Map();
  for (const path of new Set([...base.dwl.keys(), ...head.dwl.keys()])) {
    const a = base.dwl.get(path)?.code;
    const b = head.dwl.get(path)?.code;
    if (a !== b) out.set(path, a == null ? 'added' : b == null ? 'removed' : 'changed');
  }
  const queue = [...out.keys()];
  while (queue.length) {
    const path = queue.shift();
    for (const p of [...(head.dwlImporters.get(path) || []), ...(base.dwlImporters.get(path) || [])]) {
      if (!out.has(p)) { out.set(p, 'dependency'); queue.push(p); }
    }
  }
  return out;
}

/** property key -> [{file, before, after}] for every file where its value differs */
function changedProps(base, head) {
  const out = new Map();
  const files = new Map();
  for (const pf of base.propertyFiles) files.set(pf.path, [pf.values, {}]);
  for (const pf of head.propertyFiles) files.set(pf.path, [files.get(pf.path)?.[0] || {}, pf.values]);
  for (const [file, [a, b]] of files) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const before = a[key]?.value ?? null;
      const after = b[key]?.value ?? null;
      if (before !== after) {
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({ file, before, after });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ alignment

/**
 * Longest common subsequence of `a` and `b` under `same`, as [a|null, b|null] pairs in order.
 * Leftover removals and additions next to each other are paired when `similar` (an edit, not a swap).
 */
export function align(a, b, same, similar = () => false) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = same(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) out.push([a[i++], b[j++]]);
    else if (L[i + 1][j] >= L[i][j + 1]) out.push([a[i++], null]);
    else out.push([null, b[j++]]);
  }
  while (i < n) out.push([a[i++], null]);
  while (j < m) out.push([null, b[j++]]);
  return pairRuns(out, similar);
}

function pairRuns(pairs, similar) {
  const out = [];
  for (let k = 0; k < pairs.length;) {
    if (pairs[k][0] && pairs[k][1]) { out.push(pairs[k++]); continue; }
    const run = [];
    while (k < pairs.length && !(pairs[k][0] && pairs[k][1])) run.push(pairs[k++]);
    const removed = run.filter((p) => p[0]).map((p) => p[0]);
    const partner = new Map();
    for (const [, add] of run.filter((p) => p[1])) {
      const r = removed.find((x) => !partner.has(x) && similar(x, add));
      if (r) partner.set(r, add);
    }
    const paired = new Set(partner.values());
    for (const [rem, add] of run) {
      if (rem && !partner.has(rem)) out.push([rem, null]);
      if (add) out.push(paired.has(add) ? [[...partner].find(([, x]) => x === add)[0], add] : [null, add]);
    }
  }
  return out;
}

/** Order in a file does not matter for flows: a flow that moved is the same flow. */
function byName(pairs) {
  const name = (f) => f.name ?? f.id;
  const added = new Map(pairs.filter(([x, y]) => !x && y).map(([, y]) => [name(y), y]));
  const moved = new Map();
  for (const [x, y] of pairs) if (x && !y && added.has(name(x))) moved.set(added.get(name(x)), x);
  return pairs
    .filter(([x, y]) => !(x && !y && moved.has(added.get(name(x)))))
    .map(([x, y]) => (!x && moved.has(y) ? [moved.get(y), y] : [x, y]));
}

const docId = (p) => p.node?.attrs['doc:id'];
const signature = (p) => `${p.key}|${p.label}|${p.target ?? ''}`;

function sameProcessor(a, b) {
  const idsA = new Set(a.map(docId).filter(Boolean));
  const idsB = new Set(b.map(docId).filter(Boolean));
  return (x, y) => {
    const ix = docId(x);
    const iy = docId(y);
    if (ix && ix === iy) return true;
    if ((ix && idsB.has(ix)) || (iy && idsA.has(iy))) return false;
    return signature(x) === signature(y);
  };
}

// ------------------------------------------------------------------ merged model

function diffConfig(a, b, cx) {
  const flows = byName(align(a?.flows || [], b?.flows || [], (x, y) => (x.name ?? x.id) === (y.name ?? y.id)))
    .map(([x, y]) => mergeFlow(x, y, cx));
  const globalKey = (g) => g.name || `${g.key}|${g.label}`;
  const globals = align(a?.globals || [], b?.globals || [], (x, y) => globalKey(x) === globalKey(y))
    .map(([x, y]) => {
      if (!x) return retag(y, 'added');
      if (!y) return retag(x, 'removed');
      const reasons = ownReasons(x, y, cx, true);
      return { ...y, base: x, diff: reasons.length ? 'changed' : null, reasons };
    });
  const changed = flows.some((f) => f.diff) || globals.some((g) => g.diff);
  return {
    path: (b || a).path,
    status: !a ? 'added' : !b ? 'removed' : changed ? 'changed' : null,
    base: a,
    head: b,
    flows,
    globals,
  };
}

function mergeFlow(a, b, cx) {
  if (!a) return retag(b, 'added');
  if (!b) return retag(a, 'removed');
  const m = { ...b, base: a };
  if (b.kind === 'error-handler') {
    m.handlers = mergeList(a.handlers || [], b.handlers || [], cx);
  } else {
    m.source = mergeOne(a.source, b.source, cx);
    m.processors = mergeList(a.processors, b.processors, cx);
    m.errorHandler = mergeErrorHandler(a.errorHandler, b.errorHandler, cx);
  }
  m.reasons = attrsDiffer(a.node, b.node) ? ['properties'] : [];
  m.diff = m.reasons.length ? 'changed' : anyChange(m) ? 'inner' : null;
  m.counts = countChanges(m);
  return m;
}

function mergeList(a = [], b = [], cx) {
  return align(a, b, sameProcessor(a, b), (x, y) => x.key === y.key).map(([x, y]) => mergeOne(x, y, cx));
}

function mergeOne(a, b, cx) {
  if (!a && !b) return null;
  if (!a) return retag(b, 'added');
  if (!b) return retag(a, 'removed');
  const m = { ...b, base: a };
  const container = b.kind === 'router' || b.kind === 'scope';
  if (b.routes) {
    m.routes = align(a.routes || [], b.routes,
      (x, y) => x.label === y.label && x.expr === y.expr, (x, y) => x.label === y.label)
      .map(([x, y]) => {
        if (!x) return retag(y, 'added');
        if (!y) return retag(x, 'removed');
        const r = { ...y, base: x, processors: mergeList(x.processors, y.processors, cx) };
        r.diff = x.expr !== y.expr ? 'changed' : r.processors.some((p) => p?.diff) ? 'inner' : null;
        return r;
      });
  }
  if (b.body) m.body = mergeList(a.body, b.body, cx);
  if (a.errorHandler || b.errorHandler) m.errorHandler = mergeErrorHandler(a.errorHandler, b.errorHandler, cx);
  m.reasons = ownReasons(a, b, cx, !container);
  m.diff = m.reasons.length ? 'changed' : anyChange(m) ? 'inner' : null;
  return m;
}

function mergeErrorHandler(a, b, cx) {
  if (!a && !b) return null;
  if (!a) return retag(b, 'added');
  if (!b) return retag(a, 'removed');
  const m = { ...b, base: a, handlers: mergeList(a.handlers, b.handlers, cx) };
  m.reasons = a.ref !== b.ref ? ['reference'] : [];
  m.diff = m.reasons.length ? 'changed' : anyChange(m) ? 'inner' : null;
  return m;
}

function anyChange(m) {
  const has = (list) => list?.some((p) => p?.diff);
  return has(m.processors) || has(m.body) || has(m.handlers) || has(m.routes) ||
    !!m.source?.diff || !!m.errorHandler?.diff;
}

/** Same element in a new status, deep: what an added scope contains is added too. */
function retag(x, status) {
  if (!x) return x;
  const c = { ...x, diff: status };
  if (status === 'removed') {
    c.id = `was:${x.id}`;
    c.base = x;
  }
  for (const k of ['processors', 'body', 'handlers']) if (x[k]) c[k] = x[k].map((p) => retag(p, status));
  if (x.routes) c.routes = x.routes.map((r) => retag(r, status));
  if (x.source) c.source = retag(x.source, status);
  if (x.errorHandler) c.errorHandler = retag(x.errorHandler, status);
  if (x.kind === 'flow' || x.kind === 'sub-flow' || x.kind === 'error-handler') c.counts = { [status]: 1 };
  return c;
}

function countChanges(flow) {
  const counts = { added: 0, removed: 0, changed: 0 };
  walkFlow(flow, (p) => { if (counts[p.diff] !== undefined) counts[p.diff]++; });
  const routes = [];
  walkFlow(flow, (p) => p.routes && routes.push(...p.routes));
  for (const r of routes) if (r.diff === 'changed') counts.changed++;
  if (flow.diff === 'changed') counts.changed++;
  return counts;
}

// ------------------------------------------------------------------ what counts as a change

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function attrsDiffer(a, b) {
  const own = (n) => Object.entries(n.attrs).filter(([k]) => k !== 'doc:id' && !k.startsWith('xmlns')).sort().join('\n');
  return own(a) !== own(b);
}

function canon(node) {
  const attrs = Object.entries(node.attrs).filter(([k]) => k !== 'doc:id' && !k.startsWith('xmlns')).sort().join(' ');
  return `<${node.ns}|${node.local} ${attrs}>${norm(node.text)}${node.children.map(canon).join('')}</>`;
}

/** Identity of a byId entry across diffs: doc:id, else flows and globals by name. */
export function elementIdent({ item, flow }) {
  return item.node?.attrs?.['doc:id']
    || (item === flow ? `flow:${item.name}` : !flow ? `global:${item.name ?? item.label}` : `id:${item.id.replace(/^was:/, '')}`);
}

export const isChange = (item) => item.diff === 'added' || item.diff === 'removed' || item.diff === 'changed';

/** Whether two versions of an element end up the same: XML (ignoring layout and doc:id) and the scripts they run. */
export function sameElement(a, projectA, b, projectB) {
  if (!a || !b) return !a && !b;
  if (canon(a.node) !== canon(b.node)) return false;
  const code = (p, project) => scriptsOf(p).map((s) => norm(project.scriptCode(s) ?? '')).join('\n');
  return code(a, projectA) === code(b, projectB);
}

function subtreeAttrs(node, deep) {
  const out = Object.values(node.attrs);
  if (deep) for (const c of node.children) out.push(...subtreeAttrs(c, true));
  return out;
}

/** Why a matched element counts as changed: its own XML, or a script or property it uses. */
function ownReasons(a, b, cx, deep) {
  const reasons = [];
  if (attrsDiffer(a.node, b.node)) reasons.push('properties');

  const sa = new Map(scriptsOf(a).map((s) => [s.label, s]));
  const sb = new Map(scriptsOf(b).map((s) => [s.label, s]));
  let scriptReason = false;
  for (const label of new Set([...sa.keys(), ...sb.keys()])) {
    const x = sa.get(label);
    const y = sb.get(label);
    const path = (y || x).resource?.replace(/^classpath:\/*/, '');
    const textA = x && cx.base.scriptCode(x);
    const textB = y && cx.head.scriptCode(y);
    if (!x || !y || x.resource !== y.resource || norm(textA ?? '') !== norm(textB ?? '')) {
      reasons.push(`script ${label}`);
      scriptReason = true;
    } else if (path && cx.dwl.get(path) === 'dependency') {
      reasons.push(`script ${label} imports a changed module`);
    }
  }
  if (deep && !scriptReason && !reasons.length && canon(a.node) !== canon(b.node)) reasons.push('configuration');

  const keys = new Set(subtreeAttrs(b.node, deep).flatMap(placeholderKeys));
  for (const s of sb.values()) for (const k of dwPropertyRefs(cx.head.scriptCode(s) || '')) keys.add(k);
  for (const k of keys) if (cx.props.has(k)) reasons.push(`property ${k}`);
  return reasons;
}

// ------------------------------------------------------------------ text

/**
 * Line diff: [{op: ' ' | '-' | '+', text, a?, b?}] with 1-based line numbers on each side.
 * Common prefix and suffix are trimmed before the quadratic part.
 */
export function lineDiff(before, after) {
  const a = before == null ? [] : before.split('\n');
  const b = after == null ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const pairs = midA.length * midB.length > 4e6
    ? [...midA.map((x) => [x, null]), ...midB.map((y) => [null, y])]
    : align(midA, midB, (x, y) => x === y);

  const out = [];
  let ia = 0;
  let ib = 0;
  const keep = (text) => out.push({ op: ' ', text, a: ++ia, b: ++ib });
  a.slice(0, start).forEach(keep);
  for (const [x, y] of pairs) {
    if (x != null && y != null) keep(y);
    else if (x != null) out.push({ op: '-', text: x, a: ++ia });
    else out.push({ op: '+', text: y, b: ++ib });
  }
  a.slice(endA).forEach(keep);
  return out;
}

export const resourcePath = (path) => (path.startsWith(RES_DIR) ? path.slice(RES_DIR.length) : null);

/**
 * Two branches compared tip to tip: which side made each difference since they split (mergeBase: the project where
 * they did). headSide = diffProjects(mergeBase, head), baseSide = diffProjects(mergeBase, base).
 * {items: id -> 'head' | 'base' | 'both', files: path -> the same} for the differences of d.
 */
export function sidesOf(d, headSide, baseSide) {
  const changed = (x) => new Set([...x.byId.values()].filter((e) => isChange(e.item)).map(elementIdent));
  const h = changed(headSide);
  const b = changed(baseSide);
  const side = (onHead, onBase) => (onHead && onBase ? 'both' : onHead ? 'head' : onBase ? 'base' : null);
  const items = new Map();
  for (const e of d.byId.values()) {
    if (!isChange(e.item)) continue;
    const k = elementIdent(e);
    const s = side(h.has(k), b.has(k));
    if (s) items.set(e.item.id, s);
  }
  const hf = new Set(headSide.files.map((f) => f.path));
  const bf = new Set(baseSide.files.map((f) => f.path));
  const files = new Map(d.files.map((f) => [f.path, side(hf.has(f.path), bf.has(f.path))]).filter(([, s]) => s));
  return { items, files };
}

/** "Deleted on feature/x", "Added on main after feature/x branched off", ...: a difference of a branch comparison, by who made it. */
export function sideText(state, side, { head, base }) {
  if (side === 'both') return 'Both branches changed it since they split';
  if (state === 'removed') return side === 'head' ? `Deleted on ${head}` : `Added on ${base} after ${head} branched off`;
  if (state === 'added') return side === 'head' ? `Added on ${head}` : `Deleted on ${base} after ${head} branched off`;
  return side === 'head' ? `Changed on ${head}` : `Changed on ${base} after ${head} branched off`;
}
