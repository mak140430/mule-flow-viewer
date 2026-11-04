// The views for lint.js (Checks, and their marks on the canvas), trace.js (Trace) and "used by" (which apps call a
// library's flows), drawn from what those modules found.

import { h } from './dom.js';
import { SEVERITIES } from './lint.js';
import { traceSteps } from './trace.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_LABEL = { error: 'Errors', warning: 'Warnings', info: 'Worth a look' };

/**
 * The Checks list. ctx: {open(check)} opens a check's element or file line.
 */
export function renderChecksView(list, ctx) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, list.filter((c) => c.severity === s).length]));
  return h('div.search-view.checks-view',
    h('div.search-head', h('h2', 'Checks'),
      h('span.muted', list.length ? SEVERITIES.filter((s) => counts[s]).map((s) => (s === 'info' ? `${counts[s]} worth a look` : plural(counts[s], s))).join(' · ') : 'Nothing to report')),
    SEVERITIES.filter((s) => counts[s]).map((s) => h('section.search-file',
      h('div.search-file-head', h(`span.check-dot.${s}`), h('span', SEVERITY_LABEL[s])),
      list.filter((c) => c.severity === s).map((c) => h('div.search-hit.check-row', { onclick: () => ctx.open(c) },
        h('span.check-text', c.message),
        h('span.muted.mono.check-where', `${c.flow ? `${c.flow} · ` : ''}${c.file}${c.line ? `:${c.line}` : ''}`))))));
}

/** Errors and warnings marked on the canvas's elements (the rest only in the list). */
export function markChecks(main, list) {
  main.querySelectorAll('.check-error, .check-warning').forEach((el) => el.classList.remove('check-error', 'check-warning'));
  for (const c of list) {
    if (!c.id || c.severity === 'info') continue;
    const el = main.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    if (!el) continue;
    if (!el.classList.contains('check-error')) el.classList.add(`check-${c.severity}`);
    el.title = `${el.title ? `${el.title}\n` : ''}${c.message}`;
  }
}

/** The count shown on the Checks button: what needs attention (errors and warnings). */
export const attention = (list) => list.filter((c) => c.severity !== 'info').length;

// ------------------------------------------------------------------ trace

/**
 * A traced flow: its variables (who sets and reads each), then its steps, nested as they run.
 * ctx: {icons, open(step) for a step of this project, own(step): whether it is}
 */
export function renderTraceView(t, ctx) {
  const steps = traceSteps(t);
  const unset = new Set(steps.flatMap((s) => s.unset));
  // the same step in several flows (each resource flow's "Prepare error") once, with how many
  const stepLinks = (list) => {
    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.label)) groups.set(s.label, []);
      groups.get(s.label).push(s);
    }
    return join([...groups].map(([label, all]) => h('a', { onclick: () => ctx.open(all[0]), title: [...new Set(all.map((x) => x.flow?.name).filter(Boolean))].join('\n') },
      label, all.length > 1 ? h('span.muted', ` ×${all.length}`) : null)));
  };
  const vars = [...t.vars].sort(([a], [b]) => a.localeCompare(b));
  return h('div.search-view.trace-view',
    h('div.search-head', h('h2', t.root.flow.name),
      h('span.muted', `${plural(steps.length, 'step')}${t.entry ? '' : ' · called by other flows, so the variables they set are not known here'}`)),
    vars.length ? h('section.search-file',
      h('div.search-file-head', h('span', 'Variables')),
      h('table.trace-vars',
        h('thead', h('tr', h('th', ''), h('th', 'Set by'), h('th', 'Read by'))),
        h('tbody', vars.map(([name, v]) => h(unset.has(name) ? 'tr.unset' : 'tr',
          h('td.mono', `vars.${name}`, unset.has(name) ? h('span.check-dot.warning', { title: 'Read before anything on the way there sets it' }) : null),
          h('td', v.sets.length ? stepLinks(v.sets) : h('span.muted', t.entry ? 'nothing on this path' : 'not here')),
          h('td', v.reads.length ? stepLinks(v.reads) : h('span.muted', 'nothing'))))))) : null,
    h('section.search-file', h('div.search-file-head', h('span', 'Steps')), h('ol.trace-steps', t.root.steps.map((s) => stepRow(s, ctx, 0)))));
}

const join = (els) => els.flatMap((el, i) => (i ? [', ', el] : [el]));

