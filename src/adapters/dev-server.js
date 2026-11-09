// Project served by tools/serve.py. Same contract as the git-platform adapters:
// list() -> repo-relative paths, read(path) -> text, and for version history
// branches() -> {current, default, branches}, history(paths?, ref?) -> {dirty, head, mergeBase, commits},
// at(rev) -> the same contract at that commit, versions(path) -> every version of one file (element-history.js),
// search(q) -> lines with q on every branch, log(from, to) -> commits between two points,
// libraries(rev?) / library(g, a, v) / libraryVersions(g, a) -> Mule plugins the project uses and their files,
// and dataweave() -> a local engine for runner.js.
// server: {base, token} for a server the extension's helper started (base 'http://127.0.0.1:PORT'); by default the
// page's own origin, as when serve.py serves the viewer.

export async function devServerAdapter(rev = '', server = {}) {
  const q = rev ? `rev=${encodeURIComponent(rev)}` : '';
  const base = server.base || '';
  const headers = server.token ? { 'X-MFV-Token': server.token } : {};
  const fetch = (url, init = {}) => globalThis.fetch(base + url, { ...init, headers: { ...headers, ...init.headers } });
  const getJson = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.split('?')[0]}: ${r.status}`);
    return r.json();
  };
  const res = await fetch(`/api/project?${q}`);
  if (!res.ok) return null;
  const { name, files } = await res.json();
  return {
    name,
    rev,
    list: async () => files,
    read: async (path) => {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}&${q}`);
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.text();
    },
    branches: async () => {
      const r = await fetch('/api/branches');
      return r.ok ? r.json() : { current: '', default: '', branches: [] };
    },
    history: async (paths = [], ref = '') => {
      const params = [...paths.map((p) => `path=${encodeURIComponent(p)}`), ref ? `ref=${encodeURIComponent(ref)}` : ''];
      const r = await fetch(`/api/history?${params.filter(Boolean).join('&')}`);
      return r.ok ? r.json() : { dirty: false, head: null, mergeBase: null, commits: [] };
    },
    commitsOn: async (ref = '') => {
      const r = await fetch(`/api/history${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      const commits = r.ok ? (await r.json()).commits : [];
      return { commits: commits.map((c) => ({ sha: c.sha, author: c.author, date: c.date })), capped: commits.length >= 300 };
    },
    versions: async (path) => {
      const r = await fetch(`/api/versions?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`History of ${path}: ${r.status}`);
      return r.json();
    },
    search: (text) => getJson(`/api/search?q=${encodeURIComponent(text)}`),
    log: (from, to) => getJson(`/api/log?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    mergeBase: (a, b) => getJson(`/api/merge-base?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`).then((r) => r.base),
    libraries: () => getJson(`/api/libraries?${q}`).then((r) => r.libraries),
    library: (g, a, v) => getJson(`/api/library?g=${encodeURIComponent(g)}&a=${encodeURIComponent(a)}&v=${encodeURIComponent(v)}`).then((r) => r.files),
    libraryVersions: (g, a) => getJson(`/api/library-versions?g=${encodeURIComponent(g)}&a=${encodeURIComponent(a)}`).then((r) => r.versions),
    at: (other) => devServerAdapter(other, server),
    dataweave: () => dataweaveEngine(fetch, base, server.token),
  };
}

/** The DataWeave engine of a server the helper started for it alone (repositories read without the helper). */
export function serverEngine({ base, token }) {
  const fetch = (url, init = {}) => globalThis.fetch(base + url, { ...init, headers: { 'X-MFV-Token': token, ...init.headers } });
  return dataweaveEngine(fetch, base, token);
}

/** The local DataWeave CLI behind serve.py, or null when it is not installed. */
async function dataweaveEngine(fetch, base, token) {
  const info = await fetch('/api/dw').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!info?.available) return null;
  return {
    version: info.version,
    async upload(file) {
      const ext = file.name.split('.').pop().toLowerCase();
      const r = await fetch(`/api/dw/input?ext=${encodeURIComponent(ext)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
      return (await r.json()).id;
    },
    async run(request) {
      const r = await fetch('/api/dw/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      if (!r.ok) throw new Error(`Run failed: ${r.status}`);
      return r.json();
    },
    // a download link carries no headers: the token goes in the query
    outputUrl: (id) => `${base}/api/dw/output?id=${encodeURIComponent(id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`,
  };
}
