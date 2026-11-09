// A repository read straight from its code host's web API with the browser's own sign-in: no clone, no git, no
// helper, no local Maven repository. Same contract as dev-server.js. All that is host-specific is a small `host`
// (azure-devops.js):
//   key                          a stable name for the cache
//   refs()                       -> {default, branches: [{name, sha, date, ahead?}], tags: [{name, sha}]}
//   tree(sha, dir)               -> [{path, id}]: the files under dir (repo-relative paths), id = blob id
//   blob(id)                     -> text
//   item(sha, path)              -> blob id, or null where the file is absent
//   commit(sha)                  -> {parents, author, date, subject, changes: [{path, before?, after?, status?}]}: blob ids,
//                                   null where absent; left out, they are looked up (item at the parent and at the commit)
//   commits(rev, path, top)      -> [{sha, author, date, subject}], newest first, touching path ('' = any)
//   mergeBase(a, b)              -> sha or null
//   pullRequest()                -> {source, target} of the page's pull request, or null
//   pageBranch(names)            the branch the page's URL names (of these; names may hold slashes), or ''
//   sibling(name)                -> the host of repository `name` next to this one, or null
//   repos()                      -> [{name, url}]: the other repositories of the same owner / project (for "used by")
// Commits, trees and blobs never change, so they are kept in Cache Storage: a second look costs no requests.

const HISTORY_PATHS = ['src/main/mule', 'src/main/resources', 'pom.xml'];
const SEARCH_PATHS = ['src/main', 'src/test', 'pom.xml'];
const BINARY = /\.(jar|zip|gz|tgz|png|jpe?g|gif|ico|pdf|class|p12|jks|keystore|pfx|der|bin|exe|dll|so)$/i;
const MULESOFT = /^(org\.mule|com\.mulesoft)(\.|$)/;
const MAX_HITS = 500;
const MAX_TEXTS = 400;

const join = (dir, p) => (dir && p ? `${dir}/${p}` : dir || p);
const within = (dir, p) => !dir || p === dir || p.startsWith(`${dir}/`);
const rel = (dir, p) => (dir ? p.slice(dir.length + 1) : p);
const SHA = /^[0-9a-f]{40}$/i;
export const isSha = (s) => SHA.test(s || '');

// ------------------------------------------------------------------ caching

const memory = new Map();
let store;
const cacheStore = () => (store ??= globalThis.caches?.open('mfv-git-v1').catch(() => null) ?? Promise.resolve(null));

/** Remember an immutable value under key (a host that gets file texts in bulk hands them over this way). */
export function keep(key, value) {
  memory.set(key, Promise.resolve(value));
  cacheStore().then((c) => c?.put(`https://cache.mfv/${encodeURIComponent(key)}`, new Response(JSON.stringify(value)))).catch(() => {});
}

/** make()'s answer for an immutable key: from memory, else Cache Storage, else made (and kept). */
export function kept(key, make) {
  if (!memory.has(key)) {
    const p = (async () => {
      const c = await cacheStore();
      const req = `https://cache.mfv/${encodeURIComponent(key)}`;
      const hit = await c?.match(req).catch(() => null);
      if (hit) return hit.json();
      const value = await make();
      c?.put(req, new Response(JSON.stringify(value))).catch(() => {});
      return value;
    })();
    p.catch(() => memory.delete(key));
    memory.set(key, p);
  }
  return memory.get(key);
}

/** At most n calls at a time (a code host throttles bursts). */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ------------------------------------------------------------------ one repository, cached

