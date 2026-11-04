// Bitbucket Cloud (bitbucket.org) as a `host` for git-host.js: the API the site's own pages use (bitbucket.org/!api),
// with the browser's sign-in. Bitbucket names no file ids, so a commit's files come from its zip download (one
// request) and are given git's own ids here: what is the same on two branches is read and kept once.

import { limiter, politely, limited, keep, kept, isSha, branchIn, segmentsOf } from './git-host.js';
import { unzip, gitBlobId } from './zip.js';

const enc = encodeURIComponent;
const RESERVED = new Set(['account', 'dashboard', 'repo', 'snippets', 'site', 'product', 'workspace', 'socialauth']);

/** {workspace, repo, rest, url} of a repository page on bitbucket.org, or null. */
export function bitbucketRepo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'bitbucket.org') return null;
  const segs = segmentsOf(u);
  if (segs.length < 2 || RESERVED.has(segs[0].toLowerCase())) return null;
  return { workspace: segs[0], repo: segs[1].replace(/\.git$/, ''), rest: segs.slice(2), url };
}

const signIn = () => Object.assign(new Error('Sign in to Bitbucket in this browser (bitbucket.org), then open the page again.'), { code: 'sign-in' });
const decoder = new TextDecoder();

/** opts: {fetch, apiOrigin (tests: serves both /!api/2.0 and the zip downloads), limit} */
export function bitbucketHost(loc, { fetch: rawFetch = globalThis.fetch.bind(globalThis), apiOrigin = '', limit = limiter(6) } = {}) {
  const fetch = politely(rawFetch);
  const site = apiOrigin || 'https://bitbucket.org';
  const api = `${site}/!api/2.0`;
  const base = `${api}/repositories/${enc(loc.workspace)}/${enc(loc.repo)}`;
  const web = `${site}/${enc(loc.workspace)}/${enc(loc.repo)}`;
  const key = `bitbucket|${loc.workspace}/${loc.repo}`;
  const zips = new Map();      // sha -> Promise<[{path, id}]>

  async function call(url, { raw = false, missing = false, all = false, bytes = false } = {}) {
    const out = [];
    let next = url;
    while (next) {
      const r = await limit(() => fetch(next, { credentials: 'include', headers: { Accept: raw || bytes ? '*/*' : 'application/json' } }));
      if (r.status === 404 && missing) return null;
      if (r.status === 429) throw limited(r, 'Bitbucket', ' Signed in to bitbucket.org, the limit is higher.');
      if (r.status === 401 || r.status === 403 || (r.status === 404 && url === base)) throw signIn();
      if (!r.ok) throw new Error(`Bitbucket answered ${r.status} for ${next.replace(site, '')}`);
      if (bytes) return r.arrayBuffer();
      if (raw) return r.text();
      const data = await r.json();
      if (!all) return data;
      out.push(...(data.values || []));
      next = data.next || null;
    }
    return out;
  }

  /** A file's content handed to the cache under its git id. */
  async function stash(data) {
    const id = await gitBlobId(data);
    keep(`${key}|blob|${id}`, decoder.decode(data));
    return id;
  }

  /** Every file of a commit, from its zip (the archive's top folder stripped), each kept by its git id. */
  const files = (sha) => {
    if (!zips.has(sha)) {
      const read = async () => {
        const entries = await unzip(await call(`${web}/get/${enc(sha)}.zip`, { bytes: true }));
        return Promise.all(entries.map(async (e) => ({ path: e.name.replace(/^[^/]*\//, ''), id: await stash(e.data) })));
      };
      // a commit's files never change; a branch's do (only kept for this page)
      const p = isSha(sha) ? kept(`${key}|zip|${sha}`, read) : read();
      p.catch(() => zips.delete(sha));
      zips.set(sha, p);
    }
    return zips.get(sha);
  };
  const subject = (m) => (m || '').split('\n')[0];
  const authorOf = (c) => c.author?.user?.display_name || (c.author?.raw || '').replace(/\s*<.*>$/, '');

  return {
    key,
    name: loc.repo,
    pageBranch: (names) => (loc.rest[0] === 'src' ? branchIn(loc.rest.slice(1), names) : loc.rest[0] === 'branch' ? loc.rest.slice(1).join('/') : ''),

    async refs() {
      const [info, branches, tags] = await Promise.all([
        call(base), call(`${base}/refs/branches?pagelen=100`, { all: true }), call(`${base}/refs/tags?pagelen=100`, { all: true }),
      ]);
      return {
        default: info.mainbranch?.name || '',
        branches: branches.map((b) => ({ name: b.name, sha: b.target.hash, date: b.target.date || '' })),
        tags: tags.map((t) => ({ name: t.name, sha: t.target.hash })),
      };
    },

    async tree(sha, dir) {
      return (await files(sha)).filter((f) => !dir || f.path.startsWith(`${dir}/`));
    },

    // texts arrive with their commit's zip (or one file at a time below), so a miss means the cache was cleared
    blob: async (id) => { throw new Error(`file ${id.slice(0, 7)} is no longer cached: reload the page`); },

    async item(sha, path) {
      if (zips.has(sha)) return (await files(sha)).find((f) => f.path === path)?.id ?? null;
      // (git-host.js caches the answer)
      const data = await call(`${base}/src/${sha}/${path.split('/').map(enc).join('/')}`, { bytes: true, missing: true });
      return data ? stash(new Uint8Array(data)) : null;
    },

    async commit(sha) {
      const [c, stat] = await Promise.all([call(`${base}/commit/${sha}`), call(`${base}/diffstat/${sha}?pagelen=500`, { all: true })]);
      return {
        parents: (c.parents || []).map((p) => p.hash),
        author: authorOf(c),
        date: c.date || '',
        subject: subject(c.message),
        changes: stat.map((s) => ({
          path: (s.new || s.old).path,
          status: s.status === 'added' ? 'A' : s.status === 'removed' ? 'D' : 'M',
          ...(s.status === 'added' ? { before: null } : {}),
          ...(s.status === 'removed' ? { after: null } : {}),
        })),
      };
    },

    async commits(rev, path, top) {
      const out = [];
      let next = `${base}/commits/${enc(rev)}?pagelen=100${path ? `&path=${enc(path)}` : ''}`;
      while (next && out.length < top) {
        const page = await call(next);
        out.push(...(page.values || []));
        next = page.next || null;
      }
      return out.slice(0, top).map((c) => ({ sha: c.hash, author: authorOf(c), date: c.date || '', subject: subject(c.message) }));
    },

    async mergeBase(a, b) {
      return (await call(`${base}/merge-base/${a}..${b}`)).hash || null;
    },

    async pullRequest() {
      if (loc.rest[0] !== 'pull-requests' || !/^\d+$/.test(loc.rest[1] || '')) return null;
      const p = await call(`${base}/pullrequests/${loc.rest[1]}`);
      const same = p.source?.repository?.full_name === p.destination?.repository?.full_name;
      return { source: same ? p.source.branch.name : '', target: p.destination.branch.name };
    },

    async sibling(name) {
      const r = await call(`${api}/repositories/${enc(loc.workspace)}/${enc(name)}`, { missing: true }).catch(() => null);
      return r ? bitbucketHost({ ...loc, repo: r.slug || name, rest: [], url: '' }, { fetch: rawFetch, apiOrigin, limit }) : null;
    },

    async repos() {
      const list = await call(`${api}/repositories/${enc(loc.workspace)}?pagelen=100`, { all: true });
      return list.map((r) => ({
        name: r.slug, url: r.links?.html?.href || `https://bitbucket.org/${r.full_name}`, defaultBranch: r.mainbranch?.name || '',
        open: () => bitbucketHost({ ...loc, repo: r.slug, rest: [], url: '' }, { fetch: rawFetch, apiOrigin, limit }),
      }));
    },
  };
}
