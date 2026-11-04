// The open file's XML under the canvas. Selecting lines reports them (onLines(from, to)) so the
// canvas can point at the elements they define; show() marks an element's lines here.
// history (optional): {label(ranges) -> Promise<text | null>, open(ranges, anchor)} for a button beside marked lines.

import { h } from './dom.js';
import { highlightXml } from './dataweave.js';

/** Highlighted HTML split into lines; a token that spans lines (comment, attribute value) is reopened on each. */
function htmlLines(html) {
  let open = '';
  return html.split('\n').map((line) => {
    const text = open + line;
    const tags = text.match(/<span[^>]*>|<\/span>/g) || [];
    open = tags.length && !tags[tags.length - 1].startsWith('</') ? tags[tags.length - 1] : '';
    return open ? `${text}</span>` : text;
  });
}

const lineOf = (node) => +(node?.nodeType === 1 ? node : node?.parentElement)?.closest('.xl')?.dataset.n || 0;

export function xmlPane(source, onLines, history = null) {
  const code = h('div.xml-code.mono', {
    html: htmlLines(highlightXml(source)).map((l, i) => `<div class="xl" data-n="${i + 1}">${l || ' '}</div>`).join(''),
  });
  const scroller = h('div.xml-scroll', code);
  const button = h('button.xml-history', { hidden: true, onclick: () => history.open(shown, button) });
  const el = h('div.xml-view', scroller, button);
  let marked = [];
  let shown = [];

  // the button follows the first marked line, and hides while that line is scrolled away
  const place = () => {
    const top = marked[0] && marked[0].offsetTop - scroller.scrollTop;
    button.hidden = !button.textContent || top == null || top < 0 || top > scroller.clientHeight - 18;
    if (!button.hidden) button.style.top = `${top}px`;
  };
  scroller.addEventListener('scroll', place, { passive: true });

  const reportSelection = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !code.contains(sel.anchorNode)) return;
    const r = sel.getRangeAt(0);
    let from = lineOf(r.startContainer);
    let to = lineOf(r.endContainer);
    if (!from || !to) return;
    // a triple-clicked line ends at the start of the next one
    if (to > from && r.endOffset === 0) to--;
    onLines(from, to);
  };
  code.addEventListener('mouseup', () => setTimeout(reportSelection));
  code.addEventListener('keyup', (e) => { if (e.shiftKey) reportSelection(); });

  /**
   * Marks [[from, to], ...]; scroll ('smooth' | 'instant') brings the first range into view.
   * targets: the elements' own ranges, when the marked lines are only part of them (history is theirs).
   */
  function show(ranges, { scroll = false, pulse = false, targets = ranges } = {}) {
    marked.forEach((l) => l.classList.remove('hl', 'pulse'));
    marked = [];
    for (const [from, to] of ranges) {
      for (let n = from; n <= to; n++) {
        const l = code.children[n - 1];
        if (l) marked.push(l);
      }
    }
    if (pulse) void code.offsetWidth;
    marked.forEach((l) => l.classList.add('hl', ...(pulse ? ['pulse'] : [])));
    shown = targets;
    button.textContent = '';
    if (history && targets.length) {
      history.label(targets).then((text) => {
        if (shown !== targets) return;
        button.textContent = text || '';
        place();
      }, () => {});
    }
    place();
    if (scroll && marked[0]) {
      const top = marked[0].offsetTop;
      const bottom = marked[marked.length - 1].offsetTop + marked[marked.length - 1].offsetHeight;
      const fits = bottom - top < scroller.clientHeight;
      if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTo({ top: fits ? (top + bottom - scroller.clientHeight) / 2 : top - 8, behavior: scroll });
      }
    }
  }

  return { el, show };
}