/** The host's calls with caching, plus the Mule application's folder at a commit. */
export function reader(host) {
  let refs = null;
  const k = (...parts) => `${host.key}|${parts.join('|')}`;
  const r = {
    host,
    refs: () => (refs ??= host.refs().catch((e) => { refs = null; throw e; })),
    tree: (sha, dir = '') => kept(k('tree', sha, dir), () => host.tree(sha, dir)),
    blob: (id) => kept(k('blob', id), () => host.blob(id)),
    item: (sha, path) => kept(k('item', sha, path), () => host.item(sha, path)),
    commit: (sha) => kept(k('commit', sha), () => host.commit(sha)),
    commits: (rev, path = '', top = 300) => (isSha(rev)
      ? kept(k('commits', rev, path, top), () => host.commits(rev, path, top))
      : host.commits(rev, path, top)),
    async mergeBase(a, b) {
      if (!a || !b) return null;
      if (a === b) return a;
      return kept(k('base', ...[a, b].sort()), async () => {
        try {
          return await host.mergeBase(a, b);
        } catch {
          // (some hosts want a sign-in for this one call even on public repositories)
          // the newest commit of b that a also has, from both histories
          const [ca, cb] = await Promise.all([r.commits(a, '', 1000), r.commits(b, '', 1000)]);
          const inA = new Set(ca.map((c) => c.sha));
          return cb.find((c) => inA.has(c.sha))?.sha || null;
        }
      });
    },
    /** The Mule application's folder at a commit ('' = the repository itself), or null without one. */
    app: (sha, url = '') => kept(k('app', sha, url), async () => muleApp((await r.tree(sha, '')).map((f) => f.path), url)),
  };
  return r;
}

/** The Mule application among a repository's files: its own folder, or the one (of several) the page names. */
export function muleApp(paths, url = '') {
  const apps = paths.filter((p) => p === 'pom.xml' || p.endsWith('/pom.xml'))
    .map((p) => p.slice(0, -'pom.xml'.length).replace(/\/$/, ''))
    .filter((d) => d.split('/').length <= 3 && paths.some((p) => p.startsWith(join(d, 'src/main/mule/'))));
  if (!apps.length) return null;
  let page = url;
  try { page = decodeURIComponent(url); } catch { /* as it is */ }
  const named = apps.filter((a) => a && page.includes(`/${a}/`));
  return (named.length ? named : apps).reduce((a, b) => ((named.length ? b.length > a.length : b.length < a.length) ? b : a));
}

// ------------------------------------------------------------------ pom.xml

const tag = (xml, name) => (new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml) || [])[1] || '';

/** groupId, version, parent, properties and mule-plugin dependencies of a pom.xml (no XML parser: runs anywhere). */
export function parsePom(text) {
  const xml = (text || '').replace(/<!--[\s\S]*?-->/g, '');
  const parentXml = (/<parent>([\s\S]*?)<\/parent>/.exec(xml) || [])[1] || '';
  const own = xml.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<(dependencies|dependencyManagement|build|profiles|properties|parent)>[\s\S]*?<\/\1>/g, '');
  const properties = {};
  for (const [, name, value] of ((/<properties>([\s\S]*?)<\/properties>/.exec(xml) || [])[1] || '').matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) {
    properties[name] = value;
  }
  const deps = [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map(([, d]) => ({
    groupId: tag(d, 'groupId'), artifactId: tag(d, 'artifactId'), version: tag(d, 'version'), classifier: tag(d, 'classifier'),
  }));
  const parent = parentXml ? { groupId: tag(parentXml, 'groupId'), artifactId: tag(parentXml, 'artifactId'), version: tag(parentXml, 'version') } : null;
  return {
    groupId: tag(own, 'groupId') || parent?.groupId || '',
    artifactId: tag(own, 'artifactId'),
    version: tag(own, 'version') || parent?.version || '',
    parent, properties, deps,
  };
}

