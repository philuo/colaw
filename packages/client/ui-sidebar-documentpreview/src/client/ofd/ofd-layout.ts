/**
 * OFD（GB/T 33190）版式解析——参照 ofd.js 参考实现的实务形态：
 * 页面尺寸（Page/Area/PhysicalBox）、模板层 + 内容层的图层顺序、
 * 文本对象按基线分组（DeltaX/DeltaY 逐字定位）、矢量路径与图片资源。
 * 片段坐标一律毫米，边界框内为局部坐标，由渲染侧按页面尺寸等比缩放。
 */

import { unzipEntries } from './zip.ts'
import { tagsOf, documentPathOf, parseXml, directoryOf, resolveAgainst, textOf, firstTextOf, pageBytesOf } from './ofd-document.ts'

/** 一条基线文本：TextObject 局部坐标系内的基线起点与同行文本。 */
export interface OfdTextRun {
  readonly xMm: number
  readonly yMm: number
  readonly text: string
}

/** 文本对象：边界框内一组基线文本（SVG 视口即边界框）。 */
export interface OfdTextFragment {
  readonly kind: 'text'
  readonly xMm: number
  readonly yMm: number
  readonly wMm: number
  readonly hMm: number
  readonly sizeMm: number
  readonly fill?: string
  readonly ctm?: readonly number[]
  readonly hScale?: number
  readonly runs: readonly OfdTextRun[]
}

/** 图片对象：ResourceID 经资源清单解析为数据 URL；解析不到时 url 缺省。 */
export interface OfdImageFragment {
  readonly kind: 'image'
  readonly xMm: number
  readonly yMm: number
  readonly wMm: number
  readonly hMm: number
  readonly url?: string
}

/** 矢量路径对象：AbbreviatedData 即局部坐标的 SVG path。 */
export interface OfdPathFragment {
  readonly kind: 'path'
  readonly xMm: number
  readonly yMm: number
  readonly wMm: number
  readonly hMm: number
  readonly d: string
  readonly stroke?: string
  readonly fill?: string
  readonly lineWidthMm?: number
  readonly ctm?: readonly number[]
}

/** 一页的版式：物理尺寸与按文档顺序的定位片段。 */
export interface OfdLayoutPage {
  readonly widthMm: number
  readonly heightMm: number
  readonly fragments: readonly OfdFragment[]
}

/** 解析 Boundary="x y w h"（毫米浮点）。 */
function boundaryOf(element: Element): { x: number; y: number; w: number; h: number } {
  const parts = (element.getAttribute('Boundary') ?? '').trim().split(/\s+/)
  const [x = 0, y = 0, w = 0, h = 0] = parts.map(Number)
  return { x, y, w, h }
}

/** 解析 CTM="a b c d e f" 六元组。 */
function ctmOf(element: Element): number[] | undefined {
  const ctm = element.getAttribute('CTM')
  if (ctm === null) return undefined
  const values = ctm.trim().split(/\s+/).map(Number)
  return values.length === 6 && values.every(Number.isFinite) ? values : undefined
}

/** 颜色值："r g b"（0-255）或 #hex。 */
function colorOf(value: string | null): string | undefined {
  if (value === null || value.trim().length === 0) return undefined
  if (value.includes('#')) return `#${value.replaceAll('#', '').replaceAll(' ', '')}`
  const channels = value.trim().split(/\s+/).map(Number)
  return channels.length === 3 && channels.every(Number.isFinite)
    ? `rgb(${channels.map(channel => Math.round(channel)).join(', ')})`
    : undefined
}

/** 对象填充色：FillColor 子元素的 Value/Alpha。 */
function fillOf(element: Element): string | undefined {
  const fillColor = tagsOf(element, 'FillColor')[0]
  if (fillColor === undefined) return undefined
  const color = colorOf(fillColor.getAttribute('Value'))
  if (color === undefined) return undefined
  const alpha = Number(fillColor.getAttribute('Alpha'))
  if (Number.isFinite(alpha) && alpha > 0 && alpha < 255) {
    return color.replace('rgb(', 'rgba(').replace(')', `, ${(alpha / 255).toFixed(3)})`)
  }
  return color
}

/**
 * DeltaX/DeltaY 展开：空白分隔浮点，或 "g N v" 表示 N 个 v
 * （与 ofd.js deltaFormatter 一致）。
 */
