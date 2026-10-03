/** Minimal XML parser for tests: validates well-formedness and builds a tree. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    if (ENTITIES[e] === undefined) throw new Error(`Unknown entity ${m}`);
    return ENTITIES[e];
  });
}

export function parseXml(xml: string): XmlNode {
  let pos = 0;
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) {
      if (xml.slice(pos).trim()) throw new Error('Text after the root element');
      break;
    }
    if (lt > pos) {
      const text = xml.slice(pos, lt);
      if (/[<>]/.test(text)) throw new Error('Stray markup');
      stack[stack.length - 1].text += decode(text);
    }
    if (xml.startsWith('<?', lt)) {
      pos = xml.indexOf('?>', lt) + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      pos = xml.indexOf('-->', lt) + 3;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', lt)) {
      pos = xml.indexOf('>', lt) + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new Error('Unterminated tag');
    const body = xml.slice(lt + 1, gt);
    pos = gt + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Mismatched </${name}> (open: ${open?.name})`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(inner.trim());
    if (!m) throw new Error(`Bad tag <${body}>`);
    const attrs: Record<string, string> = {};
    const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
    let rest = m[2];
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2]))) {
      if (attrs[am[1]] !== undefined) throw new Error(`Duplicate attribute ${am[1]}`);
      attrs[am[1]] = decode(am[2]);
      rest = rest.replace(am[0], '');
    }
    if (rest.trim()) throw new Error(`Bad attributes in <${body}>`);
    const node: XmlNode = { name: m[1], attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1].name}>`);
  if (root.children.length !== 1) throw new Error('Expected exactly one root element');
  return root.children[0];
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
