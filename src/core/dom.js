/**
 * Hover tooltips for elements with data-tip (code) and optional data-tip-title.
 * Rendered on <body> so scroll containers inside the canvas cannot clip them.
 */
export function installTooltips(root) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  document.body.append(tip);
  root.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || !root.contains(el)) return;
    tip.replaceChildren(
      ...(el.dataset.tipTitle ? [h('div.tooltip-title', el.dataset.tipTitle)] : []),
      h('div.tooltip-body', el.dataset.tip));
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const below = r.bottom + 6 + t.height < window.innerHeight;
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - t.height}px`;
    tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - t.width - 8))}px`;
    el.addEventListener('mouseleave', () => { tip.hidden = true; }, { once: true });
  });
}

/** h('div.a.b', {onclick, title}, child, [children], 'text') */
export function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  return el;
}
