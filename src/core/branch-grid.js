// Branches side by side: every element that differs between them, one column per branch,
// each compared with the first (the reference). Answers "is this change in qa / preprod / main yet?"

import { h } from './dom.js';
import { diffProjects, elementIdent, isChange } from './diff.js';
import { pickBranch } from './branch-picker.js';

const ENVS = ['dev|develop|development', 'qa|test|sit', 'preprod|pre-prod|uat|staging|stage', 'main|master|prod|production'];
const ENV_ORDER = ENVS.map((e) => new RegExp(`^(${e})$`));
const ENV_SUFFIX = new RegExp(`-(${ENVS.slice(0, 3).join('|')})$`);

/**
 * Columns to start with, in promotion order: the checked-out branch's family (`feature/x`, `feature/x-qa`,
 * `feature/x-preprod`), then the env branches. Local branches win over their origin/ copies.
 */
export function defaultColumns({ current, branches }) {
  const pick = (test) => branches.find((b) => !b.startsWith('origin/') && test(b)) || branches.find((b) => test(b.replace(/^origin\//, '')));
  const stem = current?.replace(ENV_SUFFIX, '');
  const family = stem ? [pick((b) => b === stem), ...ENV_ORDER.slice(0, 3).map((re) => pick((b) => b.startsWith(`${stem}-`) && re.test(b.slice(stem.length + 1))))] : [];
  const envs = ENV_ORDER.map((re) => pick((b) => re.test(b)));
  return [...new Set([...family, current, ...envs].filter(Boolean))].slice(0, 7);
}

/**
 * columns: [{name, project}], the first is the reference.
 * Returns rows [{ident, file, flow, label, key, ids, cells: [null | 'changed' | 'added' | 'removed', ...], reasons}]
 * for elements that differ in at least one column, in file and document order, then property values
 * (rows with `property`: the key, file: the properties file).
 */
export function gridRows(columns) {
  const [ref, ...others] = columns;
  const rows = new Map();
  const props = new Map();
  others.forEach((col, k) => {
    const d = diffProjects(ref.project, col.project);
    for (const e of d.byId.values()) {
      if (!isChange(e.item)) continue;
      const ident = elementIdent(e);
      if (!rows.has(ident)) {
        const item = e.item;
        rows.set(ident, {
          ident,
          file: item.file,
          flow: e.flow && e.flow !== item ? e.flow.name : null,
          label: item.name && item === e.flow ? item.name : item.label || item.name,
          key: item.key,
          isFlow: item === e.flow,
          line: item.node?.line ?? 0,
          ids: {},
          cells: others.map(() => null),
          reasons: others.map(() => null),
        });
      }
      const row = rows.get(ident);
      row.cells[k] = e.item.diff;
      row.reasons[k] = e.item.reasons?.join(', ') || null;
      row.ids[col.name] = e.item.id;
    }
    for (const [key, changes] of d.props) {
      for (const c of changes) {
        const ident = `property:${c.file}:${key}`;
        if (!props.has(ident)) props.set(ident, { ident, property: key, file: c.file, label: key, ids: {}, cells: others.map(() => null), reasons: others.map(() => null) });
        const row = props.get(ident);
        row.cells[k] = c.before == null ? 'added' : c.after == null ? 'removed' : 'changed';
        row.reasons[k] = `${c.before ?? '—'} → ${c.after ?? '—'}`;
      }
    }
  });
  // inside a flow that is added or removed, the elements say nothing the flow's own row does not
  const flows = new Map([...rows.values()].filter((r) => r.isFlow).map((r) => [`${r.file}|${r.label}`, r]));
  const flowRow = (r) => r.flow && flows.get(`${r.file}|${r.flow}`);
  const same = (a, b) => a.cells.every((c, k) => c === b.cells[k]);
  const elements = [...rows.values()].filter((r) => !(flowRow(r) && same(r, flowRow(r))));
  return [
    ...elements.sort((a, b) => a.file.localeCompare(b.file) || (a.flow || '').localeCompare(b.flow || '') || a.line - b.line),
    ...[...props.values()].sort((a, b) => a.file.localeCompare(b.file) || a.property.localeCompare(b.property)),
  ];
}

// what a cell says about the element on that branch, compared with the reference (the first column)
const MARK = { changed: 'different', added: 'only here', removed: 'missing' };
const TITLE = { changed: 'is different on', added: 'exists only on', removed: 'is missing on' };

/**
 * ctx: {icons, columns: [names], all: [branch names], current, rows, onColumns(names), onCompare(row, column), onOpen(row)}
 */
export function renderGrid(ctx) {
  const { columns, rows } = ctx;
  const set = (names) => ctx.onColumns([...new Set(names.filter(Boolean))]);
  // a button that opens a branch picker you can type into
  const picker = (value, onchange) => {
    const button = h('button.branch-button', {
      title: value || 'Add a branch',
      onclick: async () => {
        const b = await pickBranch(button, { branches: ctx.all, current: ctx.current, value, exclude: columns.filter((c) => c !== value) });
        if (b && b !== value) onchange(b);
      },
    }, value || '+ Branch');
    return button;
  };

  const head = h('tr',
    h('th.grid-element', rows.length ? `${rows.length} element${rows.length === 1 ? ' differs' : 's differ'}` : ''),
    columns.map((name, i) => h(`th${i ? '' : '.reference'}`,
      picker(name, (v) => set(columns.map((c) => (c === name ? v : c)))),
      h('div.grid-col-actions',
        i ? h('a', { title: 'Compare every other branch with this one', onclick: () => set([name, ...columns.filter((c) => c !== name)]) }, 'compare with this')
          : h('span.muted', 'reference'),
        columns.length > 2 ? h('a', { title: 'Remove column', onclick: () => set(columns.filter((c) => c !== name)) }, '×') : null))),
    h('th', picker('', (v) => set([...columns, v]))));

  const body = [];
  let group = null;
  for (const row of rows) {
    const g = `${row.file}|${row.flow || ''}`;
    if (g !== group) {
      group = g;
      body.push(h('tr.grid-group', h('td', { colspan: columns.length + 2 },
        h('span.mono', row.file.replace(/^src\/main\/(mule|resources)\//, '')), row.flow ? h('span.muted', ` · ${row.flow}`) : null)));
    }
    body.push(h('tr',
      h('td.grid-element', row.property ? h('span.mono', row.label) : h('a', { onclick: () => ctx.onOpen(row), title: row.label },
        h('img', { src: ctx.icons.url(row.key), alt: '' }), row.label)),
      h('td.grid-cell.reference', { title: row.cells.includes('added') ? `not on ${columns[0]}` : `on ${columns[0]}` }, row.cells.includes('added') ? 'not here' : 'has it'),
      row.cells.map((c, k) => h(`td.grid-cell${c ? `.${c}` : ''}`, c ? {
        title: `${row.label} ${TITLE[c]} ${columns[k + 1]}${row.reasons[k] ? ` (${row.reasons[k]})` : ''}. Click to see the difference.`,
        onclick: () => ctx.onCompare(row, columns[k + 1]),
      } : { title: `same as on ${columns[0]}` }, c ? MARK[c] : 'same')),
      h('td')));
  }
  const chip = (kind, text) => h(`span.grid-key.${kind}`, text);
  return h('div.grid-view',
    h('p.grid-legend',
      `Every element that is not the same on all these branches. Each column is compared with the reference, ${columns[0]}: `,
      chip('changed', 'different'), ' its settings, script or a property it reads differ; ',
      chip('removed', 'missing'), ' the branch does not have it; ',
      chip('added', 'only here'), ' only that branch has it. Click one to see the difference.'),
    h('table.grid', h('thead', head), h('tbody', body)),
    rows.length ? null : h('p.empty-state', `No elements differ between ${columns.join(', ')}.`));
}
