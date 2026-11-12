// The Overview page: what starts the app and which errors each entry point answers with (surface.js), what it
// calls, its properties across environments (env-matrix.js), and the versions of the owner's shared libraries
// its apps use.

import { h } from './dom.js';
import { entryPoints, outboundCalls, errorsOf, OTHER } from './surface.js';
import { envMatrix } from './env-matrix.js';
import { compareVersions } from '../adapters/git-host.js';
import { pickBranch } from './branch-picker.js';
import { propertyValue } from './details.js';

export const TABS = [['endpoints', 'Entry points'], ['calls', 'Calls'], ['properties', 'Properties'], ['libraries', 'Libraries'], ['commits', 'Commits']];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * ctx: {project, env, libraryFlows, libraryTexts, libraryMap (() => Promise) | null, artifactId, tab, onTab(tab),
 * openFlow(name), openItem(item, flow), openSource(file, line),
 * commits: {branches: () => Promise<{current, default, branches}>, on(branch) -> Promise<{commits, capped}>} | null}
 */
export function renderOverview(ctx) {
  const tabs = TABS.filter(([id]) => (id !== 'libraries' || ctx.libraryMap) && (id !== 'commits' || ctx.commits));
  const tab = tabs.some(([id]) => id === ctx.tab) ? ctx.tab : 'endpoints';
  const body = { endpoints: endpointsTab, calls: callsTab, properties: propertiesTab, libraries: librariesTab, commits: commitsTab }[tab](ctx);
  return h('div.search-view.overview',
    h('div.search-head', h('div.seg.overview-tabs', tabs.map(([id, label]) => h(`button${id === tab ? '.active' : ''}`, { onclick: () => ctx.onTab(id) }, label))),
      body.summary ? h('span.muted', body.summary) : null),
    body.el);
}

/** `${key}` in a setting, with the value it has in the environment shown (secure ones stay as they are). */
function resolved(text, ctx) {
  if (!text || !text.includes('${')) return text;
  return text.replace(/\$\{([^}]+)\}/g, (all, k) => {
    if (k.startsWith('secure::')) return all;
    const r = ctx.project.resolveProperty(k, ctx.env);
    return r && !/^!\[/.test(r.value) ? r.value : all;
  });
}

// ------------------------------------------------------------------ entry points and their errors

function endpointsTab(ctx) {
  const entries = entryPoints(ctx.project);
  if (!entries.length) return { el: h('p.muted', 'Nothing in this app starts a flow: it is a library, or other apps call its flows.') };
  const shared = new Set(entries.filter((e) => e.kind === 'http').map((e) => e.label).filter((l, i, all) => all.indexOf(l) !== i));
  const row = (e) => {
    const errors = h('div.endpoint-errors');
    const d = h(`details.endpoint.kind-${e.kind}`,
      { ontoggle: () => { if (d.open && !errors.childElementCount) errors.append(errorsTable(errorsOf(ctx.project, e, { libraryFlows: ctx.libraryFlows }), e)); } },
      h('summary',
        e.method ? h('span.method', e.method) : null,
        h('span.mono.endpoint-path', e.kind === 'api' || e.kind === 'http' ? e.path : resolved(e.label, ctx)),
        e.type ? h('span.muted', ` ${e.type}`) : null,
        shared.has(e.label) ? h('span.muted', ` ${e.config}`) : null,
        h('span.spacer'),
        e.routes?.length ? h('span.muted', `APIkit router · ${plural(e.routes.length, 'resource')} `) : null,
        h('a.endpoint-flow', { onclick: (ev) => { ev.preventDefault(); ctx.openFlow(e.flow.name); } }, e.flow.name)),
      errors);
    return d;
  };
  const groups = [
    ['HTTP', entries.filter((e) => e.kind === 'http' || e.kind === 'api')],
    ['Schedules', entries.filter((e) => e.kind === 'schedule')],
    ['Listeners', entries.filter((e) => e.kind === 'source')],
  ].filter(([, list]) => list.length);
  const counts = groups.map(([name, list]) => (name === 'HTTP'
    ? plural(list.filter((e) => e.kind === 'api').length || list.length, list.some((e) => e.kind === 'api') ? 'API resource' : 'HTTP listener')
    : plural(list.length, name === 'Schedules' ? 'schedule' : 'listener')));
  return {
    summary: counts.join(' · '),
    el: groups.map(([name, list]) => h('section.search-file', h('div.search-file-head', name), list.map(row))),
  };
}