const versionKey = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? [0, Number(p), ''] : [1, 0, p]));
export function compareVersions(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || [-1, 0, ''];
    const q = y[i] || [-1, 0, ''];
    if (p[0] !== q[0]) return p[0] - q[0];
    if (p[1] !== q[1]) return p[1] - q[1];
    if (p[2] !== q[2]) return p[2] < q[2] ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------ libraries, from their own repositories

/**
 * A shared library read from its source: the repository named like the library next to this one, at the commit
 * whose pom.xml has that version (a tag of that version first). Exactly what its jar was built from, with the same
 * sign-in as the project, so no Maven repository is needed.
 */
function libraryRepos(host) {
  const repos = new Map();     // artifactId -> Promise<reader | null>
  const releases = new Map();  // artifactId -> Promise<[{version, sha}]> newest first
  const repo = (a) => {
    if (!repos.has(a)) repos.set(a, Promise.resolve(host.sibling?.(a)).then((h) => (h ? reader(h) : null)).catch(() => null));
    return repos.get(a);
  };
  /**
   * Each version the library's pom.xml has had, with the newest commit that had it: tags first, then the default
   * branch, then the other branches, newest first (a version is often published from a branch never merged).
   */
  const versionsOf = (a) => {
    if (!releases.has(a)) {
      releases.set(a, (async () => {
        const rd = await repo(a);
        if (!rd) return [];
        const refs = await rd.refs();
        const branches = [...refs.branches].sort((x, y) => (x.name === refs.default ? -1 : y.name === refs.default ? 1
          : (y.date || '').localeCompare(x.date || '')));
        if (!branches.length) return [];
        const app = (await rd.app(branches[0].sha)) ?? '';
        const pom = join(app, 'pom.xml');
        const lists = await Promise.all(branches.map((b, i) => rd.commits(b.sha, pom, i ? 50 : 200).catch(() => [])));
        const commits = [...new Map(lists.flat().map((c) => [c.sha, c])).values()];
        const read = await Promise.all(commits.map(async (c) => {
          const id = await rd.item(c.sha, pom).catch(() => null);
          return { sha: c.sha, version: id ? parsePom(await rd.blob(id).catch(() => '')).version : '' };
        }));
        const seen = new Map();
        for (const t of refs.tags) {
          const v = t.name.replace(/^(.*[-/])?v?(?=\d)/, '');
          if (/^\d/.test(v) && !seen.has(v)) seen.set(v, t.sha);
        }
        for (const { version, sha } of read) if (version && !seen.has(version)) seen.set(version, sha);
        return [...seen].map(([version, sha]) => ({ version, sha }));
      })().catch(() => []));
    }
    return releases.get(a);
  };
  const at = async (a, v) => {
    const rd = await repo(a);
    const hit = (await versionsOf(a)).find((r) => r.version === v);
    return rd && hit ? { rd, sha: hit.sha, app: (await rd.app(hit.sha)) ?? '' } : null;
  };
  return {
    repo,
    async available(g, a) { return !MULESOFT.test(g) && !!(await repo(a)); },
    async pom(a, v) {
      const lib = await at(a, v);
      const id = lib && await lib.rd.item(lib.sha, join(lib.app, 'pom.xml'));
      return id ? lib.rd.blob(id) : null;
    },
    async files(a, v) {
      const lib = await at(a, v);
      if (!lib) throw new Error(`${a} ${v}: not found`);
      const mule = join(lib.app, 'src/main/mule');
      const res = join(lib.app, 'src/main/resources');
      // laid out as in the jar: flows and DataWeave at its root
      const wanted = (await lib.rd.tree(lib.sha, lib.app)).flatMap((f) => (within(mule, f.path) && f.path.endsWith('.xml') ? [[rel(mule, f.path), f.id]]
        : within(res, f.path) && f.path.endsWith('.dwl') ? [[rel(res, f.path), f.id]] : []));
      return Object.fromEntries(await Promise.all(wanted.map(async ([p, id]) => [p, await lib.rd.blob(id)])));
    },
    async versions(a) {
      return (await versionsOf(a)).map((r) => r.version).sort(compareVersions);
    },
  };
}

// ------------------------------------------------------------------ dependencies with their versions

/**
 * A pom's dependencies with their versions filled in: from its properties and its parent's, and the versions the
 * parent manages (dependencyManagement) where the pom names none. parentPom(artifactId, version) -> text | null.
 */
export async function resolvedDeps(pom, parentPom) {
  let props = { ...pom.properties, 'project.groupId': pom.groupId, 'project.version': pom.version };
  let managed = new Map();
  if (pom.parent && parentPom && pom.deps.some((d) => !d.version || /\$\{/.test(d.version))) {
    const parent = parsePom(await Promise.resolve(parentPom(pom.parent.artifactId, pom.parent.version)).catch(() => null));
    props = { ...parent.properties, ...props };
    managed = new Map(parent.deps.filter((d) => d.version).map((d) => [d.artifactId, d.version]));
  }
  const fill = (v) => (v || '').replace(/\$\{([^}]+)\}/g, (all, k) => props[k] ?? all);
  return pom.deps.map((d) => {
    const artifactId = fill(d.artifactId);
    return { ...d, groupId: fill(d.groupId), artifactId, version: fill(d.version || managed.get(artifactId) || managed.get(d.artifactId) || '') };
  });
}

// ------------------------------------------------------------------ used by: who calls a library's flows

/** [caller flow, called flow] for every flow-ref in a Mule XML file (no parser: read in bulk across repositories). */
export function flowRefsIn(text) {
  const out = [];
  let current = null;
  for (const m of (text || '').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:[\w-]+:)?(flow-ref|sub-flow|flow)(?=[\s/>])[^>]*?\sname\s*=\s*"([^"]*)"/g)) {
    if (m[1] === 'flow-ref') { if (current && !m[2].startsWith('#[')) out.push([current, m[2]]); } else current = m[2];
  }
  return out;
}

