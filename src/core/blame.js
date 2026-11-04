// Canvas coloured by when each element last changed, or by who changed it (from FileVersions.blame()).

import { h } from './dom.js';

const DAY = 86_400_000;
const YEAR_LOG = Math.log(1 + 365);

/** 0 (today) .. 1 (a year or more), on a log scale so the last weeks stay distinguishable. */
const age = (date) => Math.min(1, Math.log(1 + Math.max(0, (Date.now() - new Date(date)) / DAY)) / YEAR_LOG);
const ageColour = (t) => `color-mix(in oklch, var(--blame-new), var(--blame-old) ${Math.round(t * 100)}%)`;

function hue(name) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return (x * 137.508) % 360;      // golden angle: neighbouring hashes land far apart
}
const authorColour = (name) => `oklch(0.7 0.15 ${hue(name).toFixed(0)})`;
const when = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Colours the canvas elements in `root` (those with data-line/data-end) and returns a legend.
 * entryAt(from, to) -> commit | 'uncommitted' | null for an element's XML lines. mode: 'age' | 'author'.
 */
export function paintBlame(root, entryAt, mode) {
  const authors = new Map();
  for (const el of root.querySelectorAll('[data-line]')) {
    const e = entryAt(+el.dataset.line, +el.dataset.end);
    if (!e) continue;
    const colour = e === 'uncommitted' ? 'var(--accent)' : mode === 'age' ? ageColour(age(e.date)) : authorColour(e.author);
    el.classList.add('blame');
    el.style.setProperty('--blame', colour);
    // the hover note goes on the part you point at: a node, or a flow's or scope's header
    const target = el.matches('.node') ? el : el.querySelector(':scope > .flow-head, :scope > .scope-head');
    if (target) {
      target.dataset.tipTitle = 'Last changed';
      target.dataset.tip = e === 'uncommitted' ? 'Not committed yet' : `${when(e.date)} · ${e.author}\n${e.short} ${e.subject}`;
      target.classList.add('blame-tip');
    }
    if (e !== 'uncommitted') {
      el.dataset.author = e.author;
      authors.set(e.author, (authors.get(e.author) || 0) + 1);
    }
  }
  const focus = (name) => root.querySelectorAll('.blame').forEach((el) => el.classList.toggle('blame-dim', name != null && el.dataset.author !== name));
  return h('div.blame-legend', mode === 'age'
    ? [h('span.muted', 'Today'), h('span.blame-scale'), h('span.muted', 'A year+')]
    : [...authors].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => h('span.blame-author', {
      onmouseenter: () => focus(name), onmouseleave: () => focus(null),
    }, h('i', { style: `background:${authorColour(name)}` }), name, h('span.muted', ` ${n}`))));
}

export function clearBlame(root) {
  root.querySelectorAll('.blame').forEach((el) => {
    el.classList.remove('blame', 'blame-dim');
    el.style.removeProperty('--blame');
    delete el.dataset.author;
  });
  root.querySelectorAll('.blame-tip').forEach((el) => {
    el.classList.remove('blame-tip');
    delete el.dataset.tip;
    delete el.dataset.tipTitle;
  });
  root.querySelector('.blame-legend')?.remove();
}
