// Checks: what in a Mule project is worth a second look, marked on the canvas and listed under Checks. Found from
// the project's own files (no network): calls to flows or configurations that do not exist, secrets written in the
// XML or in plain property files, loggers that write whole payloads, entry flows without error handling,
// hard-coded hosts, requests on Mule's default timeout, flows nothing calls and properties nothing reads.

import { walkFlow, scriptsOf } from './model.js';

export const SEVERITIES = ['error', 'warning', 'info'];

const SECRET_ATTR = /^(password|secret|clientSecret|client-secret|token|apiKey|api-key|keyPassword|storePassword)$/i;
export const SECRET_KEY = /(^|[._-])(password|passwd|pwd|secret|token|api[._-]?key|client[._-]?secret|private[._-]?key)$/i;
// payload on its own (not payload.x, payload[0], sizeOf(payload)...)
const WHOLE_PAYLOAD = /(?<!(sizeOf|isEmpty|typeOf|isBlank)\(\s*)\bpayload\b(?!\s*[.[\w])/;
export const PROPERTY_REFS = [/\$\{\s*(?:secure::)?([^}\s]+)\s*\}/g, /\bp\(\s*['"](?:secure::)?([^'"]+)['"]\s*\)/g];
// read by Mule, the runtime or the platform rather than by the project's own files
export const PLATFORM_KEY = /^(anypoint\.platform\.|mule\.|api\.id$|secure\.key$|encryption\.key$|https?\.port$|http\.private\.port$|project\.|env\.|java\.|user\.|os\.)/;
// a name built at run time, p("crm.entities." ++ name): every key under that prefix counts as read
export const DYNAMIC_REF = /\bp\(\s*['"](?:secure::)?([^'"]+)['"]\s*\+\+/g;
/** Whether key is read, given the keys read by name and the prefixes read by built names. */
export const isRead = (key, used, prefixes) => used.has(key) || prefixes.some((p) => key.startsWith(p));

/** Whether the project is a library (a mule-plugin others depend on): its flows are called from elsewhere. */
export const isLibrary = (project) => /<classifier>\s*mule-plugin\s*<\/classifier>/.test(project.texts.get('pom.xml') || '');

/** (path) -> whether a property file is read by a secure-properties configuration (its values are encrypted). */
export function secureFileTest(project) {
  const files = new Set(project.configs.flatMap((c) => c.globals.filter((g) => g.node.local === 'config' && /secure/.test(g.key)).map((g) => g.node.attrs.file || '')));
  const res = [...files].filter(Boolean).map((f) => new RegExp(`^src/main/resources/${f.replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\$\{[^}]*\}/g, '[^/]+')}$`));
  return (path) => res.some((re) => re.test(path));
}

function visit(node, fn) {
  fn(node);
  for (const c of node.children) visit(c, fn);
}

/**
 * [{severity, rule, message, id?, flow?, file, line}] for a project. opts.libraryFlows: names of flows the project's
 * libraries define (calls to them are not missing); opts.libraryTexts: their files' texts (properties they read are used).
 */
export function checks(project, { libraryFlows = new Set(), libraryTexts = [] } = {}) {
  const out = [];
  const add = (severity, rule, message, at = {}) => out.push({ severity, rule, message, ...at });
  const atItem = (item, flow) => ({ id: item.id, flow: flow?.name, file: item.file, line: item.node?.line });
  const library = isLibrary(project);

  for (const config of project.configs) {
    for (const flow of config.flows) {
      if (flow.kind === 'error-handler') continue;
      if (!library && !flow.source && !project.callers.get(flow.name)?.length) {
        add('info', 'unused-flow', `Nothing in this project calls ${flow.name}.`, atItem(flow, flow));
      }
      if (flow.source && !flow.errorHandler && !project.defaultErrorHandler) {
        add('warning', 'no-error-handler', 'An entry point without an error handler (and none set as the default): errors get Mule\'s default handling.', atItem(flow.source, flow));
      }
      walkFlow(flow, (p) => {
        if (p.kind === 'flow-ref' && !p.dynamic && p.target && !project.flows.has(p.target) && !libraryFlows.has(p.target)) {
          add('error', 'missing-flow', `Calls ${p.target}, which is not in this project${libraryFlows.size ? ' or its libraries' : ''}.`, atItem(p, flow));
        }
        const ref = p.node.attrs['config-ref'];
        if (ref && !/[$#]\{|#\[/.test(ref) && !project.globals.has(ref)) {
          add('error', 'missing-config', `Its configuration ${ref} is not defined in this project.`, atItem(p, flow));
        }
        if (p.key === 'core:logger' && /#\[/.test(p.node.attrs.message || '') && WHOLE_PAYLOAD.test(p.node.attrs.message)) {
          // at DEBUG or TRACE it is off unless someone turns it on
          const quiet = /^(DEBUG|TRACE)$/i.test(p.node.attrs.level || '');
          add(quiet ? 'info' : 'warning', 'logs-payload', `Logs the whole payload${quiet ? ` (at ${p.node.attrs.level.toUpperCase()})` : ''}: it may hold personal data, and large payloads slow the app.`, atItem(p, flow));
        }
        if (p.key === 'http:request') {
          const cfg = project.globals.get(p.node.attrs['config-ref']);
          if (!p.node.attrs.responseTimeout && !cfg?.node.attrs.responseTimeout) {
            add('info', 'default-timeout', 'No response timeout here or on its configuration: it waits Mule\'s default (10 s).', atItem(p, flow));
          }
        }
        for (const s of scriptsOf(p)) {
          if (s.resource && project.scriptCode(s) == null) add('error', 'missing-dwl', `Reads ${s.resource}, which is not in the project.`, atItem(p, flow));
        }
      });
    }
  }

  for (const g of project.globals.values()) {
    visit(g.node, (n) => {
      for (const [k, v] of Object.entries(n.attrs)) {
        if (SECRET_ATTR.test(k) && v && !/\$\{|#\[/.test(v)) {
          add('error', 'hardcoded-secret', `${k} is written in the XML: use a secure property instead.`, { id: g.id, file: g.file, line: n.line });
        }
      }
      if (n.local === 'request-connection' && n.attrs.host && !/\$\{|#\[/.test(n.attrs.host) && !/^(localhost|127\.0\.0\.1)$/.test(n.attrs.host)) {
        add('warning', 'hardcoded-host', `The host ${n.attrs.host} is written in the XML: the same in every environment.`, { id: g.id, file: g.file, line: n.line });
      }
    });
  }

  // properties: secrets kept in plain text, and keys nothing reads
  const secureFile = secureFileTest(project);
  const used = new Set();
  const texts = [...[...project.texts].filter(([p]) => /\.(xml|dwl)$/.test(p)).map(([, t]) => t), ...libraryTexts];
  for (const pf of project.propertyFiles) for (const { value } of Object.values(pf.values)) texts.push(String(value ?? ''));
  const prefixes = [];
  for (const t of texts) {
    for (const re of PROPERTY_REFS) for (const m of t.matchAll(re)) used.add(m[1]);
    for (const m of t.matchAll(DYNAMIC_REF)) prefixes.push(m[1]);
  }
  const unused = new Map();
  for (const pf of project.propertyFiles) {
    const secure = secureFile(pf.path);
    for (const [key, { value, line }] of Object.entries(pf.values)) {
      const v = String(value ?? '');
      if (SECRET_KEY.test(key) && v && !/^!\[/.test(v) && !/\$\{/.test(v)) {
        add('warning', 'plain-secret', secure ? `${key} looks like a secret and is not encrypted.`
          : `${key} looks like a secret, kept in plain text: move it to a secure properties file.`, { file: pf.path, line });
      }
      if (!isRead(key, used, prefixes) && !PLATFORM_KEY.test(key) && !unused.has(key)) unused.set(key, { file: pf.path, line });
    }
  }
  for (const [key, at] of unused) add('info', 'unused-property', `Nothing reads the property ${key}.`, at);

  return out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0));
}
