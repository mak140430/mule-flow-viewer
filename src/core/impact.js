// What a change (a pull request, a branch, a commit) affects: which entry points (HTTP endpoints, API resources,
// schedules, listeners) run something it changed, plus what it changes in Mule terms that the canvas does not
// show at a glance: new and changed properties and the environments that lack them, dependency versions, global
// configurations.

import { walkFlow } from './model.js';
import { isChange } from './diff.js';
import { entryPoints, reacher } from './surface.js';
import { propertyRefs } from './env-matrix.js';
import { parsePom } from '../adapters/git-host.js';

/**
 * d: diffProjects() result (with d.libraries when known). Returns {entries: [{entry, changes}], unreached: [change],
 * properties: [{key, status, missing: [env]}], dependencies: [{artifactId, groupId, from, to}], configurations:
 * [{label, key, diff, file}]}; a change: {id, label, diff, flow (name), file, via (the library flow it changed)}.
 */
export function impact(d) {
  const sides = {
    head: { project: d.head, entries: entryPoints(d.head) },
    base: { project: d.base, entries: entryPoints(d.base) },
  };
  for (const s of Object.values(sides)) s.reach = reacher(s.project, s.entries);

  const byEntry = new Map();     // entry key -> {entry, changes}
  const unreached = [];
  const record = (change, names, side) => {
    const found = new Set();
    for (const n of names) for (const e of sides[side].reach(n)) found.add(e);
    // a removed element was reached from where its flow was reached before
    if (!found.size && side === 'head') for (const n of names) for (const e of sides.base.reach(n)) found.add(e);
    if (!found.size) return unreached.push(change);
    for (const e of found) {
      const key = e.key;
      if (!byEntry.has(key)) byEntry.set(key, { entry: side === 'head' || !sides.head.entries.some((x) => x.key === key) ? e : sides.head.entries.find((x) => x.key === key), changes: [] });
      byEntry.get(key).changes.push(change);
    }
  };

  // elements of flows
  for (const { item, flow } of d.byId.values()) {
    if (!flow || !isChange(item)) continue;
    const change = { id: item.id, label: item === flow ? item.name : item.label, diff: item.diff, flow: flow.name, file: flow.file, whole: item === flow };
    // the same element seen in its flow's own entry (an added flow is listed once, not with each of its steps)
    if (item !== flow && (flow.diff === 'added' || flow.diff === 'removed')) continue;
    record(change, [flow.name], item.diff === 'removed' && !d.head.flows.has(flow.name) ? 'base' : 'head');
  }
  // configurations: the flows whose steps use one
  const configurations = [];
  for (const c of d.configs.values()) {
    for (const g of c.globals) {
      if (!g.diff) continue;
      configurations.push({ label: g.label, key: g.key, diff: g.diff, file: c.path, id: g.id });
      const side = g.diff === 'removed' ? 'base' : 'head';
      const users = new Set();
      for (const f of sides[side].project.flows.values()) walkFlow(f, (p) => { if (g.name && p.node.attrs['config-ref'] === g.name) users.add(f.name); });
      if (users.size) record({ id: g.id, label: g.label, diff: g.diff, flow: null, file: c.path, global: true }, users, side);
    }
  }
  // library flows a new library version changes, where this app calls them
  for (const l of d.libraries || []) {
    for (const name of l.flows) {
      const callers = [...new Set((d.head.callers.get(name) || []).map((c) => c.flow.name))];
      if (callers.length) record({ id: null, label: name, diff: 'changed', flow: null, via: `${l.artifactId} ${l.from} → ${l.to}` }, callers, 'head');
    }
  }

  return {
    entries: [...byEntry.values()].sort((a, b) => sides.head.entries.indexOf(a.entry) - sides.head.entries.indexOf(b.entry)),
    unreached,
    properties: propertyChanges(d),
    dependencies: dependencyChanges(d),
    configurations,
  };
}

/** Keys a change adds, changes or starts reading, with the environments where it has no value. */
function propertyChanges(d) {
  const envs = d.head.environments;
  const before = propertyRefs(d.base);
  const after = propertyRefs(d.head);
  const out = new Map();
  const add = (key, status) => {
    if (out.has(key)) return;
    const missing = envs.length ? envs.filter((e) => !d.head.resolveProperty(key, e)) : d.head.resolveProperty(key, null) ? [] : ['every environment'];
    const file = d.props.get(key)?.[0]?.file || d.head.resolveProperty(key, envs[0] || null)?.file || null;
    out.set(key, { key, status, missing, file });
  };
  for (const [key, changes] of d.props) {
    const added = changes.every((c) => c.before == null);
    const removed = changes.every((c) => c.after == null);
    add(key, added ? 'added' : removed ? 'removed' : 'changed');
  }
  for (const key of after.keys()) if (!before.has(key)) add(key, 'newly read');
  // removed everywhere and no longer read: nothing missing about it
  for (const p of out.values()) if (p.status === 'removed' && !after.has(p.key)) p.missing = [];
  return [...out.values()].sort((a, b) => (b.missing.length > 0) - (a.missing.length > 0) || a.key.localeCompare(b.key));
}

function dependencyChanges(d) {
  const read = (p) => {
    const pom = parsePom(p.texts.get('pom.xml') || '');
    const props = { ...pom.properties, 'project.version': pom.version, 'project.groupId': pom.groupId };
    const fill = (v) => (v || '').replace(/\$\{([^}]+)\}/g, (all, k) => props[k] ?? all);
    return new Map(pom.deps.map((x) => {
      const dep = { ...x, groupId: fill(x.groupId), artifactId: fill(x.artifactId), version: fill(x.version) };
      return [`${dep.groupId}:${dep.artifactId}`, dep];
    }));
  };
  const a = read(d.base);
  const b = read(d.head);
  const out = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x?.version === y?.version) continue;
    out.push({ groupId: (x || y).groupId, artifactId: (x || y).artifactId, from: x?.version || null, to: y?.version || null });
  }
  return out.sort((p, q) => p.artifactId.localeCompare(q.artifactId));
}
