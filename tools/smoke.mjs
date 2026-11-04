// Loads a Mule project from disk through the core and prints what the viewer would see.
// Usage: node tools/smoke.mjs /path/to/mule-project
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadProject } from '../src/core/project.js';
import { walkFlow } from '../src/core/model.js';

const root = process.argv[2];
const SKIP = new Set(['.git', 'target', 'node_modules', '.mule', '.idea', '.vscode']);

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(relative(root, full));
  }
  return out;
}

const adapter = { list: () => walk(root), read: (p) => readFile(join(root, p), 'utf8') };
const catalog = JSON.parse(await readFile(new URL('../catalog/connectors.json', import.meta.url), 'utf8').catch(() => '{"connectors":{}}'));

const t0 = performance.now();
const project = await loadProject(adapter, catalog);
const ms = (performance.now() - t0).toFixed(0);

const kinds = {};
let unknownSources = 0;
for (const c of project.configs) for (const f of c.flows) {
  kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  walkFlow(f, (p) => { kinds[p.kind] = (kinds[p.kind] || 0) + 1; });
  if (f.kind === 'flow' && !f.source && f.processors[0]) unknownSources++;
}
const unresolvedRefs = [...project.callers.keys()].filter((n) => !project.flows.has(n));
const missingDwl = [...project.dwlUsers.keys()].filter((p) => !project.dwl.has(p));
const missingImports = [...project.dwlImporters.keys()].filter((p) => !project.dwl.has(p));

console.log({
  ms: Number(ms),
  files: project.texts.size,
  configs: project.configs.length,
  errors: project.errors,
  kinds,
  flowsWithoutSource: unknownSources,
  callers: project.callers.size,
  unresolvedRefs,
  dwl: project.dwl.size,
  dwlUsed: project.dwlUsers.size,
  missingDwl,
  dwlImportEdges: [...project.dwlImporters].map(([k, v]) => `${v.join(',')} -> ${k}`),
  missingImports,
  environments: project.environments,
  sampleProperty: project.resolveProperty('cron.contractData', project.environments[0]),
});
