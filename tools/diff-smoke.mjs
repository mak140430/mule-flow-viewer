// Diffs a Mule project between two commits through the core and prints what changed.
// Usage: node tools/diff-smoke.mjs /path/to/mule-project <rev> [<base rev>, default <rev>^]
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadProject } from '../src/core/project.js';
import { diffProjects } from '../src/core/diff.js';
import { walkFlow } from '../src/core/model.js';

const [root, rev, baseRev = `${rev}^`] = process.argv.slice(2);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const at = (r) => ({
  list: async () => git('ls-tree', '-r', '--name-only', r).split('\n').filter(Boolean),
  read: async (p) => git('show', `${r}:./${p}`),
});
const catalog = JSON.parse(await readFile(new URL('../catalog/connectors.json', import.meta.url), 'utf8'));

const t0 = performance.now();
const [base, head] = await Promise.all([loadProject(at(baseRev), catalog), loadProject(at(rev), catalog)]);
const t1 = performance.now();
const diff = diffProjects(base, head);
const t2 = performance.now();

console.log(`load ${(t1 - t0).toFixed(0)}ms, diff ${(t2 - t1).toFixed(1)}ms`);
console.log('files', diff.files.map((f) => `${f.status[0].toUpperCase()} ${f.path}`));
console.log('dwl', Object.fromEntries(diff.dwl), 'props', [...diff.props.keys()]);
for (const [path, c] of diff.configs) {
  if (!c.status && !c.textChanged) continue;
  console.log(`\n${path}: ${c.status}${c.textChanged ? '' : ' (indirect)'}`);
  for (const f of c.flows.filter((x) => x.diff)) {
    console.log(`  ${f.diff.padEnd(8)} ${f.name}`, JSON.stringify(f.counts));
    walkFlow(f, (p) => {
      if (p.diff && p.diff !== 'inner' && f.diff !== 'added' && f.diff !== 'removed') console.log(`      ${p.diff.padEnd(8)} ${p.label}${p.reasons?.length ? ` [${p.reasons.join(', ')}]` : ''}`);
    });
  }
  for (const g of c.globals.filter((x) => x.diff)) console.log(`  global ${g.diff} ${g.label} ${g.reasons?.join(', ') || ''}`);
}
