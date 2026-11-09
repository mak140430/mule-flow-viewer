// Details panel in diff mode: what changed on the selected element (properties, scripts,
// property values it reads, XML), plus DataWeave and property files that changed.

import { h } from './dom.js';
import { renderDetails, renderDwlDetails, header, section, scriptSection, code, HIDDEN_ATTRS } from './details.js';
import { scriptsOf } from './model.js';
import { sourceOf } from './xml.js';
import { lineDiff, align } from './diff.js';
import { highlightDataWeave, highlightXml, modulePath } from './dataweave.js';
import { testSamples, runSample, eventInputs, modulesOf } from './chain.js';
import { propertiesOf, renderRunner } from './runner.js';

const STATUS = { added: 'Added', removed: 'Removed', changed: 'Changed', dependency: 'Imports a changed module' };
const CONTEXT = 3;

/** ctx: the details ctx plus {diff} from diffProjects; ctx.project is the newer version. */
export function renderDiffDetails(item, ctx) {
  const el = renderItemDiff(item, ctx);
  return ctx.diff.conflicts?.has(item.id) ? insertAfterHeader(el, conflictNote(ctx)) : el;
}

/** Merge preview: the other side changed this element too. */
function conflictNote(ctx) {
  return h('div.diff-status.conflict', h('b', 'Changed on both sides'),
    h('span', ` · ${ctx.otherSide?.name || 'the other branch'} changed it too since they split, so merging may conflict. `),
    ctx.otherSide ? h('a', { onclick: ctx.otherSide.open }, 'See their change') : null);
}

function renderItemDiff(item, ctx) {
  if (item.diff === 'removed') return withStatus(renderDetails(item.base, { ...ctx, project: ctx.diff.base }), 'removed');
  if (item.diff !== 'changed') return withStatus(renderDetails(item, ctx), item.diff);
  const a = item.base;
  const isFlow = ['flow', 'sub-flow', 'error-handler'].includes(item.kind) && item.name !== undefined;
  return h('div.details',
    header(ctx.icons.url(item.key), isFlow ? item.name : item.label, item.key, ctx),
    status('changed', item.reasons),
    attributeDiff(a.node, item.node),
    item.routes ? routeDiff(item) : null,
    propertyValues(item.reasons, ctx),
    isFlow ? null : scriptDiffs(a, item, ctx),
    isFlow ? null : outputDiff(a, item, ctx),
    xmlDiff(a, item, ctx));
}

export function renderDwlDiff(path, ctx) {
  const state = ctx.diff.dwl.get(path);
  if (!state) return renderDwlDetails(path, ctx);
  const before = ctx.diff.base.dwl.get(path)?.code ?? null;
  const after = ctx.diff.head.dwl.get(path)?.code ?? null;
  const project = state === 'removed' ? ctx.diff.base : ctx.diff.head;
  const el = renderDwlDetails(path, {
    ...ctx,
    project,
    scriptView: state === 'dependency' ? null : () => diffView(before, after, highlightDataWeave, 1, 1, path),
  });
  const changedImports = state === 'dependency'
    ? project.dwl.get(path).imports.map(modulePath).filter((p) => p && ctx.diff.dwl.has(p))
    : [];
  return insertAfterHeader(el, status(state, null,
    changedImports.map((p) => h('a.chip', { onclick: () => ctx.openDwl(p) }, p))));
}

export function renderPropertiesDiff(path, ctx) {
  const rows = [];
  for (const [key, changes] of ctx.diff.props) {
    for (const c of changes) if (c.file === path) rows.push({ key, ...c });
  }
  const users = [];
  for (const { item, flow } of ctx.diff.byId.values()) {
    const keys = rows.filter((r) => item.reasons?.includes(`property ${r.key}`)).map((r) => r.key);
    if (keys.length) users.push({ item, flow, keys });
  }
  const file = ctx.diff.files.find((f) => f.path === path);
  return h('div.details',
    header(propertiesIcon(), path.split('/').pop(), path, ctx),
    file && file.status !== 'changed' ? status(file.status) : null,
    rows.length ? section('Values', h('table.props', rows.map((r) => h('tr',
      h('th.mono', r.key),
      h('td', change(r.before, r.after)))))) : h('p.muted', 'No property values changed (comments or formatting only).'),
    users.length ? section('Used by', h('ul.links', users.map((u) => h('li',
      h('a', { onclick: () => (u.flow ? ctx.onNavigate(u.flow.name, u.item.id) : ctx.onSelect(u.item)) }, u.item.label || u.item.name),
      h('span.muted', ` ${u.flow ? `· ${u.flow.name} ` : ''}· ${u.keys.join(', ')}`))))) : null);
}

