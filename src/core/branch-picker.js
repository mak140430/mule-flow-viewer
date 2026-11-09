// Lists you can type into: 80 branches or 300 commits do not fit a dropdown.

import { h } from './dom.js';

/**
 * The popover under `anchor`. rows: [{value, text (what typing matches), cells: [elements of the row]}], already in
 * order; first(q, row): true for rows to put first while typing. actions: ['Open', ...]: each row offers the others,
 * clicking a row takes the first. Resolves with {value, action}, or null.
 */
function picker(anchor, { rows, value, placeholder, empty, cls = '', first = null, actions = null }) {
  document.querySelector('.branch-pop')?.remove();
  return new Promise((resolve) => {
    const input = h('input.mono', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
    const list = h('div.branch-list');
    const pop = h(`div.popover.branch-pop${cls}`, input, list);
    let shown = [];
    let active = 0;
    const done = (row, action = actions?.[0]) => { pop.remove(); document.removeEventListener('mousedown', away, true); resolve(row ? { value: row.value, action } : null); };
    const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) done(null); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      // every word somewhere in the row
      shown = rows.filter((r) => words.every((w) => r.text.toLowerCase().includes(w)));
      if (q && first) shown.sort((a, b) => first(q, b) - first(q, a));
      if (!q) active = Math.max(0, shown.findIndex((r) => r.value === value));
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.slice(0, 300).map((r, i) => h(`div.branch-item${i === active ? '.active' : ''}${r.value === value ? '.picked' : ''}`, {
        onmousemove: () => { if (active !== i) { active = i; mark(); } },
        onclick: () => done(r),
      }, ...r.cells, ...(actions || []).slice(1).map((a) => h('a.branch-action', { onclick: (e) => { e.stopPropagation(); done(r, a); } }, a)))),
      ...(shown.length ? [] : [h('div.muted.branch-empty', empty)]));
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    const mark = () => list.querySelectorAll('.branch-item').forEach((el, i) => el.classList.toggle('active', i === active));
    const move = (to) => { active = Math.max(0, Math.min(shown.length - 1, to)); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); };
    input.oninput = () => { active = 0; render(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(active - 1); }
      else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); done(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
    };
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    document.body.append(pop);
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    render();
    input.focus();
    setTimeout(() => document.addEventListener('mousedown', away, true));
  });
}

/**
 * anchor: element to open under; {branches, current (checked out, or the page's: currentLabel says), value (picked now), exclude: names to leave out,
 * actions: ['Open', 'Compare with yours']: then each row offers them, clicking a row takes the first, and the result
 * is {branch, action}}
 */
export async function pickBranch(anchor, { branches, current = '', value = '', exclude = [], actions = null, currentLabel = 'checked out' }) {
  const rows = branches.filter((b) => !exclude.includes(b)).map((b) => ({
    value: b, text: b, cells: [h('span.branch-item-name', b), b === current ? h('span.muted', currentLabel) : null],
  }));
  // names that start with what is typed first
  const first = (q, r) => r.value.toLowerCase().replace(/^origin\//, '').startsWith(q);
  const r = await picker(anchor, { rows, value, placeholder: 'Find a branch', empty: 'No branch matches. Is it fetched?', first, actions });
  if (!r) return null;
  return actions ? { branch: r.value, action: r.action } : r.value;
}

/**
 * anchor: element to open under; items: [{value, label, sha?, author?, date?}] in the list's order (comparisons first,
 * then commits, newest first); value: the one shown. Typing matches the message, hash, author and date. Resolves with
 * the value, or null.
 */
export async function pickCommit(anchor, { items, value }) {
  const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const rows = items.map((c) => ({
    value: c.value,
    text: [c.label, c.sha, c.author, day(c.date)].filter(Boolean).join(' '),
    cells: c.sha
      ? [h('span.branch-item-name.commit-item-name', h('span.muted.commit-sha', c.sha.slice(0, 7)), ' ', c.label), h('span.muted', [c.author, day(c.date)].filter(Boolean).join(' · '))]
      : [h('span.branch-item-name', c.label)],
  }));
  const r = await picker(anchor, { rows, value, placeholder: 'Find a commit: message, hash, author or date', empty: 'No commit matches.', cls: '.commit-pop' });
  return r?.value ?? null;
}
