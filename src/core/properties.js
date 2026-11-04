// Mule configuration-properties files flattened to dotted keys, e.g. `pr.file.path.full`.
// Covers the YAML Mule projects actually use: nested maps, scalars, quotes, comments.

const unquote = (v) => {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
};

export function parseYaml(text) {
  const out = {};
  const stack = []; // [{indent, key}]
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-\s/.test(raw)) return;
    const m = /^(\s*)("[^"]+"|'[^']+'|[^:#]+?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = unquote(m[2]);
    const value = m[3] === undefined ? '' : unquote(m[3]);
    const full = [...stack.map((s) => s.key), key].join('.');
    if (value === '' || value === '|' || value === '>') stack.push({ indent, key });
    else out[full] = { value, line: i + 1 };
  });
  return out;
}

export function parseProperties(text) {
  const out = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(raw);
    if (m) out[m[1]] = { value: m[2], line: i + 1 };
  });
  return out;
}

/** `${a.b}` keys inside a string. */
export function placeholderKeys(s) {
  return [...s.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
}