// ------------------------------------------------------------------ pieces

function status(state, reasons, extra) {
  if (!state || state === 'inner') return null;
  return h(`div.diff-status.${state}`,
    h('b', STATUS[state]),
    reasons?.length ? h('span', ` · ${reasons.join(', ')}`) : null,
    extra?.length ? h('div.deps', extra) : null);
}

function insertAfterHeader(el, node) {
  if (node) el.insertBefore(node, el.children[1] || null);
  return el;
}

const withStatus = (el, state) => insertAfterHeader(el, status(state));

function change(before, after) {
  return [
    before != null ? h('del.mono', before) : null,
    before != null && after != null ? h('span.muted', ' → ') : null,
    after != null ? h('ins.mono', after) : null,
  ];
}

function attributeDiff(a, b) {
  const keys = [...new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])]
    .filter((k) => !HIDDEN_ATTRS.test(k) || (k === 'doc:name' && a.attrs[k] !== b.attrs[k]));
  if (!keys.length) return null;
  return section('Properties', h('table.props', keys.map((k) => {
    const x = a.attrs[k];
    const y = b.attrs[k];
    return h(`tr${x !== y ? '.changed' : ''}`, h('th', k), h('td', x === y ? h('span.mono', y) : change(x ?? null, y ?? null)));
  })));
}

function routeDiff(p) {
  return section('Routes', h('table.props', p.routes.map((r) => h(`tr${r.diff === 'added' || r.diff === 'removed' || r.diff === 'changed' ? '.changed' : ''}`,
    h('th', r.label),
    h('td', r.diff === 'changed' ? change(r.base.expr, r.expr)
      : r.diff === 'added' ? change(null, r.expr ?? '—')
        : r.diff === 'removed' ? change(r.expr ?? '—', null)
          : r.expr ? h('span.mono', r.expr) : h('span.muted', '—'))))));
}

function propertyValues(reasons, ctx) {
  const keys = (reasons || []).filter((r) => r.startsWith('property ')).map((r) => r.slice(9));
  if (!keys.length) return null;
  return section('Property values', h('table.props', keys.flatMap((k) => ctx.diff.props.get(k).map((c, i) => h('tr',
    h('th.mono', i ? '' : k),
    h('td', h('div.muted', c.file.split('/').pop()), change(c.before, c.after)))))));
}

