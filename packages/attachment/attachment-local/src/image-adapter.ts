/**
 * sharp 的语义子集 —— 由 Bun.Image（像素管线，主线程外执行）+ ImageIO FFI
 * （容器级元数据与解码验证）实现，替代 sharp/libvips 的 17.7MB 原生依赖。
 *
 * 只覆盖 attachment-local 实际调用的 API 面；每一处行为差异都以实测为准：
 * - 色彩空间：Bun 解码时自动转换到 sRGB（CMYK JPEG 实测 ✓），`toColourspace('srgb')` 因此是标记位；
 * - 位深：16-bit 输入由 Bun 自动降为 8-bit（实测 ✓）；
 * - EXIF 方向：Bun 的 `autoOrient`（默认开启）在像素操作前应用，`rotate()` 是标记位；
 * - `clone()`：Bun.Image 不可变链式（每个方法返回新实例），共享实例即可；
 * - `resize`：`fit:'inside'`/`withoutEnlargement` 由 Bun 内建（文档 ✓）；
 * - quality：必须对象形式 `{quality}` —— 位置参数被静默忽略（实测 ❌）。
 * 元数据深字段（orientation/pages/depth/hasAlpha/七项存在性）来自 ImageIO FFI
 * （`./imageio-ffi.ts`），因为 Bun.Image 的 metadata 只有 width/height/format。
 * @module
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import {
  imageSourceOf,
  framePropertiesOf,
  mediaTypeOf,
  decodedFactsOf,
  type ImageSource,
  GRAY_MODEL,
  RGB_MODEL,
  CMYK_MODEL,
} from './imageio-ffi.ts'

/** sharp 的 Image 元数据 —— 字段名与值域对齐业务的消费面（DetectedImage）。 */
export interface AdapterMetadata {
  format?: string | undefined
  width?: number | undefined
  height?: number | undefined
  space?: string | undefined
  depth?: string | undefined
  hasAlpha?: boolean | undefined
  orientation?: number | undefined
  pages?: number | undefined
  exif?: object | undefined
  xmp?: object | undefined
  iptc?: object | undefined
  icc?: object | undefined
  hasProfile?: boolean | undefined
  tifftagPhotoshop?: object | undefined
  comments?: object | undefined
}

/** sharp 的 `toBuffer({resolveWithObject})` 返回形状。 */
export interface AdapterEncoded {
  data: Uint8Array
  info: { width: number; height: number }
}

/** sharp 的管线接口 —— 业务与质量阶梯只消费这些成员。 */
export interface AdapterLimits {
  maxPixels?: number
  maxDimension?: number
}

export interface AdapterPipeline {
  /** 仅容器级元数据（不解码像素）。 */
  probe(): Promise<AdapterMetadata>
  /** 容器级元数据 + 像素物化（完整性证明 + depth/space 真值）。 */
  metadata(): Promise<AdapterMetadata>
  /**
   * admission 的单次打开路径：容器事实 → limits 从头声明尺寸先行检查 →
   * 像素物化（完整性证明 + 真值）。一次 source 打开，无双开冗余。
   */
  detect(limits?: AdapterLimits): Promise<AdapterMetadata>
  raw(): { toBuffer(): Promise<Uint8Array> }
  rotate(): AdapterPipeline
  toColourspace(space: 'srgb'): AdapterPipeline
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: true }): AdapterPipeline
  clone(): AdapterPipeline
  webp(options: { quality: number; effort?: number }): Promise<AdapterEncoded>
  jpeg(options: { quality: number }): Promise<AdapterEncoded>
}

