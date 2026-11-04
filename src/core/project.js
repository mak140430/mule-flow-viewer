// Whole-project index: every cross-reference the viewer navigates along.
// Platform-agnostic: an adapter only has to provide list() and read(path).

import { parseXml } from './xml.js';
import { buildConfig, walkFlow, scriptsOf } from './model.js';
import { dwImports, modulePath, dwPropertyRefs, dwLookups, unwrapExpression } from './dataweave.js';
import { parseYaml, parseProperties } from './properties.js';
import { parseTests } from './munit.js';

const MULE_DIR = 'src/main/mule/';
const RES_DIR = 'src/main/resources/';
const MUNIT_DIR = 'src/test/munit/';

export const isRelevant = (path) =>
  (path.startsWith(MULE_DIR) && path.endsWith('.xml')) ||
  (path.startsWith(RES_DIR) && /\.(dwl|ya?ml|properties)$/.test(path)) ||
  (path.startsWith(MUNIT_DIR) && path.endsWith('.xml')) ||
  path === 'pom.xml';

/**
 * @param {{list(): Promise<string[]>, read(path: string): Promise<string>}} adapter
 * @param {{connectors: object}} [catalog]
 */
export async function loadProject(adapter, catalog) {
  if (catalog && !catalog.byNamespace) {
    catalog.byNamespace = Object.fromEntries(Object.values(catalog.connectors).map((c) => [c.namespace, c.prefix]));
  }
  const all = await adapter.list();
  const paths = all.filter(isRelevant).sort();
  const texts = new Map(await Promise.all(paths.map(async (p) => [p, await adapter.read(p)])));
  const project = new Project(texts, catalog);
  project.allPaths = all;            // test resources are read when a test sample is picked
  project.read = (path) => adapter.read(path);
  return project;
}

export class Project {
  constructor(texts, catalog) {
    this.texts = texts;
    this.catalog = catalog;
    this.configs = [];
    this.errors = [];
    this.flows = new Map();          // name -> flow (also global error handlers)
    this.callers = new Map();        // flow name -> [{processor, flow}]
    this.globals = new Map();        // global element name -> global
    this.dwl = new Map();            // resources-relative path -> {path, code, imports, props, lookups}
    this.dwlUsers = new Map();       // resources-relative path -> [{processor, flow, label}]
    this.dwlImporters = new Map();   // resources-relative path -> [path]
    this.propertyFiles = [];         // [{path, values}]
    this.byId = new Map();           // processor/flow id -> {item, flow}
    this.tests = [];                 // MUnit tests (see munit.js)

    for (const [path, text] of texts) {
      if (path.startsWith(MULE_DIR)) this.#addConfig(path, text);
      else if (path.startsWith(MUNIT_DIR)) this.#addTests(path, text);
      else if (path.endsWith('.dwl')) this.#addDwl(path.slice(RES_DIR.length), text);
      else if (/\.ya?ml$/.test(path)) this.propertyFiles.push({ path, values: parseYaml(text) });
      else if (path.endsWith('.properties')) this.propertyFiles.push({ path, values: parseProperties(text) });
    }
    this.defaultErrorHandler = null;
    for (const config of this.configs) {
      for (const g of config.globals) {
        if (g.name) this.globals.set(g.name, g);
        if (g.node.attrs['defaultErrorHandler-ref']) this.defaultErrorHandler = g.node.attrs['defaultErrorHandler-ref'];
      }
      for (const flow of config.flows) {
        if (flow.name) this.flows.set(flow.name, flow);
        this.byId.set(flow.id, { item: flow, flow });
      }
    }
    for (const config of this.configs) for (const flow of config.flows) this.#indexFlow(flow);
    for (const [path, d] of this.dwl) {
      for (const mod of d.imports) {
        const target = modulePath(mod);
        if (target) push(this.dwlImporters, target, path);
      }
    }
    this.environments = this.#environments();
  }

