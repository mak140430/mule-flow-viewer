// GitHub (github.com) as a `host` for git-host.js. GitHub's API ignores the browser's sign-in, so private
// repositories (and more than 60 requests an hour) need a token the user creates once: read-only, kept in this
// browser's extension storage and sent only to api.github.com.

import { limiter, politely, isSha, branchIn, segmentsOf } from './git-host.js';

const enc = encodeURIComponent;
const RESERVED = new Set(['settings', 'orgs', 'organizations', 'marketplace', 'explore', 'topics', 'notifications', 'login',
  'new', 'sponsors', 'features', 'enterprise', 'pricing', 'search', 'collections', 'trending', 'apps', 'codespaces', 'pulls', 'issues']);
export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** {owner, repo, rest, url} of a repository page on github.com, or null. */
export function githubRepo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'github.com') return null;
  const segs = segmentsOf(u);
  if (segs.length < 2 || RESERVED.has(segs[0].toLowerCase())) return null;
  return { owner: segs[0], repo: segs[1].replace(/\.git$/, ''), rest: segs.slice(2), url };
}

const needToken = (why) => Object.assign(new Error(why), { code: 'token', site: 'github.com', tokenUrl: TOKEN_URL });

/** opts: {fetch, token, apiOrigin (tests), limit} */
export function githubHost(loc, { fetch: rawFetch = globalThis.fetch.bind(globalThis), token = '', apiOrigin = '', limit = limiter(8) } = {}) {
  const fetch = politely(rawFetch);
  const api = apiOrigin || 'https://api.github.com';
  const base = `${api}/repos/${enc(loc.owner)}/${enc(loc.repo)}`;
  const trees = new Map();

  async function call(url, { raw = false, missing = false, top = 0, method = 'GET', body } = {}) {
    const out = [];
    let next = url;
    while (next) {
      const r = await limit(() => fetch(next, {
        method, body, credentials: 'omit',
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }));
      if (r.status === 404 && missing) return null;
      if (r.status === 401) throw needToken('The GitHub token was refused (expired or revoked). Enter a new one.');
      if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
        throw needToken(token ? 'GitHub\'s hourly limit for this token is used up; try again later.' : 'GitHub allows 60 requests an hour without a token. A read-only token raises that to 5,000.');
      }
      if (r.status === 404 && !token) throw needToken('This repository is private, or GitHub needs a token to show it.');
      if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${next.replace(api, '')}`);
      if (raw) return r.text();
      const data = await r.json();
      if (!top) return data;
      out.push(...data);
      next = out.length < top ? /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1] : null;
    }
    return out.slice(0, top);
  }

  async function graphql(query, variables) {
    const r = await call(`${api}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }) });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return r.data;
  }

  const fullTree = (sha) => {
    if (!trees.has(sha)) {
      const p = call(`${base}/git/trees/${sha}?recursive=1`).then((t) => (t.tree || []).filter((x) => x.type === 'blob').map((x) => ({ path: x.path, id: x.sha })));
      p.catch(() => trees.delete(sha));
      trees.set(sha, p);
    }
    return trees.get(sha);
  };
  const subject = (m) => (m || '').split('\n')[0];

  return {
    key: `github|${loc.owner}/${loc.repo}`,
    name: loc.repo,
    pageBranch: (names) => (['blob', 'tree', 'commits'].includes(loc.rest[0]) ? branchIn(loc.rest.slice(1), names) : ''),

    async refs() {
      const info = await call(base);
      if (token) {
        // with a token: branches with their dates in one query (for most-recent-first lists)
        const branches = [];
        let after = null;
        do {
          const d = await graphql(`query($o:String!,$r:String!,$a:String){repository(owner:$o,name:$r){refs(refPrefix:"refs/heads/",first:100,after:$a){
            pageInfo{hasNextPage endCursor} nodes{name target{oid ... on Commit{committedDate}}}}}}`, { o: loc.owner, r: loc.repo, a: after });
          const refs = d.repository.refs;
          branches.push(...refs.nodes.map((n) => ({ name: n.name, sha: n.target.oid, date: n.target.committedDate || '' })));
          after = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
        } while (after);
        const tags = await call(`${base}/tags?per_page=100`, { top: 1000 });
        return { default: info.default_branch, branches, tags: tags.map((t) => ({ name: t.name, sha: t.commit.sha })) };
      }
      const [branches, tags] = await Promise.all([call(`${base}/branches?per_page=100`, { top: 1000 }), call(`${base}/tags?per_page=100`, { top: 1000 })]);
      return {
        default: info.default_branch,
        branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha, date: '' })),
        tags: tags.map((t) => ({ name: t.name, sha: t.commit.sha })),
      };
    },

    async tree(sha, dir) {
      return (await fullTree(sha)).filter((f) => !dir || f.path.startsWith(`${dir}/`));
    },

    blob: (id) => call(`${base}/git/blobs/${id}`, { raw: true }),

    async item(sha, path) {
      if (trees.has(sha)) return (await fullTree(sha)).find((f) => f.path === path)?.id ?? null;
      const r = await call(`${base}/contents/${path.split('/').map(enc).join('/')}?ref=${sha}`, { missing: true });
      return r && !Array.isArray(r) && r.type === 'file' ? r.sha : null;
    },

    async commit(sha) {
      const c = await call(`${base}/commits/${sha}`);
      return {
        parents: (c.parents || []).map((p) => p.sha),
        author: c.commit?.author?.name || '',
        date: c.commit?.author?.date || '',
        subject: subject(c.commit?.message),
        changes: (c.files || []).map((f) => ({
          path: f.filename,
          status: f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M',
          after: f.status === 'removed' ? null : f.sha || undefined,
          ...(f.status === 'added' ? { before: null } : {}),
        })),
      };
    },

    async commits(rev, path, top) {
      const list = await call(`${base}/commits?sha=${enc(rev)}${path ? `&path=${enc(path)}` : ''}&per_page=${Math.min(100, top)}`, { top });
      return list.map((c) => ({ sha: c.sha, author: c.commit?.author?.name || '', date: c.commit?.author?.date || '', subject: subject(c.commit?.message) }));
    },

    async mergeBase(a, b) {
      return (await call(`${base}/compare/${a}...${b}?per_page=1`)).merge_base_commit?.sha || null;
    },

    async pullRequest() {
      if (loc.rest[0] !== 'pull' || !/^\d+$/.test(loc.rest[1] || '')) return null;
      const p = await call(`${base}/pulls/${loc.rest[1]}`);
      // a fork's branch is not in this repository
      return p.head?.repo?.full_name === p.base?.repo?.full_name ? { source: p.head.ref, target: p.base.ref } : { source: '', target: p.base.ref };
    },

    async sibling(name) {
      const r = await call(`${api}/repos/${enc(loc.owner)}/${enc(name)}`, { missing: true }).catch(() => null);
      return r ? githubHost({ ...loc, repo: r.name, rest: [], url: '' }, { fetch: rawFetch, token, apiOrigin, limit }) : null;
    },

    async repos() {
      const list = await call(`${api}/orgs/${enc(loc.owner)}/repos?per_page=100`, { top: 1000, missing: true }).catch(() => null)
        ?? await call(`${api}/users/${enc(loc.owner)}/repos?per_page=100`, { top: 1000 });
      return (list || []).filter((r) => !r.archived).map((r) => ({
        name: r.name, url: r.html_url, defaultBranch: r.default_branch,
        open: () => githubHost({ ...loc, repo: r.name, rest: [], url: '' }, { fetch: rawFetch, token, apiOrigin, limit }),
      }));
    },
  };
}
