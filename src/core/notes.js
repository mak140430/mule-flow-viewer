// Release notes: what a comparison changes, by flow, as Markdown to paste into a PR, a release or a chat.

import { h } from './dom.js';
import { walkFlow } from './model.js';

const MULE_DIR = 'src/main/mule/';
// values of keys like these stay out of notes that get pasted around
const SECRET = /pass|secret|token|key|credential|pwd/i;

const value = (key, v) => (v == null ? '—' : SECRET.test(key) ? '(hidden)' : `\`${v}\``);

/** d: diffProjects() result; title: what is compared; commits: [{short, subject, author}] it covers. */
export function releaseNotes(d, { title, commits = [], libraries = [], reached = [] }) {
  const out = [`## ${title}`, ''];
  // reached: [{entry, changes}] from impact.js
  if (reached.length) {
    out.push('### Entry points affected', ...reached.map(({ entry, changes }) => `- \`${entry.label}\`${entry.routes?.length ? ' (every request)' : ''}: ${[...new Set(changes.map((c) => c.label))].join(', ')}`), '');
  }
  const flows = [];
  for (const c of d.configs.values()) {
    for (const f of c.flows) {
      if (!f.diff) continue;
      const name = f.name || '(unnamed)';
      const where = c.path.replace(MULE_DIR, '');
      if (f.diff === 'added' || f.diff === 'removed') { flows.push(`- **${name}** (${where}): ${f.diff === 'added' ? 'new' : 'removed'}`); continue; }
      const items = [];
      walkFlow(f, (p) => {
        if (p.diff === 'added') items.push(`  - Added ${p.label}`);
        else if (p.diff === 'removed') items.push(`  - Removed ${p.label}`);
        else if (p.diff === 'changed') items.push(`  - Changed ${p.label}${p.reasons?.length ? ` (${p.reasons.join(', ')})` : ''}`);
      });
      if (f.diff === 'changed') items.unshift(`  - Changed the flow's settings`);
      flows.push(`- **${name}** (${where})`, ...items);
    }
    for (const g of c.globals) if (g.diff) flows.push(`- Global **${g.label}** (${c.path.replace(MULE_DIR, '')}): ${g.diff}`);
  }
  if (flows.length) out.push('### Flows', ...flows, '');

  const dwl = [...d.dwl].filter(([, s]) => s !== 'dependency');
  if (dwl.length) out.push('### DataWeave', ...dwl.map(([p, s]) => `- \`${p}\` ${s}`), '');

  const props = [...d.props].flatMap(([key, changes]) => changes.map((c) => `- \`${key}\` in ${c.file.split('/').pop()}: ${value(key, c.before)} → ${value(key, c.after)}`));
  if (props.length) out.push('### Properties', ...props, '');

  if (libraries.length) out.push('### Libraries', ...libraries.map((l) => `- ${l.artifactId} ${l.from} → ${l.to}${l.flows.length ? `: changes ${l.flows.map((f) => `**${f}**`).join(', ')}` : ''}`), '');

  if (commits.length) out.push(`### Commits (${commits.length})`, ...commits.map((c) => `- ${c.short} ${c.subject} (${c.author})`), '');
  if (out.length === 2) out.push('No changes to flows, DataWeave or properties.');
  return out.join('\n').trimEnd();
}

/** Full-window view of the notes with a copy button. */
export function openNotes(markdown, title = 'Release notes') {
  const copy = h('button', {
    onclick: async () => {
      try { await navigator.clipboard.writeText(markdown); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
      setTimeout(() => { copy.textContent = 'Copy Markdown'; }, 1600);
    },
  }, 'Copy Markdown');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', keys, true); };
  const keys = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const backdrop = h('div.diff-modal-backdrop', { onmousedown: (e) => { if (e.target === backdrop) close(); } },
    h('div.diff-modal.notes-modal',
      h('div.diff-modal-head', h('span.diff-modal-title', title), h('span.spacer'), copy, h('button.close', { title: 'Close (Esc)', onclick: close }, '×')),
      h('pre.notes-body.mono', markdown)));
  document.body.append(backdrop);
  document.addEventListener('keydown', keys, true);
}
