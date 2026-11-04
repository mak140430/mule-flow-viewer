// DataWeave helpers: dependency extraction and syntax highlighting.
// A tokenizer is enough here; nothing needs a full DataWeave parser.

const KEYWORDS = new Set([
  'output', 'input', 'import', 'from', 'var', 'fun', 'type', 'ns', 'if', 'else', 'match', 'case',
  'default', 'using', 'do', 'as', 'is', 'and', 'or', 'not', 'unless', 'update', 'at', 'null',
  'true', 'false', 'map', 'mapObject', 'filter', 'reduce', 'groupBy', 'orderBy', 'distinctBy',
  'pluck', 'flatMap', 'to', 'annotation',
]);

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Module references: `import x from a::b`, `import a::b`, `import * from a::b`. */
export function dwImports(code) {
  const header = stripComments(code).split(/^\s*---\s*$/m)[0];
  const out = [];
  const re = /^\s*import\s+(?:(?:\*|[\w$]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w$]+(?:\s+as\s+\w+)?)*)\s+from\s+)?([\w$]+(?:::[\w$]+)+)/gm;
  let m;
  while ((m = re.exec(header))) out.push(m[1]);
  return [...new Set(out)];
}

/** `a::b::c` -> `a/b/c.dwl` (relative to src/main/resources); stdlib modules return null. */
export function modulePath(mod) {
  if (/^dw::/.test(mod) || /^Mule$/.test(mod)) return null;
  return mod.split('::').join('/') + '.dwl';
}

/** Property keys read from DataWeave: `p('x')`, `Mule::p("x")`. */
export function dwPropertyRefs(code) {
  const out = new Set();
  const re = /(?:Mule::)?\bp\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.add(m[2]);
  return [...out];
}

/** Flows called dynamically from DataWeave: `lookup('flowName', ...)`. */
export function dwLookups(code) {
  const out = new Set();
  const re = /\blookup\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(code))) out.add(m[2]);
  return [...out];
}

/** Strip the `#[ ... ]` wrapper of an inline expression. */
export const unwrapExpression = (s) => (s.startsWith('#[') && s.endsWith(']') ? s.slice(2, -1) : s);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN_RE = new RegExp([
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.source,                    // 1 comment
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.source, // 2 string
  /(%dw\s+[\d.]+|^\s*---\s*$)/.source,                         // 3 directive
  /(\b\d+(?:\.\d+)?\b)/.source,                                // 4 number
  /([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*)(?=\s*\()/.source, // 5 function call
  /([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*)/.source,          // 6 identifier
  /(->|=>|\+\+|--|<=|>=|==|!=|~=|[-+*/<>=!|&^?.])/.source,     // 7 operator
].join('|'), 'gm');

/** Returns HTML with <span class="dw-*"> tokens. */
export function highlightDataWeave(code) {
  let out = '';
  let last = 0;
  code.replace(TOKEN_RE, (m, comment, str, directive, num, fn, ident, op, offset) => {
    out += esc(code.slice(last, offset));
    last = offset + m.length;
    let cls = null;
    if (comment) cls = 'comment';
    else if (str) cls = 'string';
    else if (directive) cls = 'keyword';
    else if (num) cls = 'number';
    else if (fn) cls = 'function';
    else if (ident) cls = KEYWORDS.has(ident) ? 'keyword' : /^[A-Z]/.test(ident) ? 'type' : null;
    else if (op) cls = 'operator';
    out += cls ? `<span class="dw-${cls}">${esc(m)}</span>` : esc(m);
    return m;
  });
  return out + esc(code.slice(last));
}

/** Minimal XML highlighting for the source view. */
export function highlightXml(code) {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([\w:.-]+)|([\w:.-]+)=("[^"]*"|'[^']*')/g;
  let out = '';
  let last = 0;
  code.replace(re, (m, comment, open, tag, attr, value, offset) => {
    out += esc(code.slice(last, offset));
    last = offset + m.length;
    if (comment) out += `<span class="dw-comment">${esc(comment)}</span>`;
    else if (tag) out += `${esc(open)}<span class="xml-tag">${tag}</span>`;
    else out += `<span class="xml-attr">${attr}</span>=<span class="dw-string">${esc(value)}</span>`;
    return m;
  });
  return out + esc(code.slice(last));
}
