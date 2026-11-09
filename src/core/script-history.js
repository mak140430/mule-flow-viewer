// One DataWeave script through the history of the file it lives in: the commits on this branch that changed the
// script itself (not just something else in the file), each with the script as that commit left it.
// versions: adapter.versions(path) (see element-history.js).

import { parseXml } from './xml.js';
import { nodeKey } from './element-history.js';
import { scriptsOf } from './model.js';
import { unwrapExpression } from './dataweave.js';

const RES_DIR = 'src/main/resources/';

/** Where the script `s` of element `p` lives: {path} for a .dwl file, {path, key, label} for one written in the XML. */
export function scriptSource(p, s) {
  if (s.resource) return { path: RES_DIR + s.resource.replace(/^classpath:\/*/, ''), label: s.label };
  return p.file && p.node ? { path: p.file, key: nodeKey(p.node), label: s.label } : null;
}

/** The script in one version of its file, or null where it is absent. */
function scriptIn(text, source) {
  if (!source.key) return text;
  try {
    const { root } = parseXml(text);
    let found = null;
    const visit = (n) => {
      if (found) return;
      if (nodeKey(n) === source.key) { found = n; return; }
      n.children.forEach(visit);
    };
    visit(root);
    if (!found) return null;
    const s = scriptsOf({ key: found.qname, kind: 'processor', node: found }).find((x) => x.label === source.label);
    return s?.code != null ? unwrapExpression(s.code) : null;
  } catch { return null; }   // a commit with broken XML
}

/** [{sha, short, subject, author, date, script}], newest first. */
export function scriptHistory(versions, source) {
  const at = (blob) => (blob && versions.texts[blob] != null ? scriptIn(versions.texts[blob], source) : null);
  const out = [];
  const seen = new Set();
  for (const c of [...versions.commits].sort((a, b) => new Date(b.date) - new Date(a.date))) {
    if (c.onHead === false || c.before === c.after) continue;
    const after = at(c.after);
    if (after == null || after === at(c.before)) continue;
    // a change merged in counts once
    if (seen.has(after)) continue;
    seen.add(after);
    out.push({ sha: c.sha, short: c.short || c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date, script: after });
  }
  return out;
}