/**
 * The repositories of the same owner (organization, group, workspace), each with its pom.xml: read from its default
 * branch, or where that has none (some keep only a README there) from its newest branches that have one. Read once
 * for every question about them (who calls a library's flow, which library versions each app uses).
 */
function ownerRepos(host, parentPom) {
  let list = null;
  const poms = new Map();
  return {
    list: () => (list ??= Promise.resolve().then(() => host.repos?.()).catch(() => []).then((l) => (l || []).filter((r) => r.defaultBranch))),
    /** {rd, other, rev, branch, pom, deps (versions filled in)} | null */
    pomOf(r) {
      if (!poms.has(r.name)) {
        poms.set(r.name, (async () => {
          const other = r.open();
          const rd = reader(other);
          let rev = r.defaultBranch;
          let branch = r.defaultBranch;
          let pomId = await other.item(rev, 'pom.xml');
          if (!pomId) {
            const refs = await rd.refs();
            const newest = refs.branches.filter((b) => b.name !== r.defaultBranch).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
            for (const b of newest) {
              pomId = await rd.item(b.sha, 'pom.xml').catch(() => null);
              if (pomId) { rev = b.sha; branch = b.name; break; }
            }
          }
          if (!pomId) return null;
          const pom = parsePom(await rd.blob(pomId));
          return { rd, other, rev, branch, pom, deps: await resolvedDeps(pom, parentPom) };
        })().catch(() => null));
      }
      return poms.get(r.name);
    },
  };
}

/**
 * The apps of the same owner that depend on library `artifactId`, each with the version it uses and which of its
 * flows call which of the library's: [{name, url, branch, version, calls: Map(flow -> [{caller, file}])}].
 */
function usageOf(owner) {
  const found = new Map();
  return (artifactId) => {
    if (!found.has(artifactId)) {
      found.set(artifactId, (async () => {
        const list = (await owner.list()).filter((r) => r.name.toLowerCase() !== artifactId.toLowerCase());
        const apps = await Promise.all(list.map(async (r) => {
          try {
            const at = await owner.pomOf(r);
            const dep = at?.deps.find((d) => d.artifactId === artifactId);
            if (!dep) return null;
            const files = (await (at.rev === r.defaultBranch ? at.other.tree(at.rev, '') : at.rd.tree(at.rev, ''))).filter((f) => /(^|\/)src\/main\/mule\/.+\.xml$/.test(f.path));
            const calls = new Map();
            await Promise.all(files.map(async (f) => {
              for (const [caller, target] of flowRefsIn(await at.rd.blob(f.id).catch(() => ''))) {
                if (!calls.has(target)) calls.set(target, []);
                calls.get(target).push({ caller, file: f.path });
              }
            }));
            return { name: r.name, url: r.url, branch: at.branch, version: dep.version, calls };
          } catch {
            return null;
          }
        }));
        return apps.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      })());
    }
    return found.get(artifactId);
  };
}