function deltasOf(delta: string): number[] {
  const tokens = delta.trim().split(/\s+/)
  if (!tokens.includes('g')) {
    return tokens.map(Number)
  }
  const values: number[] = []
  let groupCount = 0
  let inGroup = false
  for (const token of tokens) {
    if (token === 'g') {
      inGroup = false
      continue
    }
    if (token.length === 0) continue
    if (inGroup) {
      for (let at = 0; at < groupCount; at++) values.push(Number(token))
      inGroup = false
    } else {
      const count = Number.parseInt(token, 10)
      if (Number.isFinite(count)) {
        groupCount = count
        inGroup = true
      }
    }
  }
  return values
}

/**
 * 文本对象 → 基线文本行（与 ofd.js calTextPoint 一致）：
 * TextCode@X/Y 为首字形基线（缺省 0），DeltaX/DeltaY 逐字累计；
 * 基线相同的字符合并为一行文本。
 */
function textRunsOf(textObject: Element): OfdTextRun[] {
  const runs: OfdTextRun[] = []
  for (const textCode of tagsOf(textObject, 'TextCode')) {
    const content = textOf(textCode)
    if (content.length === 0) continue
    let x = Number(textCode.getAttribute('X'))
    let y = Number(textCode.getAttribute('Y'))
    if (!Number.isFinite(x)) x = 0
    if (!Number.isFinite(y)) y = 0
    const deltaX = deltasOf(textCode.getAttribute('DeltaX') ?? '')
    const deltaY = deltasOf(textCode.getAttribute('DeltaY') ?? '')
    for (let at = 0; at < content.length; at++) {
      if (at > 0 && deltaX.length > 0) x += deltaX[at - 1] ?? 0
      if (at > 0 && deltaY.length > 0) y += deltaY[at - 1] ?? 0
      const glyph = content.charAt(at)
      const existing = runs.find(run => run.yMm === y)
      if (existing !== undefined) {
        Object.assign(existing, { text: existing.text + glyph })
      } else {
        runs.push({ xMm: x, yMm: y, text: glyph })
      }
    }
  }
  return runs
}

/**
 * AbbreviatedData → SVG path d（局部毫米坐标）。
 * 指令：M/L 绝对直线，B 三次贝塞尔，C 闭合。
 */
function pathDataOf(abbreviated: string): string {
  const tokens = abbreviated.trim().split(/[\s,]+/).filter(token => token.length > 0)
  const commands: string[] = []
  let at = 0
  const nextNumber = (): number => Number(tokens[at++] ?? 0)
  while (at < tokens.length) {
    const command = tokens[at]
    at += 1
    if (command === undefined) break
    if (command === 'M' || command === 'L') {
      const x = nextNumber()
      const y = nextNumber()
      commands.push(`${command}${x} ${y}`)
    } else if (command === 'B') {
      const x1 = nextNumber()
      const y1 = nextNumber()
      const x2 = nextNumber()
      const y2 = nextNumber()
      const x3 = nextNumber()
      const y3 = nextNumber()
      commands.push(`C${x1} ${y1} ${x2} ${y2} ${x3} ${y3}`)
    } else if (command === 'C') {
      commands.push('Z')
    }
  }
  return commands.join(' ')
}

