// MUnit tests: their starting events and mocks, read from standard MUnit elements only
// (munit:set-event, munit-tools:mock-when ... then-return), so it works for any project layout.
// chain.js runs a flow from a test's event up to a script.

const RESOURCE_CALL = /(?:MunitTools::)?getResourceAs(?:String|Stream|ReusableStream)\(\s*(['"])([^'"]+)\1(?:\s*,\s*(['"])[^'"]*\3)?\s*\)/g;
const READ_URL = /readUrl\(\s*(['"])classpath:\/*([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?[^)]*\)/g;
export const READABLE = /^(application\/(json|xml|csv|yaml|x-www-form-urlencoded)|text\/(csv|xml))/;
export const JSON_MIME = 'application/json';
const MIME_BY_EXT = { json: 'application/json', xml: 'application/xml', csv: 'application/csv', yaml: 'application/yaml', yml: 'application/yaml' };

const child = (n, local) => n.children.find((c) => c.local === local);
const value = (n) => (n ? { raw: n.attrs.value ?? n.text.trim(), mediaType: n.attrs.mediaType || '' } : null);
const variables = (n) => (n ? n.children.filter((c) => c.local === 'variable').map((v) => ({ key: v.attrs.key, ...value(v) })) : []);

/** <munit:test> elements of an MUnit suite. Values are {raw, mediaType}. */
export function parseTests(path, root) {
  return root.children.filter((t) => t.local === 'test').map((t) => {
    const behavior = child(t, 'behavior');
    const execution = child(t, 'execution');
    const setEvent = [behavior, execution].map((n) => n && child(n, 'set-event')).find(Boolean);
    return {
      name: t.attrs.name,
      file: path,
      line: t.line,
      ignored: t.attrs.ignore === 'true',
      targets: (execution?.children || []).filter((c) => c.local === 'flow-ref').map((c) => c.attrs.name),
      event: {
        payload: value(setEvent && child(setEvent, 'payload')),
        attributes: value(setEvent && child(setEvent, 'attributes')),
        vars: variables(setEvent && child(setEvent, 'variables')),
      },
      mocks: (behavior?.children || []).filter((m) => m.local === 'mock-when').map((m) => {
        const ret = child(m, 'then-return');
        return {
          label: m.attrs['doc:name'] || m.attrs.processor,
          processor: m.attrs.processor || '',
          where: (child(m, 'with-attributes')?.children || []).map((w) => ({ name: w.attrs.attributeName, value: w.attrs.whereValue })),
          payload: value(ret && child(ret, 'payload')),
          attributes: value(ret && child(ret, 'attributes')),
          vars: variables(ret && child(ret, 'variables')),
        };
      }),
    };
  });
}

/** `#['x']` / `#["x"]` / `x` -> x; null when the condition is a real expression. */
function literal(v) {
  const m = /^#\[\s*(['"])(.*)\1\s*\]$/s.exec(v ?? '');
  if (m) return m[2];
  return v?.startsWith('#[') ? null : v;
}

/** The test's mock for processor p, if any. */
export function mockFor(test, p) {
  if (!p.node) return null;
  return test.mocks.find((m) => {
    const [mp, ml] = m.processor.includes(':') ? m.processor.split(':') : ['mule', m.processor];
    const [kp, kl] = p.key.split(':');
    if (ml !== kl || !(mp === kp || mp === p.node.prefix || (mp === 'mule' && kp === 'core'))) return false;
    return m.where.every((w) => {
      const want = literal(w.value);
      return want == null || p.node.attrs[w.name] === want;
    });
  }) || null;
}

function resourceFile(project, path) {
  const p = path.replace(/^classpath:\/*/, '').replace(/^\/+/, '');
  return [`src/test/resources/${p}`, `src/main/resources/${p}`].find((f) => project.allPaths?.includes(f)) || null;
}

const mimeOf = (path) => MIME_BY_EXT[path.split('.').pop().toLowerCase()] || 'text/plain';

/**
 * `#[expr]` with an optional inline header (`#[output application/json --- {...}]`) as a script
 * whose output is `out` unless the expression names a readable one. Returns {script, mime}.
 */
export function expressionScript(code, out, wrap = (body) => body) {
  const split = /^([\s\S]*?)---([\s\S]*)$/.exec(code);
  const isHeader = split && /^\s*((%dw|output|import|var|fun|ns|type)\b[^\n]*\s*)+$/.test(split[1]);
  let [header, body] = isHeader ? [split[1], split[2]] : ['', code];
  const own = /^\s*output\s+([\w/+.-]+)/m.exec(header)?.[1];
  header = header.replace(/^\s*%dw.*$/m, '').replace(/^\s*output\s+.*$/m, '').trim();
  const mime = own && READABLE.test(own) ? own : out;
  return { script: `%dw 2.0\n${header ? `${header}\n` : ''}output ${mime}\n---\n${wrap(body)}`, mime };
}

/**
 * An MUnit value as {text, mime}. One resource file keeps the file as it is; anything else is
 * evaluated by the engine with the current event as inputs, MUnit's resource helpers reading the
 * files sent along. Values without a readable media type come back as JSON.
 */
export async function evaluateValue(v, env, inputs = {}) {
  const { project, engine } = env;
  const mt = v.mediaType.split(';')[0].trim();
  const readable = READABLE.test(mt);
  const expr = /^#\[([\s\S]*)\]$/.exec(v.raw.trim())?.[1];
  if (expr == null) return readable ? { text: v.raw, mime: mt } : { text: JSON.stringify(v.raw), mime: JSON_MIME };

  const resources = {};
  const refs = [...expr.matchAll(RESOURCE_CALL)].map((m) => m[2]).concat([...expr.matchAll(READ_URL)].map((m) => m[2]));
  project._resources ??= new Map();
  for (const ref of refs) {
    const file = resourceFile(project, ref);
    if (!file) throw new Error(`${ref} is not in src/test/resources or src/main/resources`);
    if (!project._resources.has(file)) project._resources.set(file, await project.read(file));
    resources[ref] = project._resources.get(file);
  }
  if (refs.length === 1 && readable && /^\s*$/.test(expr.replace(RESOURCE_CALL, ''))) return { text: resources[refs[0]], mime: mt };

  const code = expr
    .replace(RESOURCE_CALL, (_, q, path) => `munitResources[${JSON.stringify(path)}]`)
    .replace(READ_URL, (_, q, path, q2, mime) => `read(munitResources[${JSON.stringify(path)}], ${JSON.stringify(mime || mimeOf(path))})`);
  // a string with a media type is that format's text (MUnit's resource helpers return strings)
  const typed = readable ? (c) => `do { var v = (${c}) --- if (v is String) read(v, ${JSON.stringify(mt)}) else v }` : (c) => c;
  const { script, mime } = expressionScript(code, readable ? mt : JSON_MIME, typed);
  const r = await engine.run({
    script,
    modules: {},
    properties: env.properties,
    inputs: { ...inputs, munitResources: { text: JSON.stringify(resources), mime: JSON_MIME } },
  });
  if (!r.ok) throw new Error(r.error.split('\n')[0]);
  if (r.truncated) throw new Error('the value is larger than 1 MB');
  return { text: r.output, mime };
}