  #addConfig(path, text) {
    try {
      this.configs.push(buildConfig(path, parseXml(text), this.catalog));
    } catch (e) {
      this.errors.push({ path, message: e.message });
    }
  }

  #addTests(path, text) {
    try {
      this.tests.push(...parseTests(path, parseXml(text).root));
    } catch (e) {
      this.errors.push({ path, message: e.message });
    }
  }

  #addDwl(path, code) {
    this.dwl.set(path, { path, code, imports: dwImports(code), props: dwPropertyRefs(code), lookups: dwLookups(code) });
  }

  #indexFlow(flow) {
    walkFlow(flow, (p) => {
      this.byId.set(p.id, { item: p, flow });
      if (p.kind === 'flow-ref' && !p.dynamic) push(this.callers, p.target, { processor: p, flow });
      if (p.key === 'apikit:router') {
        for (const t of this.apikitTargets(p.node.attrs['config-ref'])) push(this.callers, t.flow, { processor: p, flow });
      }
      if (p.errorHandler?.ref) push(this.callers, p.errorHandler.ref, { processor: p, flow });
      for (const s of scriptsOf(p)) {
        if (s.resource) push(this.dwlUsers, s.resource.replace(/^classpath:\/*/, ''), { processor: p, flow, label: s.label });
        for (const name of dwLookups(s.code || '')) push(this.callers, name, { processor: p, flow, dynamic: true });
      }
    });
    if (flow.errorHandler?.ref) push(this.callers, flow.errorHandler.ref, { processor: null, flow });
  }

  /** `config/config-${mule.env}.yaml` + files config-qa.yaml, ... -> ['qa', ...] */
  #environments() {
    const envs = new Set();
    const files = this.configs.flatMap((c) => c.globals.map((g) => g.node.attrs.file).filter(Boolean));
    const literal = new Set(files.filter((f) => !f.includes('${')).map((f) => RES_DIR + f));
    for (const config of this.configs) {
      for (const g of config.globals) {
        const file = g.node.attrs.file;
        if (!file || !file.includes('${')) continue;
        const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^' + (RES_DIR + file).split(/\$\{[^}]+\}/).map(escape).join('([^/]+)') + '$');
        for (const pf of this.propertyFiles) {
          const m = !literal.has(pf.path) && re.exec(pf.path);
          if (m) envs.add(m[1]);
        }
      }
    }
    return [...envs].sort();
  }

  /**
   * Value of a property for an environment: env-specific files first, then the rest.
   * `secure::k` reads k from the same files; its value is the decrypted one once secrets has it (secure: true),
   * else the encrypted text (locked: true). secrets: Map(env -> Map(k -> plain)), filled by secure.js.
   */
  resolveProperty(key, env) {
    if (key.startsWith('secure::')) {
      const r = this.resolveProperty(key.slice(8), env);
      if (!r) return null;
      const plain = this.secrets?.get(env)?.get(key.slice(8));
      return plain != null ? { ...r, value: plain, secure: true } : { ...r, secure: true, locked: /^!\[/.test(r.value) };
    }
    const matches = this.propertyFiles.filter((pf) => key in pf.values);
    if (!matches.length) return null;
    const envMatch = env && matches.find((pf) => new RegExp(`[-_/.]${env}\\.[a-z]+$`).test(pf.path));
    const generic = matches.find((pf) => !this.environments.some((e) => new RegExp(`[-_/.]${e}\\.[a-z]+$`).test(pf.path)));
    // another environment's file is not this environment's value
    const pf = envMatch || generic || (env ? null : matches[0]);
    if (!pf) return null;
    return { value: pf.values[key].value, file: pf.path, line: pf.values[key].line };
  }

  /**
   * Flows an APIkit router dispatches to: explicit <apikit:flow-mapping> entries of its config,
   * plus flows named by convention (`get:\resource:config`).
   */
  apikitTargets(configName) {
    const out = [];
    const config = this.globals.get(configName);
    for (const group of config?.node.children || []) {
      for (const m of group.local === 'flow-mappings' ? group.children : []) {
        if (m.attrs['flow-ref']) out.push({ label: `${m.attrs.action || ''} ${m.attrs.resource || ''}`.trim(), flow: m.attrs['flow-ref'] });
      }
    }
    for (const name of this.flows.keys()) {
      const m = /^(get|post|put|patch|delete|head|options):(\\[^:]*)(?::.*)?:([^:]+)$/.exec(name);
      if (m && m[3] === configName) out.push({ label: `${m[1]} ${m[2].replace(/\\/g, '/')}`, flow: name });
    }
    return out;
  }

  scriptCode(script) {
    if (script.code !== undefined) return unwrapExpression(script.code);
    const path = script.resource.replace(/^classpath:\/*/, '');
    return this.dwl.get(path)?.code ?? null;
  }

  configFor(path) {
    return this.configs.find((c) => c.path === path);
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