function scriptDiffs(a, b, ctx) {
  const sa = new Map(scriptsOf(a).map((s) => [s.label, s]));
  const sb = new Map(scriptsOf(b).map((s) => [s.label, s]));
  return [...new Set([...sa.keys(), ...sb.keys()])].map((label) => {
    const x = sa.get(label);
    const y = sb.get(label);
    const before = x ? ctx.diff.base.scriptCode(x) : null;
    const after = y ? ctx.diff.head.scriptCode(y) : null;
    const path = (y || x).resource?.replace(/^classpath:\/*/, '');
    const link = path ? h('p', h('a.mono', { onclick: () => ctx.openDwl(path) }, path)) : null;
    // the newer version can be run (and edited) here too, with inputs from its MUnit tests
    const own = ctx.diff.head.byId.get(b.id);
    const run = after != null && ctx.compareEngine
      ? renderRunner(after, `diff:${b.file}:${b.id}:${label}`, { ...ctx, project: ctx.diff.head, engine: ctx.compareEngine }, own ? [{ processor: own.item, flow: own.flow }] : [], { before })
      : null;
    if (x && y && x.resource === y.resource && before === after) {
      return h('details.details-section', h('summary', h('h3.script-label', label)), link, after == null ? null : code(after), run);
    }
    return scriptSection(label, link, diffView(before, after, highlightDataWeave, 1, 1, `${b.label || a.label} · ${path || label}`), run);
  });
}

/**
 * Behaviour diff: both versions of each changed script run on the same inputs, an MUnit test's event at
 * this element in the newer version, and their outputs are compared. Runs on the local DataWeave engine.
 */
function outputDiff(a, b, ctx) {
  if (!ctx.compareEngine || !b.reasons.some((r) => r.startsWith('script') || r.startsWith('property'))) return null;
  const sa = new Map(scriptsOf(a).map((s) => [s.label, s]));
  const scripts = scriptsOf(b).map((y) => ({ label: y.label, after: ctx.diff.head.scriptCode(y), before: sa.has(y.label) ? ctx.diff.base.scriptCode(sa.get(y.label)) : null }))
    .filter((s) => s.after != null && s.before != null);
  if (!scripts.length) return null;
  const { base, head } = ctx.diff;
  // the newer project's own element: b is the diff's merged copy of it
  const own = head.byId.get(b.id);
  const samples = own ? testSamples(head, [{ processor: own.item, flow: own.flow }]) : [];
  const body = h('div.output-diff');
  const el = h('details.details-section', h('summary', h('h3', 'Output')), body);
  if (!samples.length) {
    body.append(h('p.muted', 'No MUnit test reaches this element, so there are no inputs to run both versions with.'));
    return el;
  }
  const results = h('div');
  const pick = h('select.run-source', { onchange: () => compare(samples[pick.value]) },
    samples.map((s, i) => h('option', { value: i }, s.test.name)));
  body.append(h('div.run-head', h('span.muted', 'Inputs from '), pick), results);

  const run = async (code, project, inputs) => {
    const r = await ctx.compareEngine.run({ script: code, modules: modulesOf(code, project), properties: propertiesOf(project, ctx.env), inputs });
    return r.ok ? { text: r.output } : { error: r.error.split('\n')[0] };
  };
  async function compare(sample) {
    pick.disabled = true;
    results.replaceChildren(h('p.muted', 'Running the test…'));
    try {
      const event = await runSample(sample, { project: head, engine: ctx.compareEngine, properties: propertiesOf(head, ctx.env) });
      const inputs = eventInputs(event);
      const blocks = [];
      for (const s of scripts) {
        const [x, y] = await Promise.all([run(s.before, base, inputs), run(s.after, head, inputs)]);
        const title = scripts.length > 1 ? h('h3.script-label', s.label) : null;
        if (x.error || y.error) {
          blocks.push(h('div', title, ...[['Before', x], ['After', y]].map(([side, r]) => (r.error
            ? h('pre.run-error', `${side}: ${r.error}`)
            : [h('div.muted', side), h('pre.code', h('code', { html: highlightDataWeave(r.text) }))]))));
        } else {
          blocks.push(h('div', title, x.text === y.text ? h('p.muted', 'Same output.') : diffView(x.text, y.text, highlightDataWeave, 1, 1, `Output · ${sample.test.name}`)));
        }
      }
      results.replaceChildren(...[
        !event.exact || event.offRoute ? h('p.muted', event.offRoute ? 'This test takes another route, so the element does not run in it; these are the inputs it would get.' : 'Some steps before this element are not mocked in the test, so the inputs are approximate.') : null,
        ...blocks].filter(Boolean));
    } catch (e) {
      results.replaceChildren(h('pre.run-error', e.message));
    } finally {
      pick.disabled = false;
    }
  }
  el.addEventListener('toggle', () => { if (el.open && !results.children.length) compare(samples[0]); });
  return el;
}

function xmlDiff(a, b, ctx) {
  const ca = ctx.diff.base.configFor(a.file);
  const cb = ctx.diff.head.configFor(b.file);
  if (!ca || !cb) return null;
  const before = sourceOf(a.node, ca.source);
  const after = sourceOf(b.node, cb.source);
  return h(`details.details-section.source-view`, { open: before !== after },
    h('summary', h('h3', `XML · line ${b.node.line}`)),
    diffView(before, after, highlightXml, a.node.line, b.node.line, `${b.label || b.name || b.key} · XML`));
}

const TOKEN = /\s+|[\w$.-]+|[^\w\s]/g;
const WORD_LIMIT = 400;

/**
 * Words that differ between a removed line and the added line that replaced it, as [from, to) character ranges
 * on each side. Lines that share too little are a rewrite, not an edit: no word marks.
 */
function wordChanges(a, b) {
  if (a.length > WORD_LIMIT || b.length > WORD_LIMIT) return null;
  const ta = a.match(TOKEN) || [];
  const tb = b.match(TOKEN) || [];
  const pairs = align(ta, tb, (x, y) => x === y);
  const ra = [];
  const rb = [];
  let ia = 0;
  let ib = 0;
  let same = 0;
  for (const [x, y] of pairs) {
    if (x != null && y != null) { same += x.trim() ? x.length : 0; ia += x.length; ib += y.length; continue; }
    if (x != null) { ra.push([ia, ia + x.length]); ia += x.length; }
    if (y != null) { rb.push([ib, ib + y.length]); ib += y.length; }
  }
  return same * 2 >= a.trim().length ? [ra, rb] : null;
}

/** Highlighted line with the changed ranges wrapped in <mark>. */
function marked(text, ranges, highlight) {
  if (!ranges?.length) return highlight(text);
  let out = '';
  let at = 0;
  for (const [from, to] of ranges) {
    out += highlight(text.slice(at, from)) + `<mark>${highlight(text.slice(from, to))}</mark>`;
    at = to;
  }
  return out + highlight(text.slice(at));
}

/** Line diff rows with the changed words of each edited line (a removed line and the added line after it). */
function diffRows(before, after) {
  const rows = lineDiff(before, after);
  for (let i = 0; i < rows.length;) {
    if (rows[i].op !== '-') { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].op === '-') j++;
    let k = j;
    while (k < rows.length && rows[k].op === '+') k++;
    for (let n = 0; n < Math.min(j - i, k - j); n++) {
      const w = wordChanges(rows[i + n].text, rows[j + n].text);
      if (w) [rows[i + n].words, rows[j + n].words] = w;
    }
    i = k;
  }
  return rows;
}

/** Side by side: a removed run and the added run after it share rows; the shorter side gets empty rows. */
function splitPairs(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].op === ' ') { out.push([rows[i], rows[i]]); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].op === '-') j++;
    let k = j;
    while (k < rows.length && rows[k].op === '+') k++;
    for (let n = 0; n < Math.max(j - i, k - j); n++) out.push([i + n < j ? rows[i + n] : null, j + n < k ? rows[j + n] : null]);
    i = k;
  }
  return out;
}

