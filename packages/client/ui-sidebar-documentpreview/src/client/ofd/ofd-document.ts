/** OFD（GB/T 33190）zip+XML 结构的最小读取：容器定位、编码、路径与页内容。 */


/**
 * 按 XML 声明的编码解码字节。OFD 实务中存在 GBK/GB2312 编码的条目，
 * 声明值是 ASCII 可写的，故先以 UTF-8 探测声明再选择解码器。
 * @param bytes - XML 条目字节。
 * @returns 解码后的文本。
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const probe = new TextDecoder().decode(bytes.subarray(0, 200))
  const declared = /<\?xml[^>]*encoding="([^"]+)"/i.exec(probe)?.[1]
  if (declared !== undefined && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // 运行时不认识该标签时回落 UTF-8。
    }
  }
  return new TextDecoder().decode(bytes)
}

/** 解析 XML 文本为 DOM（命名空间无关，OFD 文档实践上使用默认命名空间）。 */
export function parseXml(bytes: Uint8Array): XMLDocument {
  return new DOMParser().parseFromString(decodeXmlBytes(bytes), 'text/xml')
}

/** 元素下所有指定局部名的后代。 */
export function tagsOf(element: Element, local: string): Element[] {
  return Array.from(element.getElementsByTagName('*')).filter(node => node.localName === local)
}

/**
 * 元素的去除首尾空白的文本。textContent 在 XML 无子节点时运行时为 null，
 * 而 DOM 类型将其声明为 string，这里以宽化收窄保住运行时真相。
 * @param element - 携带文本的元素。
 * @returns 文本（可为空串）。
 */
export function textOf(element: Element): string {
  const text = element.textContent as string | null
  return (text ?? '').trim()
}

/**
 * 列表首元素的文本；运行时索引可能越界，经宽化收窄后按缺失处理。
 * @param elements - 候选元素。
 * @returns 首元素文本，缺省为空串。
 */
export function firstTextOf(elements: readonly Element[]): string {
  const first = elements[0]
  return first !== undefined ? textOf(first) : ''
}

/**
 * 解析 OFD 包描述，找到文档清单的 zip 路径。GB/T 33190 的容器元素是
 * DocPath（顺带兼容写错成 EPUB full-path 的产出方）；无容器时回落 OFD.xml。
 * 实务中还存在合包形态：OFD.xml 根元素即 ofd:OFD 包描述，真正的文档
 * 由 DocBody/DocRoot 指向（如税局 Suwell 产出），此处一并跟随。
 * @param entries - 解包后的 OFD 条目映射。
 * @returns 文档清单路径。
 */
export function documentPathOf(entries: Map<string, Uint8Array>): string {
  let path = 'OFD.xml'
  const container = entries.get('META-INF/container.xml')
  if (container !== undefined) {
    const containerDocument = parseXml(container)
    const declared = firstTextOf(tagsOf(containerDocument.documentElement, 'DocPath'))
      || firstTextOf(tagsOf(containerDocument.documentElement, 'FullPath'))
    if (declared.length > 0) path = declared
  }
  const bytes = entries.get(path)
  if (bytes === undefined) return path
  const documentRoot = parseXml(bytes).documentElement
  const docRoot = firstTextOf(tagsOf(documentRoot, 'DocRoot'))
  if (docRoot.length > 0) return resolveAgainst(directoryOf(path), docRoot)
  return path
}

/** 路径的目录部分（无目录时为空串）。 */
export function directoryOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at + 1)
}

/** 以 base 目录解析相对路径；绝对形态去掉开头斜杠后按 zip 根处理。 */
export function resolveAgainst(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1)
  return `${base}${relative}`
}

/**
 * 读取一页的 Content.xml 字节：BaseLoc 指向页目录时拼 /Content.xml，
 * 已是文件路径时直接命中。
 */
export function pageBytesOf(entries: Map<string, Uint8Array>, baseDirectory: string, base: string): Uint8Array | undefined {
  if (base.startsWith('/')) return entries.get(base.slice(1))
  return entries.get(resolveAgainst(baseDirectory, `${base}/Content.xml`))
    ?? entries.get(resolveAgainst(baseDirectory, base))
}
