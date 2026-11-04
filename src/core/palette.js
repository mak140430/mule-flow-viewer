// ⌘K: one box to go anywhere. items: [{label, hint?, icon?, group, run()}]; a pasted URL goes to onLink(url),
// and onSearch(text), when given, is offered last for any text: search every branch for it.

import { h } from './dom.js';

const LIMIT = 60;

/** Subsequence match, scored: consecutive letters and word starts count most. -1 when it does not match. */
function score(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let at = 0;
  let total = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return -1;
    run = i === at ? run + 1 : 0;
    total += 1 + run * 2 + (i === 0 || /[\s:/._-]/.test(t[i - 1]) ? 3 : 0);
    at = i + 1;
  }
  return total - t.length * 0.01;
}

export function openPalette(items, { onLink, onSearch } = {}) {
  document.querySelector('.palette-backdrop')?.remove();
  const input = h('input', { type: 'text', placeholder: 'Go to a flow, file or branch, or paste a link', spellcheck: 'false' });
  const list = h('div.palette-list');
  const backdrop = h('div.palette-backdrop', { onmousedown: (e) => { if (e.target === backdrop) close(); } },
    h('div.palette', h('div.palette-input', input, h('span.kbd', 'esc')), list));
  let shown = [];
  let active = 0;

  function close() {
    backdrop.remove();
  }
  function choose(item) {
    close();
    item.run();
  }
  function render() {
    const q = input.value.trim();
    if (/^https?:\/\//.test(q) && onLink) {
      shown = [{ label: 'Open this link', hint: q, group: 'Link', run: () => onLink(q) }];
    } else {
      shown = (q ? items.map((it) => ({ it, s: score(q, it.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.it) : items)
        .slice(0, LIMIT);
      if (onSearch && q.length >= 2) shown.push({ label: `Search every branch for “${q}”`, group: 'Search', run: () => onSearch(q) });
    }
    active = Math.min(active, Math.max(0, shown.length - 1));
    let group = null;
    list.replaceChildren(...shown.flatMap((it, i) => {
      const head = it.group !== group ? h('div.palette-group', (group = it.group)) : null;
      const row = h(`div.palette-item${i === active ? '.active' : ''}`, {
        onmousemove: () => { if (active !== i) { active = i; mark(); } },
        onclick: () => choose(it),
      }, it.icon ? h('img', { src: it.icon, alt: '' }) : h('span.palette-dot'), h('span.palette-label', it.label), it.hint ? h('span.palette-hint-text', it.hint) : null);
      return head ? [head, row] : [row];
    }), ...(shown.length ? [] : [h('div.palette-empty', 'Nothing matches')]));
  }
  function mark() {
    list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === active));
    list.querySelectorAll('.palette-item')[active]?.scrollIntoView({ block: 'nearest' });
  }
  input.oninput = () => { active = 0; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); choose(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  render();
  document.body.append(backdrop);
  input.focus();
}
