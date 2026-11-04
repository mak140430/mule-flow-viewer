// GitLab (gitlab.com) as a `host` for git-host.js: its REST API (v4), which takes the browser's own sign-in
// (GitLab's session cookie) like the site's pages do.

import { limiter, politely, limited, branchIn, segmentsOf } from './git-host.js';

const enc = encodeURIComponent;
const RESERVED = new Set(['explore', 'users', 'dashboard', 'help', 'groups', 'projects', 'search', 'admin', 'profile', '-']);

/** {origin, path (group/sub/project), rest (after /-/), url} of a project page on gitlab.com, or null. */
export function gitlabRepo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'gitlab.com') return null;
  const segs = segmentsOf(u);
  const dash = segs.indexOf('-');
  const path = dash > 0 ? segs.slice(0, dash) : segs;
  if (path.length < 2 || RESERVED.has(path[0].toLowerCase())) return null;
  return { origin: u.origin, path: path.map((s) => s.replace(/\.git$/, '')).join('/'), rest: dash > 0 ? segs.slice(dash + 1) : [], url };
}

const signIn = () => Object.assign(new Error('Sign in to GitLab in this browser (gitlab.com), then open the page again.'), { code: 'sign-in' });

/** opts: {fetch, apiOrigin (tests), limit} */
export function gitlabHost(loc, { fetch: rawFetch = globalThis.fetch.bind(globalThis), apiOrigin = '', limit = limiter(8) } = {}) {
  const fetch = politely(rawFetch);
  const api = `${apiOrigin || loc.origin}/api/v4`;
  const base = `${api}/projects/${enc(loc.path)}`;
  const namespace = loc.path.split('/').slice(0, -1).join('/');

  async function call(url, { raw = false, missing = false, top = 0, head = false } = {}) {
    const out = [];
    let page = 1;
    for (;;) {
      const sep = url.includes('?') ? '&' : '?';
      const r = await limit(() => fetch(top ? `${url}${sep}page=${page}` : url, {
        method: head ? 'HEAD' : 'GET', credentials: 'include', headers: { Accept: raw ? '*/*' : 'application/json' },
      }));
      if (r.status === 404 && missing) return null;
      if (r.status === 429) throw limited(r, 'GitLab', ' Signed in to gitlab.com, the limit is much higher.');
      if (r.status === 401 || r.status === 403) throw signIn();
      // signed out, a private project is "not found"
      if (r.status === 404 && url === base) throw signIn();
      if (!r.ok) throw new Error(`GitLab answered ${r.status} for ${url.replace(api, '')}`);
      if (head) return r.headers;
      if (raw) return r.text();
      const data = await r.json();
      if (!top) return data;
      out.push(...data);
      const next = r.headers.get('x-next-page');
      if (!next || out.length >= top) return out.slice(0, top);
      page = Number(next);
    }
  }
  const subject = (c) => c.title || (c.message || '').split('\n')[0];

  return {
    key: `gitlab|${loc.origin}|${loc.path}`,
    name: loc.path.split('/').pop(),
    pageBranch: (names) => (['blob', 'tree', 'commits'].includes(loc.rest[0]) ? branchIn(loc.rest.slice(1), names) : ''),

    async refs() {
      const [info, branches, tags] = await Promise.all([
        call(base), call(`${base}/repository/branches?per_page=100`, { top: 2000 }), call(`${base}/repository/tags?per_page=100`, { top: 1000 }),
      ]);
      return {
        default: info.default_branch,
        branches: branches.map((b) => ({ name: b.name, sha: b.commit.id, date: b.commit.committed_date || '' })),
        tags: tags.map((t) => ({ name: t.name, sha: t.commit.id })),
      };
    },

    async tree(sha, dir) {
      const list = await call(`${base}/repository/tree?ref=${sha}&recursive=true&per_page=100${dir ? `&path=${enc(dir)}` : ''}`, { top: 20000, missing: true });
      return (list || []).filter((x) => x.type === 'blob').map((x) => ({ path: x.path, id: x.id }));
    },

    blob: (id) => call(`${base}/repository/blobs/${id}/raw`, { raw: true }),

    async item(sha, path) {
      const h = await call(`${base}/repository/files/${enc(path)}?ref=${sha}`, { head: true, missing: true });
      return h?.get('x-gitlab-blob-id') || null;
    },

    async commit(sha) {
      const [c, diff] = await Promise.all([call(`${base}/repository/commits/${sha}`), call(`${base}/repository/commits/${sha}/diff?per_page=100`, { top: 3000 })]);
      return {
        parents: c.parent_ids || [],
        author: c.author_name || '',
        date: c.authored_date || '',
        subject: subject(c),
        changes: diff.map((d) => ({
          path: d.new_path,
          status: d.new_file ? 'A' : d.deleted_file ? 'D' : 'M',
          ...(d.new_file ? { before: null } : {}),
          ...(d.deleted_file ? { after: null } : {}),
        })),
      };
    },

    async commits(rev, path, top) {
      const list = await call(`${base}/repository/commits?ref_name=${enc(rev)}${path ? `&path=${enc(path)}` : ''}&per_page=${Math.min(100, top)}`, { top });
      return list.map((c) => ({ sha: c.id, author: c.author_name || '', date: c.authored_date || '', subject: subject(c) }));
    },

    async mergeBase(a, b) {
      return (await call(`${base}/repository/merge_base?refs[]=${a}&refs[]=${b}`)).id || null;
    },

    async pullRequest() {
      if (loc.rest[0] !== 'merge_requests' || !/^\d+$/.test(loc.rest[1] || '')) return null;
      const m = await call(`${base}/merge_requests/${loc.rest[1]}`);
      return m.source_project_id === m.target_project_id ? { source: m.source_branch, target: m.target_branch } : { source: '', target: m.target_branch };
    },

    async sibling(name) {
      const r = await call(`${api}/projects/${enc(`${namespace}/${name}`)}`, { missing: true }).catch(() => null);
      return r ? gitlabHost({ ...loc, path: r.path_with_namespace, rest: [], url: '' }, { fetch: rawFetch, apiOrigin, limit }) : null;
    },

    async repos() {
      const list = await call(`${api}/groups/${enc(namespace)}/projects?include_subgroups=true&archived=false&per_page=100`, { top: 2000, missing: true })
        ?? await call(`${api}/users/${enc(namespace)}/projects?per_page=100`, { top: 1000, missing: true }) ?? [];
      return list.map((p) => ({
        name: p.path, url: p.web_url, defaultBranch: p.default_branch,
        open: () => gitlabHost({ ...loc, path: p.path_with_namespace, rest: [], url: '' }, { fetch: rawFetch, apiOrigin, limit }),
      }));
    },
  };
}