/** sharp 构造选项的子集。 */
export interface AdapterOptions {
  /** sharp 的 limitInputPixels —— false 关闭像素数上限（Bun 侧 maxPixels 相应放宽）。 */
  limitInputPixels?: number | false
  /** sharp 的 failOn:'error' —— Bun.Image 解码失败即抛，行为一致，无开关。 */
  failOn?: 'error'
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** CGColorSpaceModel → sharp 的 space 值域。Gray/CMYK 的精确字面量不影响业务（只与 'srgb' 比较）。 */
function spaceOf(model: number, bitsPerComponent: number): string {
  if (model === GRAY_MODEL) return 'b-w'
  if (model === CMYK_MODEL) return 'cmyk'
  return bitsPerComponent === 16 ? 'rgb16' : 'srgb'
}

/** ImageIO 属性字典 → sharp 的 depth 值域（业务只区分 uchar/ushort）。 */
function depthOf(bitsPerComponent: number): string {
  return bitsPerComponent === 16 ? 'ushort' : 'uchar'
}

/** 统一编码出口：格式方法返回新的 Image 实例（toBuffer 取字节）；bytes() 直接返回像素 Uint8Array。 */
async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value
  const image = value as { toBuffer?: () => Promise<Buffer> }
  if (typeof image.toBuffer === 'function') return new Uint8Array(await image.toBuffer())
  throw new Error(`image-adapter: unknown encoder output ${String((value as { constructor?: { name?: string } }).constructor?.name ?? typeof value)}`)
}



function indexOfSubsequence(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let start = from; start <= haystack.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer
    }
    return start
  }
  return -1
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

/**
 * JPEG 段游标：SOI 之后逐段（FFEn + 2 字节长度），SOS/EOI 之后的熵编码数据原样保留。
 * 回调返回 true 的段被剥除。
 */
function mapJpegSegments(data: Uint8Array, drop: (marker: number, payload: Uint8Array) => boolean): Uint8Array {
  const chunks: Uint8Array[] = [data.subarray(0, 2)]
  let i = 2
  while (i + 4 <= data.length && data[i] === 0xff) {
    const marker = data[i + 1] ?? 0
    if (marker === 0xd9 || marker === 0xda) { chunks.push(data.subarray(i)); return concat(chunks) }
    const length = ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)
    const segmentEnd = i + 2 + length
    const payload = data.subarray(i + 4, segmentEnd)
    if (!drop(marker, payload)) chunks.push(data.subarray(i, segmentEnd))
    i = segmentEnd
  }
  return concat(chunks)
}

function stripJpegIcc(data: Uint8Array): Uint8Array {
  return mapJpegSegments(data, (marker, payload) => {
    if (marker !== 0xe2) return false
    const markerOffset = indexOfSubsequence(payload, ICC_MARKER)
    if (markerOffset !== 0) return false
    // 一个 profile 可拆进多个同序号 APP2 段：只剥携带 ICC_PROFILE 头的段。
    return true
  })
}

function stripPngIcc(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [data.subarray(0, 8)]
  let i = 8
  while (i + 12 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + i)
    const length = view.getUint32(0)
    const type = String.fromCharCode(data[i + 4] ?? 0, data[i + 5] ?? 0, data[i + 6] ?? 0, data[i + 7] ?? 0)
    const chunkEnd = i + 12 + length
    if (type === 'iCCP') { i = chunkEnd; continue }
    if (chunkEnd > data.length) break
    chunks.push(data.subarray(i, chunkEnd))
    i = chunkEnd
  }
  return concat(chunks)
}

/** WebP 的 `VP8X` 标志字节里声明「本文件带 ICC profile」的那一位。 */
const WEBP_VP8X_ICC_FLAG = 0x20

/**
 * 剥除 WebP 内嵌 ICC：RIFF 容器里去掉 `ICCP` chunk、按新长度回写 RIFF 头，
 * 并清掉 `VP8X` 的 ICC 标志位 —— 只删 chunk 会留下一个仍声明「带 profile」
 * 的容器。每个 chunk 的 payload 按偶数长度对齐（奇数补 1 字节），新长度必须
 * 把这些 padding 一起算进去。
 */