/** items with unchanged stretches longer than 2 lines (beyond CONTEXT around changes) folded into a pill. */
function folded(items, changed, render, pill = (n) => `${n} unchanged lines`) {
  const near = new Uint8Array(items.length);
  items.forEach((it, i) => {
    if (!changed(it)) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(items.length - 1, i + CONTEXT); k++) near[k] = 1;
  });
  const out = [];
  for (let i = 0; i < items.length;) {
    if (near[i]) { out.push(render(items[i++])); continue; }
    let j = i;
    while (j < items.length && !near[j]) j++;
    const hidden = items.slice(i, j);
    if (hidden.length <= 2) out.push(...hidden.map(render));
    else {
      const fold = h('div.dl-fold', { onclick: () => fold.replaceWith(...hidden.map(render)) }, h('span', pill(hidden.length)));
      out.push(fold);
    }
    i = j;
  }
  return out;
}

function unifiedLines(rows, highlight, startA, startB) {
  return folded(rows, (r) => r.op !== ' ', (r) => h(`div.dl${r.op === '+' ? '.add' : r.op === '-' ? '.del' : ''}`,
    h('span.ln', r.b ? r.b + startB - 1 : r.a + startA - 1),
    h('code', { html: marked(r.text, r.words, highlight) || ' ' })));
}