/** 图片扩展名到 data URL 的 MIME。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpx: 'image/jpx',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

/** 字节编码为 data URL（无法识别的扩展名返回 undefined）。 */
function dataUrlOf(bytes: Uint8Array, path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIME[extension]
  if (mime === undefined) return undefined
  let binary = ''
  const quantum = 0x8000
  for (let at = 0; at < bytes.length; at += quantum) {
    binary += String.fromCharCode(...bytes.subarray(at, at + quantum))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * 从文档清单的 Res/PublicRes 清单构建 ResourceID → data URL。
 * 清单以 Res@BaseLoc 属性或元素文本（Suwell 形态）指向清单 XML；
 * 图片 Loc 在 MultiMedia 子元素的 Loc 属性或 MediaFile 文本上，
 * 以清单根元素 BaseLoc（缺省清单所在目录）为基准目录。
 */
function imageTableOf(entries: Map<string, Uint8Array>, documentPath: string): Map<string, string> {
  const table = new Map<string, string>()
  const documentDirectory = directoryOf(documentPath)
  const document = parseXml(entries.get(documentPath) ?? new Uint8Array())
  const listElements = [
    ...tagsOf(document.documentElement, 'PublicRes'),
    ...tagsOf(document.documentElement, 'DocumentRes'),
    ...tagsOf(document.documentElement, 'Res'),
  ]
  for (const listElement of listElements) {
    const listLoc = listElement.getAttribute('BaseLoc') ?? firstTextOf([listElement])
    if (listLoc.length === 0) continue
    const listPath = resolveAgainst(documentDirectory, listLoc)
    const listBytes = entries.get(listPath)
    if (listBytes === undefined) continue
    const listDocument = parseXml(listBytes)
    const rootBaseLoc = listDocument.documentElement.getAttribute('BaseLoc')
    // 基准保持目录形态（尾斜杠），后续拼相对文件名。
    const joined = rootBaseLoc !== null ? resolveAgainst(directoryOf(listPath), rootBaseLoc) : directoryOf(listPath)
    const baseDirectory = joined.endsWith('/') ? joined : `${joined}/`
    for (const media of tagsOf(listDocument.documentElement, 'MultiMedia')) {
      const id = media.getAttribute('ID')
      if (id === null) continue
      for (const child of Array.from(media.children)) {
        const attrLoc = child.getAttribute('Loc')
        const loc = attrLoc !== null && attrLoc.length > 0 ? attrLoc : textOf(child)
        if (loc.length === 0) continue
        const imagePath = resolveAgainst(baseDirectory, loc)
        const imageBytes = entries.get(imagePath)
        const url = imageBytes !== undefined ? dataUrlOf(imageBytes, imagePath) : undefined
        if (url !== undefined) table.set(id, url)
        break
      }
    }
  }
  return table
}

/**
 * 文档模板页表：TemplatePage@ID → 其 Content.xml 文档
 * （模板文件本身就是一页，图层在其 Content 下）。
 */
function templatesOf(entries: Map<string, Uint8Array>, document: XMLDocument, documentDirectory: string): Map<string, XMLDocument> {
  const templates = new Map<string, XMLDocument>()
  for (const templatePage of tagsOf(document.documentElement, 'TemplatePage')) {
    const id = templatePage.getAttribute('ID')
    const base = templatePage.getAttribute('BaseLoc')
    if (id === null || base === null) continue
    const bytes = pageBytesOf(entries, documentDirectory, base)
    if (bytes === undefined) continue
    templates.set(id, parseXml(bytes))
  }
  return templates
}

/**
 * 一个图层的定位片段。图层内按参考实现顺序：图片、路径、文本；
 * 同类对象保持文档顺序。
 */
function layerFragmentsOf(layer: Element, images: ReadonlyMap<string, string>): OfdFragment[] {
  const fragments: OfdFragment[] = []
  for (const imageObject of tagsOf(layer, 'ImageObject')) {
    const boundary = boundaryOf(imageObject)
    if (boundary.w <= 0 || boundary.h <= 0) continue
    const resourceId = imageObject.getAttribute('ResourceID')
    const url = resourceId !== null ? images.get(resourceId) : undefined
    fragments.push({ kind: 'image', xMm: boundary.x, yMm: boundary.y, wMm: boundary.w, hMm: boundary.h, ...(url !== undefined ? { url } : {}) })
  }
  for (const pathObject of tagsOf(layer, 'PathObject')) {
    const boundary = boundaryOf(pathObject)
    const abbreviated = firstTextOf(tagsOf(pathObject, 'AbbreviatedData'))
    if (abbreviated.length === 0 || boundary.w <= 0 || boundary.h <= 0) continue
    const strokeColor = colorOf(tagsOf(pathObject, 'StrokeColor')[0]?.getAttribute('Value') ?? null)
    const lineWidth = Number(pathObject.getAttribute('LineWidth'))
    const fill = fillOf(pathObject)
    const ctm = ctmOf(pathObject)
    fragments.push({
      kind: 'path',
      xMm: boundary.x,
      yMm: boundary.y,
      wMm: boundary.w,
      hMm: boundary.h,
      d: pathDataOf(abbreviated),
      ...(fill !== undefined ? { fill } : {}),
      ...(strokeColor !== undefined ? { stroke: strokeColor } : {}),
      ...(Number.isFinite(lineWidth) && lineWidth > 0 ? { lineWidthMm: lineWidth } : {}),
      ...(ctm !== undefined ? { ctm } : {}),
    })
  }
  for (const textObject of tagsOf(layer, 'TextObject')) {
    const boundary = boundaryOf(textObject)
    const runs = textRunsOf(textObject)
    if (runs.length === 0 || boundary.w <= 0 || boundary.h <= 0) continue
    // TextObject@Size 是规格中的字符大小；缺省约五号字（3.7mm）。
    const objectSize = Number(textObject.getAttribute('Size'))
    const sizeMm = Number.isFinite(objectSize) && objectSize > 0 ? objectSize : 3.7
    const hScale = Number(textObject.getAttribute('HScale'))
    const fill = fillOf(textObject)
    const ctm = ctmOf(textObject)
    fragments.push({
      kind: 'text',
      xMm: boundary.x,
      yMm: boundary.y,
      wMm: boundary.w,
      hMm: boundary.h,
      sizeMm,
      ...(fill !== undefined ? { fill } : {}),
      ...(ctm !== undefined ? { ctm } : {}),
      ...(Number.isFinite(hScale) && hScale > 0 && hScale !== 1 ? { hScale } : {}),
      runs,
    })
  }
  return fragments
}

/** 一个版式片段：文本、图片或矢量路径。 */
export type OfdFragment = OfdTextFragment | OfdImageFragment | OfdPathFragment

/**
 * 解析一页的定位片段：模板层（背景）先行，内容层随后。
 * @param content - 页面 Content.xml 文档。
 * @param images - ResourceID → data URL。
 * @param templates - TemplatePage@ID → 模板页文档。
 * @returns 该页的定位片段。
 */
export function pageFragmentsOf(
  content: XMLDocument,
  images: ReadonlyMap<string, string>,
  templates: ReadonlyMap<string, XMLDocument> = new Map(),
): OfdFragment[] {
  const fragments: OfdFragment[] = []
  const root = content.documentElement
  for (const template of tagsOf(root, 'Template')) {
    const templateId = template.getAttribute('TemplateID')
    const templateDocument = templateId !== null ? templates.get(templateId) : undefined
    if (templateDocument === undefined) continue
    for (const layer of tagsOf(templateDocument.documentElement, 'Layer')) {
      fragments.push(...layerFragmentsOf(layer, images))
    }
  }
  for (const layer of tagsOf(root, 'Layer')) {
    fragments.push(...layerFragmentsOf(layer, images))
  }
  return fragments
}

/**
 * 解析页面物理尺寸（毫米）。来源优先级：Page@PhysicalBox 属性 →
 * Content 里 Area/PhysicalBox 元素文本（税局产出把尺寸放在页内容里）→ A4。
 */
function pageSizeOf(pageElement: Element, content: XMLDocument | undefined): { widthMm: number; heightMm: number } {
  const declared = pageElement.getAttribute('PhysicalBox')
    ?? (content === undefined ? null : (box => (box === undefined ? null : textOf(box)))(
      tagsOf(content.documentElement, 'PhysicalBox')
        .find(node => (node.parentNode as Element | null)?.localName === 'Area') ?? tagsOf(content.documentElement, 'PhysicalBox')[0],
    ))
  const box = (declared ?? '').trim().split(/\s+/)
  const widthMm = Number(box[2])
  const heightMm = Number(box[3])
  if (Number.isFinite(widthMm) && widthMm > 0 && Number.isFinite(heightMm) && heightMm > 0) {
    return { widthMm, heightMm }
  }
  return { widthMm: 210, heightMm: 297 }
}

/**
 * 解析 OFD 的版式：页面物理尺寸 + 模板层与内容层的定位片段。
 * @param entries - 解包后的 OFD 条目映射。
 * @returns 按页序排列的版式页。
 */
export function ofdLayoutPages(entries: Map<string, Uint8Array>): readonly OfdLayoutPage[] {
  const documentPath = documentPathOf(entries)
  const documentDirectory = directoryOf(documentPath)
  const document = parseXml(entries.get(documentPath) ?? new Uint8Array())
  const images = imageTableOf(entries, documentPath)
  const templates = templatesOf(entries, document, documentDirectory)
  const pageElements = tagsOf(document.documentElement, 'Page')
  return pageElements.map((pageElement, index) => {
    const base = pageElement.getAttribute('BaseLoc') ?? `Pages/Page_${index}`
    const contentBytes = pageBytesOf(entries, documentDirectory, base)
    const content = contentBytes !== undefined ? parseXml(contentBytes) : undefined
    return {
      ...pageSizeOf(pageElement, content),
      fragments: content !== undefined ? pageFragmentsOf(content, images, templates) : [],
    }
  })
}

/**
 * 打开一个 OFD 文件并解析版式。
 * @param data - OFD 文件字节。
 * @returns 按页序排列的版式页。
 */
export async function readOfdLayout(data: Uint8Array): Promise<readonly OfdLayoutPage[]> {
  const entries = await unzipEntries(data)
  return ofdLayoutPages(entries)
}
