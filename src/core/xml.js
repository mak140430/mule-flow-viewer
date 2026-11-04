// Small namespace-aware XML parser that keeps source positions (DOMParser drops them,
// and line numbers are what "show source" and visual diffs anchor to).

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

export class XmlError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

const ATTR_RE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const NAME_RE = /[^\s/>]+/y;

/**
 * @returns {{root: XmlNode, source: string}}
 * XmlNode: {qname, prefix, local, ns, attrs, children, text, start, end, line, endLine, parent}
 */
export function parseXml(src) {
  const lineOf = lineIndex(src);
  const doc = { children: [], ns: {}, text: '' };
  const stack = [doc];
  let i = 0;

  const appendText = (t) => {
    const top = stack[stack.length - 1];
    if (top !== doc) top.text += t;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) appendText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('Unclosed CDATA', lineOf(lt));
      appendText(src.slice(lt + 9, end));
      stack[stack.length - 1].cdata = true;
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new XmlError('Unclosed end tag', lineOf(lt));
      const name = src.slice(lt + 2, end).trim();
      const node = stack.pop();
      if (!node || node === doc || node.qname !== name) {
        throw new XmlError(`Unexpected </${name}>`, lineOf(lt));
      }
      node.end = end + 1;
      node.endLine = lineOf(end);
      i = end + 1;
    } else {
      NAME_RE.lastIndex = lt + 1;
      const nameMatch = NAME_RE.exec(src);
      if (!nameMatch) throw new XmlError('Bad tag', lineOf(lt));
      const qname = nameMatch[0];
      let p = NAME_RE.lastIndex;
      const attrs = {};
      for (;;) {
        ATTR_RE.lastIndex = p;
        const m = ATTR_RE.exec(src);
        if (!m) break;
        attrs[m[1]] = decodeEntities(m[2] ?? m[3]);
        p = ATTR_RE.lastIndex;
      }
      while (/\s/.test(src[p])) p++;
      const selfClosing = src[p] === '/';
      if (selfClosing) p++;
      if (src[p] !== '>') throw new XmlError(`Malformed <${qname}>`, lineOf(lt));

      const parent = stack[stack.length - 1];
      const ns = { ...parent.ns };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'xmlns') ns[''] = v;
        else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
      }
      const colon = qname.indexOf(':');
      const prefix = colon < 0 ? '' : qname.slice(0, colon);
      const node = {
        qname,
        prefix,
        local: colon < 0 ? qname : qname.slice(colon + 1),
        ns: ns[prefix] ?? '',
        nsScope: ns,
        attrs,
        children: [],
        text: '',
        start: lt,
        end: p + 1,
        line: lineOf(lt),
        endLine: lineOf(p),
        parent: parent === doc ? null : parent,
      };
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
      i = p + 1;
    }
  }
  if (stack.length > 1) throw new XmlError(`Unclosed <${stack[stack.length - 1].qname}>`, stack[stack.length - 1].line);
  if (!doc.children.length) throw new XmlError('No root element', 1);
  return { root: doc.children[0], source: src };
}

/** Original text of a node, starting at the beginning of its first line so indentation lines up. */
export function sourceOf(node, src) {
  const lineStart = src.lastIndexOf('\n', node.start - 1) + 1;
  return src.slice(lineStart, node.end);
}
