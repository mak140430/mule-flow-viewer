// Every feature's core against a running server, as the viewer calls it (no browser needed):
//   node tools/e2e_core.mjs <base> <token> <page url>
// or read straight from the code host, as the extension does for Azure DevOps (api origin: a stand-in such as
// tools/mock_azure.py; without it, the real site):
//   node tools/e2e_core.mjs --remote <page url> [api origin]
// It loads the project, its branches and history, and runs the diff, merge preview, element history, blame,
// branch grid, test inputs, search, release notes, libraries, link locating and DataWeave paths.

const remote = process.argv[2] === '--remote';
const [base, token, page] = remote ? [null, null, process.argv[3]] : process.argv.slice(2);
const apiOrigin = remote ? process.argv[4] || '' : '';
const { fileURLToPath } = await import('node:url');
const root = fileURLToPath(new URL('..', import.meta.url));     // paths with spaces, Windows drives
const im = (p) => import(new URL(`../${p}`, import.meta.url));
const { devServerAdapter } = await im('src/adapters/dev-server.js');
const { remoteAdapter } = await im('src/adapters/remote.js');
const { loadProject } = await im('src/core/project.js');
const { diffProjects } = await im('src/core/diff.js');
const { FileVersions, nodeKey } = await im('src/core/element-history.js');
const { defaultColumns, gridRows } = await im('src/core/branch-grid.js');
const { testSamples } = await im('src/core/chain.js');
const { releaseNotes } = await im('src/core/notes.js');
const { Libraries } = await im('src/core/libraries.js');
const { locate } = await im('src/core/locate.js');
const { impact } = await im('src/core/impact.js');
const { entryPoints, outboundCalls, errorsOf } = await im('src/core/surface.js');
const { envMatrix } = await im('src/core/env-matrix.js');
const { readFileSync } = await import('node:fs');

// requests each step makes (a code host's limits are per hour)
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { requests++; return realFetch(...args); };

