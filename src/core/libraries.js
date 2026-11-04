// Flows a project calls from a shared library (a Mule plugin, e.g. a common-core): read from the plugin's jar
// in the local Maven repository, so external flow-refs can be opened, and so it shows which library
// versions changed them. adapter: libraries(), library(g, a, v), libraryVersions(g, a) (see adapters/dev-server.js).

import { loadProject } from './project.js';
import { diffProjects } from './diff.js';

const gav = (l) => `${l.groupId}:${l.artifactId}:${l.version}`;

export class Libraries {
  constructor(adapter, catalog) {
    this.adapter = adapter;
    this.catalog = catalog;
    this.projects = new Map();   // gav -> Promise<project | null>
    this.versions = new Map();   // g:a -> Promise<[version]>
    this.changes = new Map();    // g:a:flow -> Promise<[{version, changed}]>
  }

  /** A library version as a project (its XML under src/main/mule/, its DataWeave under src/main/resources/). */
  project(lib) {
    const key = gav(lib);
    if (!this.projects.has(key)) {
      this.projects.set(key, this.adapter.library(lib.groupId, lib.artifactId, lib.version).then((files) => {
        const paths = new Map(Object.keys(files).map((p) => [p.endsWith('.xml') ? `src/main/mule/${p}` : `src/main/resources/${p}`, p]));
        return loadProject({ list: async () => [...paths.keys()], read: async (p) => files[paths.get(p)] }, this.catalog);
      }).catch(() => null));
    }
    return this.projects.get(key);
  }

  /** flow name -> {lib, project, flow} for the plugins a project version uses (adapterAt: that version's adapter). */
  async flows(adapterAt = this.adapter) {
    const out = new Map();
    const libs = (await adapterAt.libraries().catch(() => [])).filter((l) => l.available && l.version);
    for (const lib of libs) {
      const project = await this.project(lib);
      for (const flow of project?.flows.values() || []) out.set(flow.name, { lib, project, flow });
    }
    return out;
  }

  versionsOf(lib) {
    const key = `${lib.groupId}:${lib.artifactId}`;
    if (!this.versions.has(key)) this.versions.set(key, this.adapter.libraryVersions(lib.groupId, lib.artifactId).catch(() => []));
    return this.versions.get(key);
  }

  /** Every local version of the library, and whether it changed this flow (or the DataWeave it uses) since the one before. */
  history(lib, name) {
    const key = `${lib.groupId}:${lib.artifactId}:${name}`;
    if (!this.changes.has(key)) {
      this.changes.set(key, (async () => {
        const versions = await this.versionsOf(lib);
        const projects = await Promise.all(versions.map((version) => this.project({ ...lib, version })));
        return versions.map((version, i) => {
          const has = !!projects[i]?.flows.has(name);
          if (!i || !projects[i] || !projects[i - 1]) return { version, has, changed: false };
          const had = projects[i - 1].flows.has(name);
          return { version, has, changed: has !== had || (has && changedIn(diffProjects(projects[i - 1], projects[i]), name)) };
        });
      })());
    }
    return this.changes.get(key);
  }

  /**
   * Plugins whose version differs between two project versions, with the flows (of those this project calls)
   * the newer version changes: [{lib, from, to, flows: [name], diff}].
   */
  async upgrades(base, head, adapterBase, adapterHead, called) {
    const [a, b] = await Promise.all([adapterBase.libraries().catch(() => []), adapterHead.libraries().catch(() => [])]);
    const out = [];
    for (const l of b) {
      const old = a.find((x) => x.groupId === l.groupId && x.artifactId === l.artifactId);
      if (!old || old.version === l.version || !l.available || !old.available) continue;
      const [pa, pb] = await Promise.all([this.project(old), this.project(l)]);
      if (!pa || !pb || (!pa.flows.size && !pb.flows.size)) continue;
      const diff = diffProjects(pa, pb);
      const flows = [...called].filter((name) => changedIn(diff, name) || pa.flows.has(name) !== pb.flows.has(name));
      out.push({ lib: l, artifactId: l.artifactId, from: old.version, to: l.version, flows, diff });
    }
    return out;
  }
}

function changedIn(diff, name) {
  for (const c of diff.configs.values()) {
    const f = c.flows.find((x) => x.name === name);
    if (f) return !!f.diff;
  }
  return false;
}
