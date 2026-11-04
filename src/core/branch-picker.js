// A branch picker you can type into: 80 branches do not fit a dropdown. Resolves with the branch, or null.

import { h } from './dom.js';

/**
 * anchor: element to open under; {branches, current (checked out, or the page's: currentLabel says), value (picked now), exclude: names to leave out,
 * actions: ['Open', 'Compare with yours']: then each row offers them, clicking a row takes the first, and the result
 * is {branch, action}}
 */
export function pickBranch(anchor, { branches, current = '', value = '', exclude = [], actions = null, currentLabel = 'checked out' }) {
  document.querySelector('.branch-pop')?.remove();
  return new Promise((resolve) => {
    const input = h('input.mono', { type: 'text', placeholder: 'Find a branch', spellcheck: 'false', autocomplete: 'off' });
    const list = h('div.branch-list');
    const pop = h('div.popover.branch-pop', input, list);
    let shown = [];
    let active = 0;
    const done = (b, action = actions?.[0]) => { pop.remove(); document.removeEventListener('mousedown', away, true); resolve(b && actions ? { branch: b, action } : b); };
    const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) done(null); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      // every word somewhere in the name; names that start with the query first
      shown = branches.filter((b) => !exclude.includes(b) && words.every((w) => b.toLowerCase().includes(w)))
        .sort((a, b) => (q && b.toLowerCase().replace(/^origin\//, '').startsWith(q)) - (q && a.toLowerCase().replace(/^origin\//, '').startsWith(q)));
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.slice(0, 200).map((b, i) => h(`div.branch-item${i === active ? '.active' : ''}${b === value ? '.picked' : ''}`, {
        onmousemove: () => { active = i; mark(); },
        onclick: () => done(b),
      }, h('span.branch-item-name', b), b === current ? h('span.muted', currentLabel) : null,
      ...(actions || []).slice(1).map((a) => h('a.branch-action', { onclick: (e) => { e.stopPropagation(); done(b, a); } }, a)))),
      ...(shown.length ? [] : [h('div.muted.branch-empty', 'No branch matches. Is it fetched?')]));
    };
    const mark = () => list.querySelectorAll('.branch-item').forEach((el, i) => el.classList.toggle('active', i === active));
    input.oninput = () => { active = 0; render(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); done(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
    };
    render();
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 380))}px`;
    document.body.append(pop);
    input.focus();
    setTimeout(() => document.addEventListener('mousedown', away, true));
  });
}