function splitLines(rows, highlight, startA, startB) {
  const side = (r, op, n) => (r
    ? [h(`span.ln${r.op === op ? `.${op === '-' ? 'del' : 'add'}` : ''}`, n), h(`code${r.op === op ? `.${op === '-' ? 'del' : 'add'}` : ''}`, { html: marked(r.text, r.op === op ? r.words : null, highlight) || ' ' })]
    : [h('span.ln.none'), h('code.none')]);
  return folded(splitPairs(rows), ([x, y]) => x !== y, ([x, y]) => h('div.sl',
    ...side(x, '-', x && x.a + startA - 1), ...side(y, '+', y && y.b + startB - 1)));
}

const MODES = { split: 'Split', unified: 'Unified' };

/** Full-window diff (Cursor style): split or unified, n / p to step through changes, Esc to close. */
function openDiffModal({ title, rows, highlight, startA, startB }) {
  let mode = (() => { try { return localStorage.getItem('mfv.diffMode'); } catch { return null; } })() || 'split';
  const added = rows.filter((r) => r.op === '+').length;
  const removed = rows.filter((r) => r.op === '-').length;
  const body = h('div.diff-modal-body.mono');
  const seg = h('div.seg');
  let at = -1;
  const step = (d) => {
    const hunks = [...body.querySelectorAll('.dl.add, .dl.del, .sl:has(.add, .del)')]
      .filter((el) => !el.previousElementSibling?.matches('.dl.add, .dl.del, .sl:has(.add, .del)'));
    if (!hunks.length) return;
    at = (at + d + hunks.length) % hunks.length;
    hunks[at].scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const render = () => {
    seg.replaceChildren(...Object.entries(MODES).map(([m, label]) => h(`button${m === mode ? '.active' : ''}`, {
      onclick: () => { mode = m; try { localStorage.setItem('mfv.diffMode', m); } catch { /* unavailable */ } render(); },
    }, label)));
    body.classList.toggle('split', mode === 'split');
    body.replaceChildren(...(mode === 'split' ? splitLines : unifiedLines)(rows, highlight, startA, startB));
    at = -1;
  };
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', keys, true); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'n' || e.key === 'j') step(1);
    else if (e.key === 'p' || e.key === 'k') step(-1);
  };
  const backdrop = h('div.diff-modal-backdrop', { onmousedown: (e) => { if (e.target === backdrop) close(); } },
    h('div.diff-modal',
      h('div.diff-modal-head',
        h('span.diff-modal-title', title),
        h('span.diff-stat', h('span.add', `+${added}`), h('span.del', `−${removed}`)),
        h('span.spacer'),
        h('button.icon-btn', { title: 'Previous change (p)', onclick: () => step(-1) }, '↑'),
        h('button.icon-btn', { title: 'Next change (n)', onclick: () => step(1) }, '↓'),
        seg,
        h('button.close', { title: 'Close (Esc)', onclick: close }, '×')),
      body));
  render();
  document.body.append(backdrop);
  document.addEventListener('keydown', keys, true);
}

/**
 * Unified line diff: tinted lines with the changed words marked, one line-number column (the new side, or the old
 * for removed lines); long unchanged stretches fold away. ⤢ opens it full-window, side by side.
 */
export function diffView(before, after, highlight, startA = 1, startB = 1, title = 'Changes') {
  const rows = diffRows(before, after);
  return h('div.diff-wrap',
    h('button.diff-expand', { title: 'Open side by side', onclick: () => openDiffModal({ title, rows, highlight, startA, startB }) }, '⤢'),
    h('div.diff-code', unifiedLines(rows, highlight, startA, startB)));
}

function propertiesIcon() {
  return `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#7A8194"/><text x="24" y="24" dy=".35em" text-anchor="middle" font-family="system-ui" font-weight="700" font-size="14" fill="#fff">YML</text></svg>')}`;
}