function stripWebpIcc(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [data.subarray(0, 12)]
  let i = 12
  while (i + 8 <= data.length) {
    const type = String.fromCharCode(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0)
    const view = new DataView(data.buffer, data.byteOffset + i)
    const length = view.getUint32(4, true)
    const chunkEnd = i + 8 + length + (length % 2)
    // A chunk past the end means the tail is not structured as declared; keep
    // it verbatim rather than dropping bytes the container still refers to.
    if (chunkEnd > data.length) { chunks.push(data.subarray(i)); break }
    if (type !== 'ICCP') {
      const chunk = data.subarray(i, chunkEnd)
      if (type === 'VP8X' && length >= 1) {
        const cleared = chunk.slice()
        cleared[8] = (cleared[8] ?? 0) & ~WEBP_VP8X_ICC_FLAG
        chunks.push(cleared)
      } else {
        chunks.push(chunk)
      }
    }
    i = chunkEnd
  }
  const out = concat(chunks)
  // RIFF size counts everything after the 8-byte prefix.
  new DataView(out.buffer, out.byteOffset).setUint32(4, out.length - 8, true)
  return out
}

/** 剥除内嵌 ICC（JPEG 的 APP2 ICC_PROFILE 段 / PNG 的 iCCP chunk / WebP 的 ICCP chunk）—— Bun 编码器会嵌入 ColorSync 默认 sRGB，而 sharp 的输出不带。 */
function stripIccProfile(data: Uint8Array, format: string): Uint8Array {
  if (format === 'jpeg') return stripJpegIcc(data)
  if (format === 'png') return stripPngIcc(data)
  if (format === 'webp') return stripWebpIcc(data)
  return data
}

const ICC_MARKER = new TextEncoder().encode('ICC_PROFILE\x00')

function matchesAt(data: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > data.length) return false
  for (let index = 0; index < needle.length; index += 1) {
    if (data[offset + index] !== needle[index]) return false
  }
  return true
}

/**
 * Whether the container embeds a real ICC profile chunk, detected by a
 * structured header walk instead of a whole-buffer byte scan:
 * - JPEG: APP segments before SOS; ICC lives in APP2 payloads that start with
 *   `ICC_PROFILE\0` (a profile may be split across several such segments).
 * - PNG: chunks before IDAT; `iCCP` must precede the first IDAT per spec.
 * - WebP: RIFF chunks before the image payload; `ICCP` chunk (extended format).
 * ImageIO's `profileName` cannot be used for this — it reports ColorSync's
 * default sRGB even for files with no embedded profile, which misclassifies
 * every clean JPEG as metadata-carrying. GIF cannot carry an ICC profile.
 */
function hasEmbeddedIccProfile(data: Uint8Array): boolean {
  // JPEG: SOI (FFD8) then a marker chain
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i + 4 <= data.length && data[i] === 0xff) {
      const marker = data[i + 1] ?? 0
      if (marker === 0xda || marker === 0xd9) return false // SOS/EOI: APP segments are over
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue } // standalone
      const length = ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)
      if (marker === 0xe2 && matchesAt(data, i + 4, ICC_MARKER)) return true
      i += 2 + length
    }
    return false
  }
  // PNG: 8-byte signature then a chunk chain
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    let i = 8
    while (i + 8 <= data.length) {
      const view = new DataView(data.buffer, data.byteOffset + i)
      const length = view.getUint32(0)
      const type = String.fromCharCode(data[i + 4] ?? 0, data[i + 5] ?? 0, data[i + 6] ?? 0, data[i + 7] ?? 0)
      if (type === 'iCCP') return true
      if (type === 'IDAT' || type === 'IEND') return false // iCCP must precede IDAT
      const chunkEnd = i + 12 + length
      if (chunkEnd > data.length) return false
      i = chunkEnd
    }
    return false
  }
  // WebP: RIFF container, ICCP chunk before the image payload chunk
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    let i = 12
    while (i + 8 <= data.length) {
      const type = String.fromCharCode(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0)
      const view = new DataView(data.buffer, data.byteOffset + i)
      const length = view.getUint32(4, true)
      if (type === 'ICCP') return true
      const chunkEnd = i + 8 + length + (length % 2)
      if (chunkEnd > data.length) return false
      i = chunkEnd
    }
    return false
  }
  return false
}

/** ImageIO ColorModel 字符串 → CGColorSpaceModel 数值（供 spaceOf 复用）。 */
const COLOR_MODEL_TO_SPACE_MODEL: Readonly<Record<string, number>> = {
  RGB: RGB_MODEL,
  Gray: GRAY_MODEL,
  CMYK: CMYK_MODEL,
}

