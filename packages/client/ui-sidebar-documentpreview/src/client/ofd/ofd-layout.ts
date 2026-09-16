/**
 * OFD（GB/T 33190）版式骨架解析：页面物理尺寸、定位文本行与图片资源。
 * 坐标单位是毫米；矢量路径、字形定位与字体内嵌按需逐步增强。
 */

import { unzipEntries } from './zip.ts'
import { tagsOf, documentPathOf, parseXml, directoryOf, resolveAgainst, textOf } from './ofd-document.ts'

/** 一段定位文本行：TextObject 边界内按 TextCode 起始或顺序下移放置。 */
export interface OfdTextFragment {
  readonly kind: 'text'
  readonly xMm: number
  readonly yMm: number
  readonly sizeMm: number
  readonly text: string
}

/** 一张定位图片：ResourceID 经资源清单解析为数据 URL；解析不到时 url 缺省。 */
export interface OfdImageFragment {
  readonly kind: 'image'
  readonly xMm: number
  readonly yMm: number
  readonly wMm: number
  readonly hMm: number
  readonly url?: string
}

/** 一页的版式骨架：物理尺寸与绝对定位片段。 */
export interface OfdLayoutPage {
  readonly widthMm: number
  readonly heightMm: number
  readonly fragments: readonly (OfdTextFragment | OfdImageFragment)[]
}

/** 解析 Boundary="x y w h"（毫米浮点）。 */
function boundaryOf(element: Element): { x: number; y: number; w: number; h: number } {
  const parts = (element.getAttribute('Boundary') ?? '').trim().split(/\s+/)
  const [x = 0, y = 0, w = 0, h = 0] = parts.map(Number)
  return { x, y, w, h }
}

/** 解析 PhysicalBox="0 0 w h"，回落 A4。 */
function pageSizeOf(pageElement: Element): { widthMm: number; heightMm: number } {
  const box = (pageElement.getAttribute('PhysicalBox') ?? '').trim().split(/\s+/)
  const widthMm = Number(box[2])
  const heightMm = Number(box[3])
  if (Number.isFinite(widthMm) && widthMm > 0 && Number.isFinite(heightMm) && heightMm > 0) {
    return { widthMm, heightMm }
  }
  return { widthMm: 210, heightMm: 297 }
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
 * 资源清单是 Res@BaseLoc 指向的 XML；图片条目是 MultiMedia（ID、Type=Image）
 * 带 Loc 的子元素，Loc 相对清单文件所在目录。
 */
function imageTableOf(entries: Map<string, Uint8Array>, documentPath: string): Map<string, string> {
  const table = new Map<string, string>()
  const documentDirectory = directoryOf(documentPath)
  const document = parseXml(entries.get(documentPath) ?? new Uint8Array())
  const listElements = [
    ...tagsOf(document.documentElement, 'PublicRes'),
    ...tagsOf(document.documentElement, 'Res'),
  ]
  for (const listElement of listElements) {
    const listLoc = listElement.getAttribute('BaseLoc')
    if (listLoc === null) continue
    const listPath = resolveAgainst(documentDirectory, listLoc)
    const listBytes = entries.get(listPath)
    if (listBytes === undefined) continue
    const listDirectory = directoryOf(listPath)
    for (const media of tagsOf(parseXml(listBytes).documentElement, 'MultiMedia')) {
      const id = media.getAttribute('ID')
      if (id === null) continue
      for (const child of Array.from(media.children)) {
        const loc = child.getAttribute('Loc')
        if (loc === null) continue
        const imagePath = resolveAgainst(listDirectory, loc)
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
 * 解析一页 Content.xml 的定位片段：文本行按 TextCode 起始或顺序下移，
 * 图片按资源清单回填数据 URL（解析不到时保留占位框位置）。
 * @param content - 页面 Content.xml 文档。
 * @param images - ResourceID → data URL。
 * @returns 该页的定位片段。
 */
export function pageFragmentsOf(content: XMLDocument, images: ReadonlyMap<string, string>): (OfdTextFragment | OfdImageFragment)[] {
  const fragments: (OfdTextFragment | OfdImageFragment)[] = []
  const root = content.documentElement
  for (const textObject of tagsOf(root, 'TextObject')) {
    const boundary = boundaryOf(textObject)
    const objectSize = Number(textObject.getAttribute('Size'))
    const textCodes = tagsOf(textObject, 'TextCode').filter(code => textOf(code).length > 0)
    textCodes.forEach((code, line) => {
      // TextObject@Size 是规格中的字符大小；个别产出方落在 TextCode 上，兜底约五号字。
      const sizeMm = [objectSize, Number(code.getAttribute('Size'))].find(Number.isFinite) ?? 3.7
      const declaredY = code.getAttribute('Y')
      const offsetY = declaredY !== null && Number.isFinite(Number(declaredY))
        ? Number(declaredY)
        : line * sizeMm * 1.5
      fragments.push({
        kind: 'text',
        xMm: boundary.x + (Number(code.getAttribute('X')) || 0),
        yMm: boundary.y + offsetY,
        sizeMm,
        text: textOf(code),
      })
    })
  }
  for (const imageObject of tagsOf(root, 'ImageObject')) {
    const boundary = boundaryOf(imageObject)
    if (boundary.w <= 0 || boundary.h <= 0) continue
    const resourceId = imageObject.getAttribute('ResourceID')
    const url = resourceId !== null ? images.get(resourceId) : undefined
    fragments.push({ kind: 'image', xMm: boundary.x, yMm: boundary.y, wMm: boundary.w, hMm: boundary.h, ...(url !== undefined ? { url } : {}) })
  }
  return fragments
}

/**
 * 解析 OFD 的版式骨架：页面物理尺寸 + 定位文本行与图片。
 * @param entries - 解包后的 OFD 条目映射。
 * @returns 按页序排列的版式页。
 */
export function ofdLayoutPages(entries: Map<string, Uint8Array>): readonly OfdLayoutPage[] {
  const documentPath = documentPathOf(entries)
  const documentDirectory = directoryOf(documentPath)
  const document = parseXml(entries.get(documentPath) ?? new Uint8Array())
  const images = imageTableOf(entries, documentPath)
  const pageElements = tagsOf(document.documentElement, 'Page')
  return pageElements.map((pageElement, index) => {
    const base = pageElement.getAttribute('BaseLoc') ?? `Pages/Page_${index}`
    const contentPath = resolveAgainst(documentDirectory, `${base}/Content.xml`)
    const contentBytes = entries.get(contentPath)
    const { widthMm, heightMm } = pageSizeOf(pageElement)
    return {
      widthMm,
      heightMm,
      fragments: contentBytes !== undefined ? pageFragmentsOf(parseXml(contentBytes), images) : [],
    }
  })
}

/**
 * 打开一个 OFD 文件并解析版式骨架。
 * @param data - OFD 文件字节。
 * @returns 按页序排列的版式页。
 */
export async function readOfdLayout(data: Uint8Array): Promise<readonly OfdLayoutPage[]> {
  const entries = await unzipEntries(data)
  return ofdLayoutPages(entries)
}