/**
 * Every shared library of the owner (a dependency named like one of its repositories) with the apps that use it:
 * [{artifactId, url, newest (the highest release any app uses), apps: [{name, url, branch, version}]}], the most
 * used first.
 */
function libraryMapOf(owner) {
  let result = null;
  return () => (result ??= (async () => {
    const list = await owner.list();
    const byName = new Map(list.map((r) => [r.name.toLowerCase(), r]));
    const read = await Promise.all(list.map(async (r) => ({ r, at: await owner.pomOf(r) })));
    const libs = new Map();
    for (const { r, at } of read) {
      for (const d of at?.deps || []) {
        const repo = byName.get(d.artifactId.toLowerCase());
        if (!repo || repo === r) continue;
        if (!libs.has(d.artifactId)) libs.set(d.artifactId, { artifactId: d.artifactId, url: repo.url, apps: [] });
        libs.get(d.artifactId).apps.push({ name: r.name, url: r.url, branch: at.branch, version: d.version });
      }
    }
    for (const lib of libs.values()) {
      const released = lib.apps.map((a) => a.version).filter((v) => /^\d/.test(v) && !/SNAPSHOT/i.test(v)).sort(compareVersions);
      lib.newest = released.pop() || null;
      lib.apps.sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
    }
    return [...libs.values()].sort((a, b) => b.apps.length - a.apps.length || a.artifactId.localeCompare(b.artifactId));
  })().catch((e) => { result = null; throw e; }));
}

// ------------------------------------------------------------------ the adapter

/**
 * The viewer's adapter for a repository on a code host. Opens on the branch the page shows (a pull request's
 * source, the branch in the URL), else the default branch. Throws with code 'no-mule' when there is no Mule app.
 * opts: {url (the page), dataweave: () => engine | null (the optional local helper's)}
 */