const answer = (o, entry) => {
  if (o.end === 'continue' && o.inner) return h('span.muted', 'caught; the flow goes on');
  if (!o.status) return o.end === 'unhandled' ? h('span', 'fails') : h('span.muted', o.end === 'continue' ? 'caught' : 'fails after its handlers');
  if (o.status.code) return [h('b.status', o.status.code), o.status.default ? h('span.muted', o.end === 'unhandled' ? " Mule's default" : ' default') : null];
  if (o.status.setBy) return h('span', 'set by ', h('span.mono', o.status.setBy));
  return h('span.mono', o.status.expr || '');
};

function errorsTable(rows, entry) {
  // types with the same handling, together
  const groups = new Map();
  for (const r of rows) {
    for (const o of r.outcomes) {
      const key = JSON.stringify([o.handlers.map((x) => `${x.where}|${x.label}`), o.end, o.inner, o.status]);
      if (!groups.has(key)) groups.set(key, { types: [], raisedBy: new Set(), o });
      groups.get(key).types.push(r.type);
      r.raisedBy.forEach((x) => groups.get(key).raisedBy.add(x));
    }
  }
  if (!groups.size) return h('p.muted', 'No error handling on the way.');
  return h('table.trace-vars.errors-table',
    h('thead', h('tr', h('th', 'Error'), h('th', 'Raised by'), h('th', 'Handled by'), h('th', entry.kind === 'http' || entry.kind === 'api' ? 'Answer' : ''))),
    h('tbody', [...groups.values()].map(({ types, raisedBy, o }) => h(`tr${o.end === 'unhandled' ? '.unhandled' : ''}`,
      h('td.mono', types.map((t) => h('div', t === OTHER ? h('span.muted', 'anything else') : t))),
      h('td', [...raisedBy].slice(0, 3).join(', '), raisedBy.size > 3 ? h('span.muted', ` +${raisedBy.size - 3}`) : null),
      h('td', o.handlers.length ? o.handlers.map((x, i) => h('div', { title: x.label }, i ? '→ ' : '', x.kind === 'continue' ? 'On Error Continue' : 'On Error Propagate', h('span.muted', ` in ${x.where}`)))
        : [h('span.check-dot.error'), 'nothing catches it']),
      h('td', answer(o, entry))))));
}

// ------------------------------------------------------------------ what it calls

function callsTab(ctx) {
  const list = outboundCalls(ctx.project);
  if (!list.length) return { el: h('p.muted', 'This app calls no other system through a connector configuration.') };
  return {
    summary: plural(list.length, 'configuration'),
    el: list.map((c) => h('section.search-file',
      h('div.search-file-head', c.label, h('span.muted', ` ${c.connector}`)),
      c.settings.length ? h('div.call-settings', c.settings.map((x) => h('span', h('span.muted', `${x.name} `), h('span.mono', { title: x.raw }, resolved(x.raw, ctx))))) : null,
      c.uses.length ? c.uses.map((u) => h('div.search-hit.call-use', { onclick: () => ctx.openItem(u.processor, u.flow) },
        h('span.mono', { title: u.what }, resolved(u.what, ctx) || u.label), h('span.muted', `${u.label} · ${u.flow.name}`)))
        : h('p.muted.call-none', 'Nothing uses it.'))),
  };
}

// ------------------------------------------------------------------ properties across environments

const KEY_ICON = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  Object.entries({ viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => svg.setAttribute(k, v));
  svg.innerHTML = '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3m-3 3 2 2m-5 1 2 2"/>';
  return svg;
};

