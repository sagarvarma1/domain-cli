// Just enough XML to read Namecheap API responses: elements, attributes, text.
// No DTDs, CDATA or namespaces-as-meaning — Namecheap doesn't use them.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;

  for (let m: RegExpExecArray | null; (m = tag.exec(xml)); ) {
    const top = stack[stack.length - 1]!;
    top.text += decodeEntities(xml.slice(last, m.index));
    last = tag.lastIndex;

    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      const [, , closing, name, rawAttrs = "", selfClosing] = m;
      if (closing) {
        if (stack.length > 1 && top.name === name) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of rawAttrs.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
      }
      const node: XmlNode = { name: name!, attrs, children: [], text: "" };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  for (const n of walk(root)) n.text = n.text.trim();
  return root;
}

function* walk(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/** Every descendant element with this name (case-insensitive), depth-first. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const want = name.toLowerCase();
  return [...walk(node)].filter((n) => n !== node && n.name.toLowerCase() === want);
}

export function find(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

/** Attribute lookup that ignores case — Namecheap isn't consistent (HostId vs HostID). */
export function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  if (name in node.attrs) return node.attrs[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) if (k.toLowerCase() === want) return v;
  return undefined;
}
