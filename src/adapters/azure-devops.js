// Azure DevOps (dev.azure.com and *.visualstudio.com) as a `host` for git-host.js: its REST API (7.1) with the
// browser's own sign-in. The extension has host permission for these sites, so its requests carry the user's
// session like the site's own pages do; nothing is stored or sent anywhere else.

import { limiter, politely, limited, isSha } from './git-host.js';

const enc = encodeURIComponent;

/** {origin, org, project, repo, url} of a repository page, or null for any other page. */
export function azureRepo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  let origin;
  let rest;
  if (u.hostname === 'dev.azure.com') {
    if (!segs.length) return null;
    origin = `${u.origin}/${enc(segs[0])}`;
    rest = segs.slice(1);
  } else if (u.hostname.endsWith('.visualstudio.com')) {
    const collection = segs[0]?.toLowerCase() === 'defaultcollection';
    origin = `${u.origin}${collection ? '/DefaultCollection' : ''}`;
    rest = segs.slice(collection ? 1 : 0);
  } else {
    return null;
  }
  const i = rest.indexOf('_git');
  if (i < 0 || !rest[i + 1]) return null;
  const repo = rest[i + 1];
  return { origin, project: i > 0 ? rest[i - 1] : repo, repo, url };
}

const signIn = (origin) => Object.assign(new Error(`Sign in to Azure DevOps in this browser (${origin.replace(/^https?:\/\//, '')}), then open the page again.`), { code: 'sign-in' });

/**
 * loc: azureRepo()'s answer. opts.fetch: the fetch to use (tests); opts.apiOrigin: another server for the same API
 * (tests' stand-in for dev.azure.com).
 */