function propertiesTab(ctx) {
  const m = envMatrix(ctx.project, { libraryTexts: ctx.libraryTexts });
  if (!m.rows.length) return { el: h('p.muted', 'This app has no properties.') };
  const fix = m.rows.filter((r) => r.problems.some((p) => p.severity !== 'info'));
  const table = h('table.trace-vars.env-matrix');
  // columns with encrypted values get a key button
  const locked = m.columns.map((c, i) => !!c && m.rows.some((r) => r.cells[i]?.encrypted));
  const draw = (only) => {
    const rows = only ? fix : m.rows;
    table.replaceChildren(
      h('thead', h('tr', h('th', ''), m.columns.map((c, i) => h('th', c || 'Value', locked[i] && ctx.askKey
        ? h(`button.icon-btn.col-key${ctx.hasKey?.(c) ? '.active' : ''}`, { title: `Key for the ${c} secure:: values`, onclick: (e) => ctx.askKey(c, e.currentTarget) }, KEY_ICON())
        : null)))),
      h('tbody', rows.map((r) => h('tr',
        h('td.mono.key', r.key, r.problems.map((p) => h('div.problem', h(`span.check-dot.${p.severity}`), p.text))),
        r.cells.map((c, i) => {
          const env = m.columns[i];
          if (!c) return h('td.missing', '—');
          const text = c.decrypted != null ? propertyValue({ value: c.decrypted, secure: true }, ctx)
            : c.encrypted ? h('span.chip', { title: `Encrypted: give the ${env} key`, onclick: (e) => { e.stopPropagation(); ctx.askKey?.(env, e.currentTarget); } }, 'encrypted')
              : c.plain ? h('span.chip.warn', 'plain text') : c.value || h('span.muted', '(empty)');
          return h(`td.mono${c.own ? '' : '.common'}`, { title: `${c.file}:${c.line}${c.own ? '' : ' (shared by the environments)'}`, onclick: () => ctx.openSource(c.file, c.line) }, text);
        })))));
  };
  const only = h('input', { type: 'checkbox', onchange: () => draw(only.checked) });
  draw(false);
  const missing = m.rows.filter((r) => r.problems.some((p) => p.text.startsWith('missing'))).length;
  const undefinedKeys = m.rows.filter((r) => r.problems.some((p) => p.severity === 'error')).length;
  return {
    summary: [plural(m.rows.length, 'key'), missing ? `${missing} missing in some environments` : null, undefinedKeys ? `${undefinedKeys} not defined` : null].filter(Boolean).join(' · '),
    el: [fix.length ? h('label.matrix-filter', only, ` Only the ${plural(fix.length, 'key')} to fix`) : null, h('div.matrix-wrap', table)],
  };
}

// ------------------------------------------------------------------ library versions across the owner's apps

function librariesTab(ctx) {
  const el = h('div', h('p.muted', 'Reading every repository’s pom.xml…'));
  ctx.libraryMap().then((libs) => {
    if (!libs.length) return el.replaceChildren(h('p.muted', 'No app here depends on a library from another of these repositories.'));
    // the libraries this app uses first
    const mine = (l) => l.apps.some((a) => a.name.toLowerCase() === (ctx.repoName || '').toLowerCase());
    const sorted = [...libs].sort((a, b) => mine(b) - mine(a));
    el.replaceChildren(...sorted.map((l) => {
      const old = l.apps.filter((a) => l.newest && /^\d/.test(a.version) && compareVersions(a.version, l.newest) < 0).length;
      return h('section.search-file',
        h('div.search-file-head', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.artifactId),
          h('span.muted', ` ${plural(l.apps.length, 'app')}${l.newest ? ` · newest in use ${l.newest}` : ''}${old ? ` · ${old} on older versions` : ''}`)),
        h('div.lib-apps', l.apps.map((a) => {
          const behind = l.newest && /^\d/.test(a.version) && compareVersions(a.version, l.newest) < 0;
          const here = a.name.toLowerCase() === (ctx.repoName || '').toLowerCase();
          return h(`div.lib-app${here ? '.here' : ''}`,
            h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.name),
            h(`span.chip${behind ? '.behind' : ''}`, { title: behind ? `Older than ${l.newest}` : a.version ? '' : 'Set in a parent pom this view cannot read' }, a.version || '?'),
            a.branch ? h('span.muted', ` ${a.branch}`) : null);
        })));
    }));
  }, (e) => el.replaceChildren(h('p.muted', `Could not read them: ${e.message}`)));
  return { el };
}