/** 从已打开的 source 读容器级元数据（不解码像素）：format/尺寸/orientation/帧数/七项存在性/depth/space 近似真值。 */
function containerFromSource(source: ImageSource, data: Uint8Array): AdapterMetadata {
  const props = framePropertiesOf(source)
  const mediaType = mediaTypeOf(source)
  const format = mediaType === undefined ? undefined : mediaType.slice('image/'.length)
  if (format === undefined || MEDIA_TYPES[format] === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  const hasProfile = hasEmbeddedIccProfile(data)
  // depth/space 的容器近似值：属性字典的 Depth 键与 sharp 的口径不完全一致
  // （个别 16-bit 容器可能报 8），admission 路径由解码后的 decodedFactsOf 矫正；
  // 这里的近似值服务缓存读路径（缓存字节是本包自己写出的 uchar 输出）。
  const containerBits = props.depth ?? 8
  const spaceModel = COLOR_MODEL_TO_SPACE_MODEL[props.colorModel ?? 'RGB'] ?? RGB_MODEL
  return {
    format,
    width: props.pixelWidth,
    height: props.pixelHeight,
    orientation: props.orientation,
    pages: source.frameCount,
    // sharp 的存在性字段映射：exif↔{Exif}、iptc↔{IPTC}、tifftagPhotoshop↔{TIFF}、
    // icc/hasProfile↔内嵌 ICC chunk（字节级检查）。xmp/comments 在 ImageIO 属性字典
    // 没有对应键 —— 携带这两种而无其他元数据的图会漏判 carriesMetadata（罕见；记录在案）。
    exif: props.metadataDictionaries.includes('{Exif}') ? {} : undefined,
    iptc: props.metadataDictionaries.includes('{IPTC}') ? {} : undefined,
    tifftagPhotoshop: props.metadataDictionaries.includes('{TIFF}') ? {} : undefined,
    icc: hasProfile ? {} : undefined,
    hasProfile,
    space: spaceOf(spaceModel, containerBits),
    depth: depthOf(containerBits),
    hasAlpha: props.hasAlpha === true,
  }
}


class BunPipeline implements AdapterPipeline {
  constructor(
    private readonly image: unknown,
    private readonly sourceBytes: Uint8Array,
    private readonly options: AdapterOptions,
  ) {}

  /** 仅容器级元数据（不解码像素）—— 缓存读等已验证字节的低成本路径。 */
  probe(): Promise<AdapterMetadata> {
    try {
      const source = imageSourceOf(this.sourceBytes)
      try {
        return Promise.resolve(containerFromSource(source, this.sourceBytes))
      } finally {
        source.release()
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
  }

  /** 容器级元数据 + 像素物化补齐 depth/space 真值（完整性证明在同一遍解码内完成）。hasAlpha 以容器声明为准。 */
  metadata(): Promise<AdapterMetadata> {
    try {
      // ONE open, ONE copy: the same source serves the container facts and the
      // pixel materialization — no second imageSourceOf pass over the bytes.
      const source = imageSourceOf(this.sourceBytes)
      try {
        const container = containerFromSource(source, this.sourceBytes)
        const decoded = decodedFactsOf(source)
        container.depth = depthOf(decoded.bitsPerComponent)
        container.space = spaceOf(decoded.colorSpaceModel, decoded.bitsPerComponent)
        // hasAlpha 保持容器声明（HasAlpha 键）—— 解码表面的 alphaInfo 对无 alpha
        // 的 JPEG 也是 premultiplied，用它会把每个不透明源都误判成带 alpha，
        // 进而让质量阶梯错选 WebP。
        return Promise.resolve(container)
      } finally {
        source.release()
      }
    } catch (error) {
      // 解码失败 = 坏图：与 sharp 的 raw().toBuffer() 行为一致，向上抛。
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
  }

  /** admission 的单次打开路径：容器事实 → limits 先行 → 像素物化（完整性证明 + 真值）。 */
  detect(limits?: AdapterLimits): Promise<AdapterMetadata> {
    try {
      // ONE source open serves everything: header facts for the budget check,
      // then pixel materialization for the integrity proof and true facts.
      const source = imageSourceOf(this.sourceBytes)
      try {
        const container = containerFromSource(source, this.sourceBytes)
        if (limits?.maxPixels !== undefined
          && (container.width ?? 0) * (container.height ?? 0) > limits.maxPixels) {
          throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
        }
        if (limits?.maxDimension !== undefined
          && Math.max(container.width ?? 0, container.height ?? 0) > limits.maxDimension) {
          throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
        }
        const decoded = decodedFactsOf(source)
        container.depth = depthOf(decoded.bitsPerComponent)
        container.space = spaceOf(decoded.colorSpaceModel, decoded.bitsPerComponent)
        // hasAlpha 保持容器声明（HasAlpha 键）—— 解码表面的 alphaInfo 对无 alpha
        // 的 JPEG 也是 premultiplied，用它会把每个不透明源都误判成带 alpha。
        return Promise.resolve(container)
      } finally {
        source.release()
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
  }

  /** 强制完整像素解码：bytes() 是 Bun.Image 的像素出口，截断/损坏输入在此抛错。 */
  raw(): { toBuffer(): Promise<Uint8Array> } {
    return {
      toBuffer: async () => {
        try {
          return await toBytes(await (this.image as { bytes(): unknown }).bytes())
        } catch (error) {
          if (error instanceof AttachmentError) throw error
          throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
        }
      },
    }
  }

  /** Bun 的 autoOrient（默认开启）已在像素操作前应用 EXIF 方向 —— 此处为语义占位。 */
  rotate(): AdapterPipeline {
    return this
  }

  /** Bun 解码时自动转换色彩空间（CMYK→sRGB 实测 ✓）—— 此处为语义占位。 */
  toColourspace(): AdapterPipeline {
    return this
  }

  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: true }): AdapterPipeline {
    const image = this.image as { resize: (width: number, height: number, options: Record<string, unknown>) => unknown }
    return new BunPipeline(image.resize(options.width, options.height, {
      fit: options.fit,
      withoutEnlargement: options.withoutEnlargement,
    }), this.sourceBytes, this.options)
  }

  /** 不可变链式：同一管线的编码互不干扰 —— 即 sharp 的 clone() 语义。 */
  clone(): AdapterPipeline {
    return this
  }

  async webp(options: { quality: number; effort?: number }): Promise<AdapterEncoded> {
    const image = this.image as { webp: (options: { quality: number }) => unknown }
    const data = await toBytes(await image.webp({ quality: options.quality }))
    const facts = detectDimensions(data)
    return { data: stripIccProfile(data, 'webp'), info: { width: facts.width, height: facts.height } }
  }

  async jpeg(options: { quality: number }): Promise<AdapterEncoded> {
    const image = this.image as { jpeg: (options: { quality: number }) => unknown }
    const data = await toBytes(await image.jpeg({ quality: options.quality }))
    const facts = detectDimensions(data)
    return { data: stripIccProfile(data, 'jpeg'), info: { width: facts.width, height: facts.height } }
  }
}

/** 编码输出的尺寸复核（一次容器级读取；同时校验输出确实可解码）。 */
function detectDimensions(data: Uint8Array): { width: number; height: number } {
  const source = imageSourceOf(data)
  try {
    const props = framePropertiesOf(source)
    return { width: props.pixelWidth ?? 0, height: props.pixelHeight ?? 0 }
  } finally {
    source.release()
  }
}

/** sharp 的 `sharp(bytes, {failOn:'error', limitInputPixels:false})` 入口。 */
export function openPipeline(data: Uint8Array, options: AdapterOptions = {}): AdapterPipeline {
  const maxPixels = options.limitInputPixels === false ? Number.MAX_SAFE_INTEGER : options.limitInputPixels ?? 268435456
  const image = new (Bun.Image as unknown as new (input: Uint8Array, options: { maxPixels: number }) => unknown)(
    data, { maxPixels },
  )
  return new BunPipeline(image, data, options)
}