export function azureHost(loc, { fetch: rawFetch = globalThis.fetch.bind(globalThis), apiOrigin = '', limit = limiter(10), orgRepos } = {}) {
  const fetch = politely(rawFetch);
  const origin = apiOrigin || loc.origin;
  const project = `${origin}/${enc(loc.project)}`;
  const base = `${project}/_apis/git/repositories/${enc(loc.repo)}`;
  orgRepos ??= { list: null };

  async function call(url, params = {}, { raw = false, missing = false, all = false } = {}) {
    const query = Object.entries({ ...params, 'api-version': '7.1' }).filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    const out = [];
    let token = '';
    do {
      const r = await limit(() => fetch(`${url}?${query}${token ? `&continuationToken=${enc(token)}` : ''}`, {
        credentials: 'include',
        headers: { Accept: raw ? 'application/octet-stream' : 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
      }));
      if (r.status === 404 && missing) return null;
      if (r.status === 429) throw limited(r, 'Azure DevOps', '');
      // signed out: 401, or a sign-in page (203, or HTML) in place of JSON
      if (r.status === 401 || r.status === 203 || (r.ok && !raw && !/json/i.test(r.headers.get('content-type') || ''))) throw signIn(loc.origin);
      if (!r.ok) throw new Error(`Azure DevOps answered ${r.status} for ${url.replace(origin, '')}`);
      if (raw) return r.text();
      const body = await r.json();
      if (!all) return body;
      out.push(...(body.value || []));
      token = r.headers.get('x-ms-continuationtoken') || '';
    } while (token);
    return out;
  }

  const version = (rev) => ({ 'versionDescriptor.version': rev, 'versionDescriptor.versionType': isSha(rev) ? 'commit' : 'branch' });
  const subject = (c) => (c.comment || '').split('\n')[0];
  const branchName = (ref) => (ref || '').replace(/^refs\/heads\//, '');
  const page = new URL(loc.url || 'https://x/');
  const versionParam = page.searchParams.get('version') || '';

  return {
    key: `azure|${loc.origin}|${loc.project}|${loc.repo}`,
    name: loc.repo,
    pageBranch: versionParam.startsWith('GB') ? versionParam.slice(2) : '',

    async refs() {
      const [info, heads, tags, stats] = await Promise.all([
        call(base),
        call(`${base}/refs`, { filter: 'heads/' }, { all: true }),
        call(`${base}/refs`, { filter: 'tags/', peelTags: 'true' }, { all: true }),
        call(`${base}/stats/branches`).then((b) => b.value || []).catch((e) => { if (e.code === 'sign-in') throw e; return []; }),
      ]);
      const stat = new Map(stats.map((s) => [s.name, s]));
      return {
        default: branchName(info.defaultBranch),
        branches: heads.map((h) => {
          const name = branchName(h.name);
          const s = stat.get(name);
          return { name, sha: h.objectId, date: s?.commit?.committer?.date || s?.commit?.author?.date || '', ahead: s?.aheadCount ?? 0 };
        }),
        tags: tags.map((t) => ({ name: t.name.replace(/^refs\/tags\//, ''), sha: t.peeledObjectId || t.objectId })),
      };
    },

    async tree(sha, dir) {
      const r = await call(`${base}/items`, { scopePath: `/${dir}`, recursionLevel: 'Full', ...version(sha) }, { missing: true });
      return (r?.value || []).filter((i) => i.gitObjectType === 'blob').map((i) => ({ path: i.path.slice(1), id: i.objectId }));
    },

    blob: (id) => call(`${base}/blobs/${id}`, { $format: 'octetstream' }, { raw: true }),

    async item(sha, path) {
      const r = await call(`${base}/items`, { path: `/${path}`, ...version(sha) }, { missing: true });
      return r && r.gitObjectType !== 'tree' && !r.isFolder ? r.objectId : null;
    },

    async commit(sha) {
      const c = await call(`${base}/commits/${sha}`, { changeCount: 2000 });
      return {
        parents: c.parents || [],
        author: c.author?.name || '',
        date: c.author?.date || '',
        subject: subject(c),
        changes: (c.changes || []).filter((x) => x.item && !x.item.isFolder && x.item.gitObjectType !== 'tree').map((x) => ({
          path: x.item.path.slice(1),
          before: /add/i.test(x.changeType) ? null : x.item.originalObjectId || null,
          after: /delete/i.test(x.changeType) ? null : x.item.objectId || null,
        })),
      };
    },

    async commits(rev, path, top) {
      const r = await call(`${base}/commits`, {
        'searchCriteria.itemVersion.version': rev,
        'searchCriteria.itemVersion.versionType': isSha(rev) ? 'commit' : 'branch',
        'searchCriteria.itemPath': path ? `/${path}` : '',
        'searchCriteria.$top': top,
      });
      return (r.value || []).map((c) => ({ sha: c.commitId, author: c.author?.name || '', date: c.author?.date || '', subject: subject(c) }));
    },

    async mergeBase(a, b) {
      const r = await call(`${base}/commits/${a}/mergebases`, { otherCommitId: b });
      return r.value?.[0]?.commitId || null;
    },

    async pullRequest() {
      const id = /\/pullrequest\/(\d+)/i.exec(page.pathname)?.[1];
      if (!id) return null;
      const r = await call(`${base}/pullRequests/${id}`);
      return { source: branchName(r.sourceRefName), target: branchName(r.targetRefName) };
    },

    /** The organization's other repositories (for "used by"). */
    async repos() {
      orgRepos.list ??= call(`${origin}/_apis/git/repositories`).then((r) => r.value || []).catch(() => []);
      return (await orgRepos.list).filter((r) => !r.isDisabled && r.defaultBranch).map((r) => ({
        name: r.name, url: r.webUrl, defaultBranch: branchName(r.defaultBranch),
        open: () => azureHost({ ...loc, project: r.project.name, repo: r.name, url: '' }, { fetch: rawFetch, apiOrigin, limit, orgRepos }),
      }));
    },

    /** Repository `name` in the same project, else anywhere in the organization. */
    async sibling(name) {
      const same = await call(`${project}/_apis/git/repositories/${enc(name)}`, {}, { missing: true });
      let found = same ? { project: loc.project, repo: same.name } : null;
      if (!found) {
        orgRepos.list ??= call(`${origin}/_apis/git/repositories`).then((r) => r.value || []).catch(() => []);
        const r = (await orgRepos.list).find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (r) found = { project: r.project.name, repo: r.name };
      }
      return found ? azureHost({ ...loc, ...found, url: '' }, { fetch: rawFetch, apiOrigin, limit, orgRepos }) : null;
    },
  };
}
