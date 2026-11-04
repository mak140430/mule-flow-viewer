// History of single XML elements: the commits that changed them and the branches whose copy differs.
// Elements are matched across versions by doc:id, a top-level name, else their place under the nearest of those.
// versions: adapter.versions(path) -> {head: {sha, blob}, commits: [{sha, ..., before, after}],
//   branches: [{name, sha, blob, base: {sha, blob}}], texts}; base is where the branch and HEAD split.

import { parseXml, sourceOf } from './xml.js';

/** Key of an element that survives edits around it. */
export function nodeKey(node) {
  if (node.attrs['doc:id']) return `id:${node.attrs['doc:id']}`;
  if (!node.parent) return 'root';
  if (!node.parent.parent && node.attrs.name) return `name:${node.local}:${node.attrs.name}`;
  const same = node.parent.children.filter((c) => c.qname === node.qname);
  return `${nodeKey(node.parent)}/${node.qname}[${same.indexOf(node)}]`;
}

/** One version of the file: its elements by key. Malformed versions have none. */
function indexOf(text) {
  const byKey = new Map();
  try {
    const { root } = parseXml(text);
    const visit = (n) => {
      const k = nodeKey(n);
      if (!byKey.has(k)) byKey.set(k, n);
      n.children.forEach(visit);
    };
    visit(root);
  } catch { /* a commit with broken XML */ }
  return { text, byKey };
}

// formatting and indentation are not changes
const norm = (s) => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

// elements drawn on their own: a flow or scope changes only when its own settings do, not when one inside it does
const CONTAINERS = new Set(['flow', 'sub-flow', 'when', 'otherwise', 'route', 'error-handler', 'on-error-continue', 'on-error-propagate']);
const nested = (c) => c.attrs['doc:id'] || CONTAINERS.has(c.local);
function own(n) {
  const attrs = Object.entries(n.attrs).filter(([k]) => k !== 'doc:id' && !k.startsWith('xmlns')).sort().join(' ');
  return `<${n.qname} ${attrs}>${norm(n.text)}${n.children.map((c) => (nested(c) ? `<${c.qname}/>` : own(c))).join('')}</>`;
}

export class FileVersions {
  constructor(versions, liveText) {
    this.v = versions;
    this.live = indexOf(liveText);
    this.indexes = new Map();
  }

  #index(blob) {
    if (!blob || this.v.texts[blob] == null) return null;
    if (!this.indexes.has(blob)) this.indexes.set(blob, indexOf(this.v.texts[blob]));
    return this.indexes.get(blob);
  }

  /** Normalized XML of each key in a version (null where the element is absent). */
  #texts(index, keys) {
    return keys.map((k) => {
      const n = index?.byKey.get(k);
      return n ? norm(sourceOf(n, index.text)) : null;
    });
  }

  /**
   * Last change of every element on this branch, by its own settings (blame): key -> commit, or 'uncommitted'.
   * Elements older than the commits sent (the file's last 300) are missing.
   */
  blame() {
    const out = new Map();
    const head = this.#index(this.v.head.blob);
    const ownOf = (index, k) => {
      const n = index?.byKey.get(k);
      return n ? own(n) : null;
    };
    const open = new Set();
    for (const [k, n] of this.live.byKey) {
      if (ownOf(head, k) !== own(n)) out.set(k, 'uncommitted');
      else open.add(k);
    }
    const byDate = (a, b) => new Date(b.date) - new Date(a.date);
    const onHead = this.v.commits.filter((c) => c.onHead && c.before !== c.after);
    // a merge only carries a change made elsewhere: the commit that made it comes first, merges only as a fallback
    const commits = [...onHead.filter((c) => c.parents.length < 2).sort(byDate), ...onHead.filter((c) => c.parents.length > 1).sort(byDate)];
    for (const c of commits) {
      if (!open.size) break;
      const before = this.#index(c.before);
      const after = this.#index(c.after);
      for (const k of [...open]) {
        if (ownOf(before, k) !== ownOf(after, k)) { out.set(k, c); open.delete(k); }
      }
    }
    return out;
  }

  /** Keys of the elements spanning exactly these line ranges of the live file. */
  keysAt(ranges) {
    const nodes = [...this.live.byKey.values()];
    return ranges.map(([from, to]) => nodes.find((n) => n.line === from && n.endLine === to)).filter(Boolean).map(nodeKey);
  }

  /**
   * {commits, branches, uncommitted} for the elements `keys`:
   * commits that changed them (one per change, a change merged into several branches counts once),
   * branches whose copy differs from HEAD's, and whether the live file differs from HEAD.
   * Each branch's `state` says which side changed the element since they split: 'ahead' (the branch did),
   * 'behind' (HEAD did; the branch has an older copy) or 'diverged' (both did: merging may conflict).
   */
  history(keys) {
    const live = this.#texts(this.live, keys);
    const head = this.#texts(this.#index(this.v.head.blob), keys);
    const same = (a, b) => a.every((t, i) => t === b[i]);
    const kind = (before, after) => (before.every((t) => t == null) ? 'added' : after.every((t) => t == null) ? 'removed' : 'changed');

    const changes = new Map();
    for (const c of this.v.commits) {
      if (c.before === c.after) continue;
      const before = this.#texts(this.#index(c.before), keys);
      const after = this.#texts(this.#index(c.after), keys);
      if (same(before, after)) continue;
      const id = JSON.stringify([before, after]);
      const seen = changes.get(id);
      // newest first: keep the oldest non-merge commit, where the change was made
      if (!seen || c.parents.length < 2 || seen.parents.length > 1) changes.set(id, { ...c, kind: kind(before, after), repeats: (seen?.repeats ?? -1) + 1 });
      else seen.repeats++;
    }
    const commits = [...changes.values()].sort((a, b) => new Date(b.date) - new Date(a.date));

    const branches = [];
    for (const b of this.v.branches) {
      const t = this.#texts(this.#index(b.blob), keys);
      if (same(t, head)) continue;
      const base = b.base?.sha ? this.#texts(this.#index(b.base.blob), keys) : null;
      const state = !base ? 'diverged' : same(t, base) ? 'behind' : same(head, base) ? 'ahead' : 'diverged';
      branches.push({ ...b, state, absent: t.every((x) => x == null) });
    }
    const uncommitted = !same(head, live);
    return { commits, branches, uncommitted };
  }
}