const results = [];
async function step(name, fn) {
  const t = Date.now();
  const n = requests;
  try {
    const detail = await fn();
    results.push(true);
    console.log(`ok  ${name}${detail ? `  (${detail})` : ''}  ${Date.now() - t} ms${remote ? `, ${requests - n} requests` : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`BAD ${name}: ${e.stack || e}`);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const catalog = JSON.parse(readFileSync(`${root}catalog/connectors.json`, 'utf8'));
const adapter = remote ? await remoteAdapter(page, { apiOrigin }) : await devServerAdapter('', { base, token });
must(adapter, remote ? 'no reader for this page' : 'the server did not answer /api/project');
let live, branches, history, diff, mergeDiff = null;

await step('project loads', async () => {
  live = await loadProject(adapter, catalog);
  must(live.flows.size > 0, 'no flows');
  return `${live.configs.length} files, ${live.flows.size} flows, ${live.tests?.length || 0} MUnit tests, ${live.errors.length} parse errors`;
});
await step('branches', async () => {
  branches = await adapter.branches();
  must(branches.branches.length > 0, 'no branches');
  must(Object.keys(branches.tips).length >= branches.branches.length, 'tips missing');
  return `current ${branches.current || '(detached)'}, default ${branches.default}, ${branches.branches.length} branches, ${branches.tags.length} tags`;
});
await step('history', async () => {
  history = await adapter.history();
  must(history.commits.length > 0, 'no commits');
  return `${history.commits.length} commits, merge base ${history.mergeBase ? 'yes' : 'none'}`;
});
const at = async (rev) => loadProject(await adapter.at(rev), catalog);
await step('commit diff', async () => {
  const c = history.commits.find((x) => x.parents.length === 1) || history.commits[0];
  diff = diffProjects(await at(c.parents[0]), await at(c.sha));
  return `${c.short}: ${diff.files.length} files changed`;
});
await step('merge preview (branch vs HEAD since they split)', async () => {
  const other = branches.branches.find((b) => b !== branches.current && branches.tips[b] !== history.head);
  if (!other) return 'only one branch';
  const mb = await adapter.mergeBase(history.head, branches.tips[other]);
  must(mb, 'no merge base');
  const [b0, b1, b2] = await Promise.all([at(mb), at(branches.tips[other]), at(history.head)]);
  const d = diffProjects(b0, b1);
  diffProjects(b0, b2);
  mergeDiff = d;
  return `${other}: ${[...d.byId.values()].filter((e) => e.item.diff && e.item.diff !== 'inner').length} elements changed there`;
});
await step('impact of that branch (entry points it reaches)', async () => {
  if (!mergeDiff) return 'no other branch';
  const r = impact(mergeDiff);
  return `${r.entries.length} entry points, ${r.unreached.length} unreached changes, ${r.properties.length} properties, ${r.dependencies.length} dependencies`;
});
await step('entry points, their errors, what the app calls', async () => {
  const entries = entryPoints(live);
  const rows = entries.slice(0, 5).flatMap((e) => errorsOf(live, e));
  const calls = outboundCalls(live);
  return `${entries.length} entry points (${entries.filter((e) => e.kind === 'api').length} API resources), ${rows.length} error rows on the first 5, ${calls.length} outbound configurations`;
});
await step('properties per environment', async () => {
  const m = envMatrix(live);
  return `${m.rows.length} keys × ${m.columns.length} environments, ${m.rows.filter((r) => r.problems.some((p) => p.severity !== 'info')).length} to fix`;
});
const file = live.configs.find((c) => c.flows.length)?.path;
await step('element history and blame', async () => {
  const fv = new FileVersions(await adapter.versions(file), live.configFor(file).source);
  const nodes = [...fv.live.byKey.values()];
  const key = nodeKey(nodes.find((n) => n.attrs['doc:id']) || nodes.find((n) => n.attrs.name) || nodes[0]);   // files without doc:id too
  const h = fv.history([key]);
  const blame = fv.blame();
  must(blame.size > 0, 'blame empty');
  return `${file}: ${h.commits.length} changes, ${h.branches.length} branches differ, ${blame.size} elements blamed`;
});
await step('branch grid', async () => {
  const cols = defaultColumns(branches).slice(0, 3);
  if (cols.length < 2) return 'fewer than two branches';
  const rows = gridRows(await Promise.all(cols.map(async (name) => ({ name, project: await at(branches.tips[name]) }))));
  return `${cols.join(', ')}: ${rows.length} rows`;
});
await step('MUnit test inputs reach elements', async () => {
  if (!live.tests?.length) return 'no MUnit tests in this project';
  let reached = 0;
  let tried = 0;
  for (const { item, flow } of live.byId.values()) {
    if (item === flow || item.key !== 'ee:transform' || tried >= 20) continue;
    tried++;
    if (testSamples(live, [{ processor: item, flow }]).length) reached++;
  }
  return `${reached}/${tried} transforms reached by a test`;
});
await step('search every branch', async () => {
  const flowName = [...live.flows.keys()][0];
  const r = await adapter.search(flowName.slice(0, 20));
  must(r.hits.length > 0, `no hits for ${flowName}`);
  return `${r.hits.length} lines`;
});
await step('release notes', async () => {
  const commits = (await adapter.log(history.commits.at(-1).sha, history.head)).commits;
  const md = releaseNotes(diff, { title: 'test', commits: commits.slice(0, 5) });
  must(md.startsWith('## test'), 'no title');
  return `${md.split('\n').length} lines, ${commits.length} commits in log`;
});
await step(`shared libraries (from ${remote ? 'their own repositories' : 'the Maven repository, if any'})`, async () => {
  const libs = await adapter.libraries();
  const flows = await new Libraries(adapter, catalog).flows();
  const found = libs.filter((l) => l.available);
  const versions = found.length ? await adapter.libraryVersions(found[0].groupId, found[0].artifactId) : [];
  return `${libs.length} plugins in pom.xml, ${found.map((l) => `${l.artifactId} ${l.version}`).join(', ') || 'none'} found, ${flows.size} library flows${versions.length ? `, ${versions.length} versions of ${found[0].artifactId}` : ''}`;
});
await step("library versions across the owner's apps", async () => {
  if (!adapter.libraryMap) return 'not on this host';
  const libs = await adapter.libraryMap();
  return libs.slice(0, 3).map((l) => `${l.artifactId}: ${l.apps.length} apps, newest ${l.newest}`).join('; ') || 'no shared libraries';
});
await step('link from the page', async () => {
  const r = await locate({ url: page }, { files: live.allPaths, branches: branches.branches, read: adapter.read });
  must(r.path, 'no file found in the URL');
  return `${r.path}${r.lines ? ` lines ${r.lines.join('-')}` : ''}${r.branch ? ` on ${r.branch}` : ''}`;
});
await step('DataWeave engine', async () => {
  const engine = await adapter.dataweave();
  if (!engine) return 'no DataWeave CLI: the Run blocks stay hidden';
  const r = await engine.run({ script: '%dw 2.0\noutput application/json\n---\n{a: 1 + 1}', modules: {}, properties: {}, inputs: {} });
  must(r.ok, r.error);
  return `CLI ${engine.version}: ${r.output.replace(/\s+/g, '')}`;
});
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
