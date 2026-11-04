// Where a code-host page points in a project, from what any browser page has: its URL and the selected text.
// No per-host rules: the URL is matched against the project's own file paths and branch names (known from the
// local clone), so GitHub, GitLab, Bitbucket, Azure DevOps or a self-hosted server all work the same way.

const SEP = /[/?#&=,;:\s]/;
const ends = (s, i) => i >= s.length || SEP.test(s[i]);
// a match starts at a separator, or after a short type tag some hosts glue on (`version=GBmain`)
function starts(s, i) {
  let k = i;
  while (k > 0 && !SEP.test(s[k - 1])) k--;
  return k === i || /^[A-Z]{1,3}$/.test(s.slice(k, i));
}

/** Longest candidate that appears in text as a whole token; returns [candidate, index] or null. */
function longest(text, candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c || (best && c.length <= best[0].length)) continue;
    let i = text.indexOf(c);
    while (i >= 0 && !(starts(text, i) && ends(text, i + c.length))) i = text.indexOf(c, i + 1);
    if (i >= 0) best = [c, i];
  }
  return best;
}

/**
 * Line range in a URL: `#L20-L25`, `#L20-25`, `#lines-20:25`, `line=20&lineEnd=25`, `?line=20`...
 * Only numbers attached to a "line"/"L" token count, so ids and page numbers are ignored.
 */
export function urlLines(url) {
  const u = new URL(url);
  const params = new URLSearchParams(`${u.search.slice(1)}&${u.hash.slice(1).includes('=') ? u.hash.slice(1) : ''}`);
  const start = [...params].find(([k, v]) => /^(line|start_?line|linestart)$/i.test(k) && /^\d+$/.test(v));
  if (start) {
    const end = [...params].find(([k, v]) => /^(line_?end|end_?line|lineend)$/i.test(k) && /^\d+$/.test(v));
    return [+start[1], +(end?.[1] || start[1])].sort((a, b) => a - b);
  }
  const m = /(?:^|[^a-z])(?:L|lines?-?)(\d+)(?:[-:]L?(\d+))?/i.exec(u.hash.slice(1));
  return m ? [+m[1], +(m[2] || m[1])].sort((a, b) => a - b) : null;
}

/**
 * Lines of `text` that the selected text covers. Selections copied from code views carry extra
 * pieces (line numbers, +/- markers, wrapped gutters), so a selected line matches a file line it ends with.
 */
export function selectionLines(text, selection) {
  const file = text.split('\n').map((l) => l.trim());
  const sel = selection.split('\n').map((l) => l.trim()).filter((l) => l.length > 2);
  if (!sel.length) return null;
  const matches = (s, f) => f.length > 2 && (s === f || s.endsWith(f));
  let best = null;
  for (let i = 0; i < file.length; i++) {
    if (!matches(sel[0], file[i])) continue;
    // walk forward: every next selected line must match a later file line, close by
    let at = i;
    let hit = 1;
    for (const s of sel.slice(1)) {
      let j = at + 1;
      while (j < file.length && j - at <= 3 && !matches(s, file[j])) j++;
      if (j < file.length && matches(s, file[j])) { at = j; hit++; }
    }
    if (!best || hit > best.hit) best = { hit, from: i + 1, to: at + 1 };
    if (hit === sel.length) break;
  }
  return best && best.hit >= Math.ceil(sel.length / 2) ? [best.from, best.to] : null;
}

/**
 * repo: {files: [project paths], branches: [names], read?(path) -> text}
 * page: {url, selection?, text?}: text is what the page shows up top (title, headings), for pages whose URL
 * names no branch: a pull request's "feature/x into main".
 * Returns {path, branch, sha, lines, mentioned: [branch names in page.text, in order], pr: {source, target} | null}
 * (null where not found). A pull request is recognised by its branches written "source into target" (or with an
 * arrow), as code hosts show them in its header.
 */
export async function locate(page, repo) {
  const text = decodeURIComponent(page.url.replace(/\+/g, ' '));
  const file = longest(text, repo.files);
  // the file's path is not a branch name: search the rest of the URL
  const rest = file ? text.slice(0, file[1]) + text.slice(file[1] + file[0].length) : text;
  const short = repo.branches.map((b) => b.replace(/^origin\//, ''));
  const branch = longest(rest, short);
  const sha = branch ? null : /(?:^|[/=@])([0-9a-f]{40})(?=$|[/?#&])/.exec(rest)?.[1] || null;
  let lines = urlLines(page.url);
  if (!lines && page.selection && file && repo.read) lines = selectionLines(await repo.read(file[0]), page.selection);
  const full = (b) => repo.branches.find((x) => x === b) || repo.branches[short.indexOf(b)];
  const mentioned = [];
  for (let t = page.text || '', m; (m = longest(t, short));) {
    mentioned.push([m[1] + (page.text.length - t.length), full(m[0])]);
    t = t.slice(0, m[1]) + ' '.repeat(m[0].length) + t.slice(m[1] + m[0].length);
  }
  const ordered = mentioned.sort((a, b) => a[0] - b[0]);
  let pr = null;
  for (const [i, target] of ordered) {
    const before = (page.text || '').slice(Math.max(0, i - 12), i);
    if (!/(\binto|→|->|⟶)\s*['"`]?$/i.test(before)) continue;
    // the source is the other branch named nearest to "into"
    const others = ordered.filter(([, b]) => b !== target).sort((a, b) => Math.abs(a[0] - i) - Math.abs(b[0] - i));
    if (others.length) { pr = { source: others[0][1], target }; break; }
  }
  return {
    pr,
    mentioned: ordered.map(([, b]) => b),
    path: file?.[0] || null,
    branch: branch ? full(branch[0]) : null,
    sha,
    lines,
  };
}
