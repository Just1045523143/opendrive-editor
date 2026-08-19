/**
 * 极简 XML 解析/序列化，专供 .xodr 使用。
 *
 * 之所以不用 DOMParser：单元测试跑在 Node 下（无 DOM），而引入 XML 库会为
 * 一个结构极简的格式增加体积与许可负担。xodr 无命名空间、无实体声明、
 * 无处理指令（除声明头），单遍扫描即可。
 *
 * 支持：元素、属性、自闭合、CDATA（geoReference 用）、注释、文本节点。
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 文本内容（含 CDATA 展开后的结果），无文本时为 undefined */
  text?: string;
}

const NAME_END = /[\s/>]/;

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 解析 XML 文本，返回根元素。解析失败时抛出带位置信息的错误。 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#document', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf('<', i);

    if (lt < 0) break;

    // 标签之前的文本
    if (lt > i) {
      const raw = src.slice(i, lt);
      if (raw.trim().length > 0) {
        const parent = stack[stack.length - 1]!;
        parent.text = (parent.text ?? '') + decodeEntities(raw);
      }
    }

    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }

    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const content = src.slice(i + 9, end < 0 ? n : end);
      const parent = stack[stack.length - 1]!;
      parent.text = (parent.text ?? '') + content;
      i = end < 0 ? n : end + 3;
      continue;
    }

    // <?xml ... ?> 与 <!DOCTYPE ...>
    if (src.startsWith('<?', i) || src.startsWith('<!', i)) {
      const end = src.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // 闭合标签
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i);
      if (end < 0) throw new Error(`XML 解析失败：闭合标签未终止，位置 ${i}`);
      const name = src.slice(i + 2, end).trim();
      // 容错：只在栈中存在同名元素时才弹出，避免结构错乱导致整体崩溃
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.tag === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    // 开始标签
    i += 1;
    let j = i;
    while (j < n && !NAME_END.test(src[j]!)) j++;
    const tag = src.slice(i, j);
    const node: XmlNode = { tag, attrs: {}, children: [] };
    i = j;

    // 属性
    while (i < n) {
      while (i < n && /\s/.test(src[i]!)) i++;
      const ch = src[i];
      if (ch === undefined) break;
      if (ch === '>' || ch === '/') break;

      let k = i;
      while (k < n && src[k] !== '=' && !/[\s/>]/.test(src[k]!)) k++;
      const key = src.slice(i, k);
      i = k;
      while (i < n && /\s/.test(src[i]!)) i++;

      if (src[i] === '=') {
        i++;
        while (i < n && /\s/.test(src[i]!)) i++;
        const quote = src[i];
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, i + 1);
          const value = src.slice(i + 1, end < 0 ? n : end);
          node.attrs[key] = decodeEntities(value);
          i = end < 0 ? n : end + 1;
        } else {
          // 无引号属性值（非标准，但容错处理）
          let e = i;
          while (e < n && !/[\s/>]/.test(src[e]!)) e++;
          node.attrs[key] = decodeEntities(src.slice(i, e));
          i = e;
        }
      } else if (key.length > 0) {
        node.attrs[key] = '';
      } else {
        i++;
      }
    }

    stack[stack.length - 1]!.children.push(node);

    if (src[i] === '/') {
      // 自闭合
      i = src.indexOf('>', i);
      i = i < 0 ? n : i + 1;
    } else if (src[i] === '>') {
      stack.push(node);
      i += 1;
    }
  }

  const first = root.children[0];
  if (!first) throw new Error('XML 解析失败：未找到根元素');
  return first;
}

/** 取第一个指定标签的子元素 */
export function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

/** 取全部指定标签的子元素 */
export function children(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

/** 读字符串属性 */
export function attr(node: XmlNode, name: string): string | undefined {
  return node.attrs[name];
}

/** 读数值属性，缺失或非法时返回 fallback */
export function num(node: XmlNode, name: string, fallback = 0): number {
  const raw = node.attrs[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 把节点原样序列化回 XML 文本。
 * 用于保留解析器未建模的子元素（如 object 下的 outline、userData），
 * 使导出结果不丢失原文件信息。
 */
export function serializeRaw(node: XmlNode, indent = ''): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
    .join('');
  const hasText = node.text !== undefined && node.text.trim().length > 0;

  if (node.children.length === 0 && !hasText) {
    return `${indent}<${node.tag}${attrs}/>\n`;
  }

  let out = `${indent}<${node.tag}${attrs}>`;
  if (hasText && node.children.length === 0) {
    return `${out}${encodeEntities(node.text!.trim())}</${node.tag}>\n`;
  }
  out += '\n';
  if (hasText) out += `${indent}  ${encodeEntities(node.text!.trim())}\n`;
  for (const c of node.children) out += serializeRaw(c, indent + '  ');
  out += `${indent}</${node.tag}>\n`;
  return out;
}

/** 读可选数值属性，缺失时返回 undefined */
export function numOpt(node: XmlNode, name: string): number | undefined {
  const raw = node.attrs[name];
  if (raw === undefined || raw === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}