function stepRow(s, ctx, depth) {
  const own = ctx.own(s);
  const chips = [
    ...s.sets.map((v) => h('span.chip.sets', { title: 'Sets this variable' }, `sets ${v}`)),
    ...s.reads.map((v) => h(`span.chip.reads${s.unset.includes(v) ? '.unset' : ''}`, {
      title: s.unset.includes(v) ? 'Nothing on the way here sets it' : 'Reads this variable',
    }, `${s.unset.includes(v) ? '⚠ ' : ''}reads ${v}`)),
  ];
  const row = h(`div.trace-step${own && s.item ? '.link' : ''}`, own && s.item ? { onclick: () => ctx.open(s) } : {},
    s.key ? h('img', { src: ctx.icons.url(s.key), alt: '' }) : null,
    h('span.trace-label', s.label),
    chips,
    s.note ? h('span.muted', ` ${s.note}`) : null);
  const children = s.children.map((c) => {
    const head = c.call ? `→ ${c.call}${c.lib ? ` (${c.lib.artifactId} ${c.lib.version})` : ''}` : null;
    const list = h('ol.trace-steps', c.steps.map((x) => stepRow(x, ctx, depth + 1)));
    const title = [c.branch, head].filter(Boolean).join('  ');
    if (!title) return list;
    // calls into other flows open folded beyond the first levels
    return h('details.trace-branch', { open: depth < 1 || !c.call }, h(`summary${c.error ? '.error' : ''}`, title), list);
  });
  return h('li', row, children);
}

// ------------------------------------------------------------------ used by

/**
 * "Used by": the apps of the same owner calling a library's flow. usage: Promise of usedBy()'s answer.
 */
export function usedBySection(usage, flowName, artifactId) {
  const body = h('div', h('p.muted', `Looking through the other repositories for ${artifactId}…`));
  usage.then((apps) => {
    const calling = apps.filter((a) => a.calls.has(flowName));
    const others = apps.filter((a) => !a.calls.has(flowName));
    body.replaceChildren(...[
      calling.length ? h('ul.links', calling.map((a) => h('li',
        h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.name),
        h('span.muted', ` ${a.version}${a.branch ? ` on ${a.branch}` : ''} · from ${[...new Set(a.calls.get(flowName).map((c) => c.caller))].join(', ')}`)))) : h('p.muted', 'No other app calls it.'),
      others.length ? h('p.muted', `${plural(others.length, 'other app')} use ${artifactId} without calling it: ${others.map((a) => `${a.name} ${a.version}`).join(', ')}.`) : null,
    ].filter(Boolean));
  }, (e) => body.replaceChildren(h('p.muted', `Could not look: ${e.message}`)));
  return h('section.details-section', h('h3', 'Used by'), body);
}

// ------------------------------------------------------------------ impact of a change

const SIGN = { added: '+', removed: '−', changed: '~' };
const changeChip = (c, open) => h(`a.chip.d-${c.diff}`, { onclick: () => open(c), title: [c.whole ? `${c.diff} flow` : c.flow, c.via].filter(Boolean).join(' · ') },
  `${SIGN[c.diff] || '~'} ${c.label}`);
const once = (changes) => [...new Map(changes.map((c) => [`${c.id}|${c.label}`, c])).values()];

/**
 * What a comparison affects (impact.js). ctx: {open(change), openProperty(p)}.
 */
export function renderImpactView(r, ctx) {
  const rows = r.entries.map(({ entry, changes }) => h('div.search-hit.impact-row',
    h('div', h('div.mono', entry.label),
      h('div.muted.impact-flow', entry.routes?.length ? `every request: ${plural(entry.routes.length, 'API resource')}` : entry.flow.name)),
    h('div.impact-changes', once(changes).map((c) => changeChip(c, ctx.open)))));
  const reached = r.entries.length;
  return h('div.search-view.impact-view',
    h('div.search-head', h('h2', 'Impact'),
      h('span.muted', reached ? `Reached from ${plural(reached, 'entry point')}` : 'Nothing it changes is reached from an entry point')),
    reached ? h('section.search-file', h('div.search-file-head', 'Reached from'), rows) : null,
    r.unreached.length ? h('section.search-file', h('div.search-file-head', 'Not reached from any entry point'),
      h('div.search-hit.impact-row.single', h('div.impact-changes', once(r.unreached).map((c) => changeChip(c, ctx.open))))) : null,
    r.properties.length ? h('section.search-file', h('div.search-file-head', 'Properties'),
      r.properties.map((p) => h(`div.search-hit.impact-row${p.file ? '.link' : ''}`, { onclick: p.file ? () => ctx.openProperty(p) : null },
        h('div.mono', p.key),
        h('div', h('span.muted', `${p.status} `), p.missing.length ? [h('span.check-dot.warning'), `missing in ${p.missing.join(', ')}`] : null)))) : null,
    r.dependencies.length ? h('section.search-file', h('div.search-file-head', 'Dependencies'),
      r.dependencies.map((x) => h('div.search-hit.impact-row',
        h('div.mono', x.artifactId), h('div', x.from && x.to ? `${x.from} → ${x.to}` : x.to ? `added ${x.to}` : `removed (was ${x.from})`)))) : null,
    r.configurations.length ? h('section.search-file', h('div.search-file-head', 'Configurations'),
      r.configurations.map((c) => h('div.search-hit.impact-row.link', { onclick: () => ctx.open(c) },
        h('div', c.label), h('div.muted', c.diff)))) : null);
}