export async function gitHostAdapter(host, { url = '', dataweave = async () => null } = {}) {
  const rd = reader(host);
  const libs = libraryRepos(host);
  // a parent pom, read like a library: from its own repository, at its version
  const parentPom = (a, v) => libs.pom(a, v);
  const owner = host.repos ? ownerRepos(host, parentPom) : null;
  const usedBy = owner ? usageOf(owner) : null;
  const libraryMap = owner ? libraryMapOf(owner) : null;
  const [refs, pr] = await Promise.all([rd.refs(), host.pullRequest().catch(() => null)]);
  const names = new Set(refs.branches.map((b) => b.name));
  const pageBranch = typeof host.pageBranch === 'function' ? host.pageBranch([...names]) : host.pageBranch;
  const current = [pr?.source, pageBranch, refs.default].find((n) => n && names.has(n)) || refs.branches[0]?.name || '';
  const tips = {};
  for (const t of refs.tags) tips[t.name] = t.sha;
  for (const b of refs.branches) tips[b.name] = b.sha;
  const order = [...refs.branches].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((b) => b.name);
  const head = tips[current];
  if (!head) throw Object.assign(new Error('The repository has no branches yet.'), { code: 'empty' });
  const app = await rd.app(head, url);
  if (app == null) throw Object.assign(new Error(`${current} has no Mule application (a pom.xml with src/main/mule).`), { code: 'no-mule' });
  const name = app ? app.split('/').pop() : host.name;

  /** A commit's change to one file, with its blob ids (looked up where the host does not give them). */
  async function changeOf(sha, d, path) {
    const x = d.changes.find((c) => c.path === path);
    if (!x) return null;
    const before = x.before !== undefined ? x.before : x.status === 'A' || !d.parents[0] ? null : await rd.item(d.parents[0], path).catch(() => null);
    const after = x.after !== undefined ? x.after : x.status === 'D' ? null : await rd.item(sha, path).catch(() => null);
    return { before, after };
  }
  const statusOf = (x) => x.status || (x.before === null ? 'A' : x.after === null ? 'D' : 'M');

  /** A commit from a rev: '' / HEAD (the branch shown), a branch or tag, a sha; ^ and ~N walk first parents. */
  async function resolve(rev) {
    if (!rev || rev === 'HEAD') return head;
    const m = /^(.+?)(\^|~(\d*))?$/.exec(rev);
    let sha = tips[m[1]] || (m[1] === 'HEAD' ? head : m[1]);
    let n = m[2] ? (m[2] === '^' ? 1 : Number(m[3] || 1)) : 0;
    while (n-- > 0 && sha) sha = (await rd.commit(sha)).parents[0] || null;
    return sha;
  }

  async function history(paths = [], ref = '') {
    const at = await resolve(ref);
    const lists = await Promise.all((paths.length ? paths : HISTORY_PATHS).map((p) => rd.commits(at, join(app, p), 300).catch(() => [])));
    const bySha = new Map(lists.flat().map((c) => [c.sha, c]));
    const list = [...bySha.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300);
    // parents and files of the newest (what gets opened); an older one finds its parent when opened (sha^)
    const detailed = await Promise.all(list.slice(0, 40).map((c) => rd.commit(c.sha).catch(() => null)));
    const commits = list.map((c, i) => {
      const d = detailed[i];
      return {
        sha: c.sha, short: c.sha.slice(0, 7), author: c.author, date: c.date, subject: c.subject,
        parents: d ? d.parents : [`${c.sha}^`],
        files: (d?.changes || []).filter((x) => within(app, x.path))
          .map((x) => ({ status: statusOf(x), path: rel(app, x.path) })),
      };
    });
    const branch = ref || current;
    const mergeBase = branch !== refs.default && tips[refs.default] ? await rd.mergeBase(tips[refs.default], at).catch(() => null) : null;
    let ahead = refs.branches.find((b) => b.name === branch)?.ahead;
    if (ahead == null) {
      // the host does not count them: the branch's commits down to where it split from the default branch
      const all = mergeBase ? await rd.commits(at, '', 500).catch(() => []) : [];
      const i = all.findIndex((c) => c.sha === mergeBase);
      ahead = i < 0 ? 0 : i;
    }
    return { dirty: false, head: at, mergeBase: mergeBase === at ? null : mergeBase, commits, defaultHead: tips[refs.default], ahead };
  }

  /** A branch's commits to this app, newest first (300 at most): who and when, for the Commits overview. */
  async function commitsOn(ref = '') {
    const at = await resolve(ref);
    const list = await rd.commits(at, app, 300);
    return { commits: list.map((c) => ({ sha: c.sha, author: c.author, date: c.date })), capped: list.length >= 300 };
  }

  async function versions(path) {
    const full = join(app, path);
    const others = order.filter((n) => n !== current);
    const lists = await Promise.all([current, ...others].map((n, i) => rd.commits(tips[n], full, i ? 30 : 300).catch(() => [])));
    const onHead = new Set(lists[0].map((c) => c.sha));
    const found = new Map();
    [current, ...others].forEach((n, i) => { for (const c of lists[i]) if (!found.has(c.sha)) found.set(c.sha, { ...c, source: n }); });
    const picked = [...found.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
    const details = await Promise.all(picked.map((c) => rd.commit(c.sha).catch(() => null)));
    const changes = await Promise.all(picked.map((c, i) => (details[i] ? changeOf(c.sha, details[i], full) : null)));
    const commits = picked.flatMap((c, i) => {
      const d = details[i];
      if (!d) return [];
      const change = changes[i];
      return [{
        sha: c.sha, short: c.sha.slice(0, 7), author: c.author, date: c.date, parents: d.parents, subject: c.subject,
        onHead: onHead.has(c.sha), source: c.source, before: change ? change.before : null, after: change ? change.after : null,
      }];
    });
    const headBlob = await rd.item(head, full);
    const branches = await Promise.all(order.map(async (n) => {
      const sha = tips[n];
      if (sha === head) return { name: n, sha, blob: headBlob, base: { sha: head, blob: headBlob } };
      const [blob, base] = await Promise.all([rd.item(sha, full).catch(() => null), rd.mergeBase(head, sha).catch(() => null)]);
      return { name: n, sha, blob, base: { sha: base, blob: base ? await rd.item(base, full).catch(() => null) : null } };
    }));
    const ids = [...new Set([headBlob, ...branches.flatMap((b) => [b.blob, b.base.blob]), ...commits.flatMap((c) => [c.before, c.after])].filter(Boolean))];
    const texts = Object.fromEntries(await Promise.all(ids.slice(0, MAX_TEXTS).map(async (id) => [id, await rd.blob(id).catch(() => null)])));
    return { head: { sha: head, blob: headBlob }, branches, commits, texts };
  }

  /** The files a search reads: each distinct version of a file on any branch tip, with the branches that have it. */
  let searchFiles = null;
  const filesToSearch = () => (searchFiles ??= (async () => {
    const files = new Map();    // id|path -> {id, path, refs}
    const scopes = SEARCH_PATHS.map((p) => join(app, p));
    await Promise.all(order.map(async (n) => {
      for (const f of await rd.tree(tips[n], app).catch(() => [])) {
        if (BINARY.test(f.path) || !scopes.some((s) => within(s, f.path))) continue;
        const key = `${f.id}|${f.path}`;
        if (!files.has(key)) files.set(key, { id: f.id, path: rel(app, f.path), refs: [] });
        files.get(key).refs.push(n);
      }
    }));
    return files;
  })().catch((e) => { searchFiles = null; throw e; }));

  /**
   * Reads ahead, in the background and a few at a time, what a search of every branch needs, so the first search
   * is answered at once. Kept by commit and file id (in Cache Storage too), so a later visit reads only what is
   * new. Where the host counts requests per hour (GitHub, GitLab) it stops after a share of them.
   */
  let warming = null;
  function warm() {
    return (warming ??= (async () => {
      const files = await filesToSearch();
      const gentle = limiter(3);
      const budget = /github|gitlab/.test(host.key || '') ? 400 : Infinity;
      const ids = [...new Set([...files.values()].map((f) => f.id))].slice(0, budget);
      // a hidden tab waits: nothing is read for a page nobody is looking at
      const visible = () => new Promise((r) => {
        if (!globalThis.document?.hidden) return r();
        globalThis.document.addEventListener('visibilitychange', function on() { if (!document.hidden) { document.removeEventListener('visibilitychange', on); r(); } });
      });
      await Promise.all(ids.map((id) => gentle(async () => { await visible(); await rd.blob(id).catch(() => null); })));
      return ids.length;
    })().catch(() => { warming = null; return 0; }));
  }

  /** Lines containing q (any case) on every branch tip; each distinct version of a file is read once. */
  async function search(q) {
    const files = await filesToSearch();
    const needle = q.toLowerCase();
    const hits = new Map();
    await Promise.all([...files.values()].map(async ({ id, path, refs: on }) => {
      const text = await rd.blob(id).catch(() => '');
      if (!text.toLowerCase().includes(needle)) return;
      text.split('\n').forEach((line, i) => {
        if (!line.toLowerCase().includes(needle)) return;
        const key = `${path}\n${line.trim()}`;
        if (!hits.has(key)) hits.set(key, { path, line: i + 1, text: line.trim().slice(0, 300), refs: new Set() });
        on.forEach((r) => hits.get(key).refs.add(r));
      });
    }));
    const sorted = [...hits.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    for (const h of sorted) h.refs = order.filter((n) => h.refs.has(n));
    return { hits: sorted.slice(0, MAX_HITS), truncated: sorted.length > MAX_HITS };
  }

  /** Commits `to` has that `from` does not. */
  async function log(from, to) {
    const [a, b] = await Promise.all([resolve(from).then((s) => rd.commits(s, app, 500)), resolve(to).then((s) => rd.commits(s, app, 500))]);
    const inA = new Set(a.map((c) => c.sha));
    return { commits: b.filter((c) => !inA.has(c.sha)).map((c) => ({ ...c, short: c.sha.slice(0, 7) })) };
  }

  function make(rev) {
    let files = null;
    const filesAt = () => (files ??= resolve(rev).then(async (sha) => {
      if (!sha) return new Map();
      return new Map((await rd.tree(sha, app)).map((f) => [rel(app, f.path), f.id]));
    }));
    const read = async (path) => {
      const id = (await filesAt()).get(path);
      if (!id) throw new Error(`${path}: not found`);
      return rd.blob(id);
    };
    return {
      name,
      repo: host.name,
      rev,
      remote: true,
      pullRequest: pr?.source && pr?.target ? pr : null,
      list: async () => [...(await filesAt()).keys()].sort(),
      read,
      branches: async () => ({ current, default: refs.default, branches: order, tags: refs.tags.map((t) => t.name), tips }),
      history,
      commitsOn,
      versions,
      search,
      warm,
      log,
      mergeBase: (a, b) => rd.mergeBase(a, b),
      async libraries() {
        const pom = parsePom(await read('pom.xml').catch(() => ''));
        const deps = await resolvedDeps(pom, parentPom);
        return Promise.all(deps.filter((d) => d.classifier === 'mule-plugin').map(async (d) => {
          const lib = { groupId: d.groupId, artifactId: d.artifactId, version: d.version };
          return { ...lib, available: await libs.available(lib.groupId, lib.artifactId) };
        }));
      },
      library: (g, a, v) => libs.files(a, v),
      // apps of the same owner that use library a (this project, or one of its libraries), and how
      usedBy: usedBy ? async (a) => usedBy(a) : undefined,
      // the owner's shared libraries and the version each of its apps uses
      libraryMap: libraryMap || undefined,
      libraryVersions: (g, a) => libs.versions(a),
      at: async (other) => make(other),
      dataweave,
    };
  }
  return make('');
}

/** The branch a URL's segments start with (branch names may hold slashes: the longest that exists), or ''. */
export function branchIn(segs, names) {
  const known = new Set(names);
  for (let n = segs.length; n > 0; n--) {
    const name = segs.slice(0, n).join('/');
    if (known.has(name)) return name;
  }
  return '';
}

/** Path segments of a URL, decoded. */
export function segmentsOf(u) {
  return u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

/** fetch that waits and tries again (up to 4 times) when a host says "too many requests" or "busy" for a moment. */
export function politely(fetch) {
  return async (url, init) => {
    for (let i = 0; ; i++) {
      const r = await fetch(url, init);
      const after = Number(r.headers.get('retry-after'));
      // a long wait asked for is the host's limit for the hour: say so rather than hang
      if (![429, 502, 503].includes(r.status) || i >= 4 || after > 20) return r;
      await new Promise((ok) => setTimeout(ok, (after > 0 ? after : 2 ** i) * 1000));
    }
  };
}

/** The error for a host that is limiting requests: when to try again, and how to get a higher limit. */
export function limited(r, site, signedIn) {
  const after = Number(r.headers.get('retry-after'));
  const wait = after > 0 ? ` Try again in ${Math.max(1, Math.round(after / 60))} min.` : ' Try again in a few minutes.';
  return Object.assign(new Error(`${site} is limiting requests from this computer.${wait}${signedIn}`), { code: 'limited' });
}
