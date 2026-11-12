// Properties across environments: each key the app's files define or read, with its value in each environment
// (dev, qa, prod ... from config-${env}.yaml and the like), and what to fix: keys the app reads that no file
// defines, keys missing in some environments, secrets kept in plain text.

import { PROPERTY_REFS, PLATFORM_KEY, SECRET_KEY, DYNAMIC_REF, isRead } from './lint.js';

/** key -> [{file, line}] where the app's flows, DataWeave and property values read it. */
export function propertyRefs(project) {
  const out = new Map();
  for (const [file, text] of project.texts) {
    if (!/\.(xml|dwl|ya?ml|properties)$/.test(file) || file === 'pom.xml') continue;
    text.split('\n').forEach((line, i) => {
      for (const re of PROPERTY_REFS) {
        for (const m of line.matchAll(re)) {
          if (!out.has(m[1])) out.set(m[1], []);
          out.get(m[1]).push({ file, line: i + 1 });
        }
      }
    });
  }
  return out;
}

const envFile = (path, env) => new RegExp(`[-_/.]${env}\\.[a-z]+$`).test(path);

/**
 * {columns: [env], rows: [{key, cells: [{value, file, line, own (from the environment's file), encrypted, decrypted, plain
 * (a secret in plain text)} | null], refs, problems: [{severity, text}]}]}. Without environments: one column, null.
 */
export function envMatrix(project, { libraryTexts = [] } = {}) {
  const columns = project.environments.length ? project.environments : [null];
  const refs = propertyRefs(project);
  // libraries read the app's properties too (keys only they read are theirs to define: not listed)
  const read = new Set(refs.keys());
  for (const t of libraryTexts) for (const re of PROPERTY_REFS) for (const m of t.matchAll(re)) read.add(m[1]);
  const prefixes = [...project.texts.values(), ...libraryTexts].flatMap((t) => [...t.matchAll(DYNAMIC_REF)].map((m) => m[1]));
  const keys = new Set([...project.propertyFiles.flatMap((pf) => Object.keys(pf.values)), ...refs.keys()]);
  const rows = [];
  for (const key of [...keys].sort()) {
    if (PLATFORM_KEY.test(key) && !project.propertyFiles.some((pf) => key in pf.values)) continue;
    const isUsed = isRead(key, read, prefixes);
    const cells = columns.map((env) => {
      const r = project.resolveProperty(key, env);
      if (!r) return null;
      const value = String(r.value ?? '');
      return {
        value, file: r.file, line: r.line,
        own: env ? envFile(r.file, env) : true,
        encrypted: /^!\[/.test(value),
        // decrypted with the environment's key, once given (secure.js; kept in this tab only)
        decrypted: /^!\[/.test(value) ? project.secrets?.get(env)?.get(key) ?? null : null,
        plain: SECRET_KEY.test(key) && !!value && !/^!\[/.test(value) && !/\$\{/.test(value),
      };
    });
    const problems = [];
    if (cells.every((c) => !c)) {
      problems.push({ severity: 'error', text: 'read, but no file defines it' });
    } else {
      const missing = columns.filter((e, i) => !cells[i]);
      if (missing.length && columns[0]) problems.push({ severity: 'warning', text: `missing in ${missing.join(', ')}` });
      if (cells.some((c) => c?.plain)) problems.push({ severity: 'warning', text: 'a secret in plain text' });
      if (!isUsed && !PLATFORM_KEY.test(key)) problems.push({ severity: 'info', text: 'nothing reads it' });
    }
    rows.push({ key, cells, refs: refs.get(key) || [], problems });
  }
  return { columns, rows };
}