// ------------------------------------------------------------------ commits per author and per branch

const ALL = 'All branches';
const TOP = 15;

/** Bars of one measure, longest first: [{label, value, title?, onclick?}], the rest folded into one row. */
function bars(rows, unit) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, TOP);
  const rest = sorted.slice(TOP);
  if (rest.length) shown.push({ label: `${rest.length} more`, value: rest.reduce((n, r) => n + r.value, 0), more: true });
  const max = Math.max(1, ...shown.map((r) => r.value));
  return h('div.bars', shown.map((r) => h(`div.bar-row${r.onclick ? '.link' : ''}${r.more ? '.more' : ''}`, { title: r.title || `${r.label}: ${plural(r.value, unit)}`, onclick: r.onclick || null },
    h('span.bar-label', r.label),
    h('span.bar-track', h('span.bar', { style: `width: ${Math.max(0.5, (r.value / max) * 100)}%` })),
    h('span.bar-value', String(r.value)))));
}

function commitsTab(ctx) {
  const el = h('div.commits-tab', h('p.muted', 'Reading the branches…'));
  const show = async (scope) => {
    const { current, default: main, branches } = await ctx.commits.branches();
    const pick = h('button.branch-button', { title: 'Branch: type to find one' }, scope);
    pick.onclick = async () => {
      const b = await pickBranch(pick, { branches: [ALL, ...branches], current, value: scope, currentLabel: 'this page' });
      if (b && b !== scope) show(b);
    };
    const status = h('span.muted', '');
    const body = h('div.commits-charts');
    el.replaceChildren(h('div.commits-head', pick, status), body);
    // every branch when all are asked for, else the one
    const names = scope === ALL ? [main, ...branches.filter((b) => b !== main)].filter(Boolean) : [scope];
    const lists = new Map();
    let read = 0;
    await Promise.all(names.map(async (b) => {
      lists.set(b, await ctx.commits.on(b).catch(() => ({ commits: [], capped: false, failed: true })));
      read++;
      if (names.length > 1 && read < names.length) status.textContent = `Reading ${read} of ${plural(names.length, 'branch', 'branches')}…`;
    }));
    if (pick.isConnected === false) return;   // another scope was picked meanwhile
    const unique = new Map();
    for (const { commits } of lists.values()) for (const c of commits) unique.set(c.sha, c);
    const byAuthor = new Map();
    for (const c of unique.values()) byAuthor.set(c.author || '?', (byAuthor.get(c.author || '?') || 0) + 1);
    const capped = [...lists.values()].some((l) => l.capped);
    const failed = [...lists].filter(([, l]) => l.failed).map(([b]) => b);
    status.textContent = [plural(unique.size, 'commit'), plural(byAuthor.size, 'author'),
      capped ? 'newest 300 per branch' : null, failed.length ? `could not read ${failed.join(', ')}` : null].filter(Boolean).join(' · ');
    const charts = [h('section.commits-chart', h('h3', 'By author'), bars([...byAuthor].map(([label, value]) => ({ label, value })), 'commit'))];
    if (scope === ALL && names.length > 1) {
      // what each branch has that the default branch does not
      const onMain = new Set((lists.get(main)?.commits || []).map((c) => c.sha));
      const rows = names.filter((b) => b !== main).map((b) => ({
        label: b, value: lists.get(b).commits.filter((c) => !onMain.has(c.sha)).length, onclick: () => show(b),
      })).filter((r) => r.value);
      charts.push(h('section.commits-chart', h('h3', `By branch, not on ${main}`),
        rows.length ? bars(rows, 'commit') : h('p.muted', `Every branch's commits are on ${main}.`)));
    }
    body.replaceChildren(...charts);
  };
  ctx.commits.branches().then(() => show(ALL), (e) => el.replaceChildren(h('p.muted', `Could not read the branches: ${e.message}`)));
  return { el };
}
