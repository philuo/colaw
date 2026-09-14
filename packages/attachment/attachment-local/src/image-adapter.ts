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
  GRAY_MODEL,
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
export interface AdapterPipeline {
  metadata(): Promise<AdapterMetadata>
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

/** 统一编码出口：Bun.Image 的格式方法返回新的 Image 实例，字节经 toBuffer 取出。 */
async function toBytes(value: unknown): Promise<Uint8Array> {
  const image = value as { toBuffer: () => Promise<Buffer> }
  return new Uint8Array(await image.toBuffer())
}

const ICC_MARKER = (() => {
  const bytes = new TextEncoder().encode('ICC_PROFILE\x00')
  return bytes
})()

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

/** 剥除内嵌 ICC（JPEG 的 APP2 ICC_PROFILE 段 / PNG 的 iCCP chunk）—— Bun 编码器会嵌入 ColorSync 默认 sRGB，而 sharp 的输出不带。 */
function stripIccProfile(data: Uint8Array, format: string): Uint8Array {
  if (format === 'jpeg') return stripJpegIcc(data)
  if (format === 'png') return stripPngIcc(data)
  return data
}

/**
 * Whether the container embeds a real ICC profile chunk: JPEG's APP2
 * `ICC_PROFILE` marker or PNG's `iCCP`. ImageIO's `profileName` cannot be used
 * for this — it reports ColorSync's default sRGB even for files with no
 * embedded profile, which misclassifies every clean JPEG as metadata-carrying.
 */
function hasEmbeddedIccProfile(data: Uint8Array): boolean {
  const marker = new TextEncoder().encode('ICC_PROFILE')
  const iccp = new TextEncoder().encode('iCCP')
  return indexOfSubsequence(data, marker) !== -1 || indexOfSubsequence(data, iccp) !== -1
}

/** 容器级元数据（不解码像素）：format/尺寸/orientation/帧数/七项存在性。 */
function containerMetadata(data: Uint8Array): AdapterMetadata {
  const source = imageSourceOf(data)
  try {
    const props = framePropertiesOf(source)
    const mediaType = mediaTypeOf(source)
    const format = mediaType === undefined ? undefined : mediaType.slice('image/'.length)
    if (format === undefined || MEDIA_TYPES[format] === undefined) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    }
    const hasProfile = hasEmbeddedIccProfile(data)
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
      space: undefined, // 由解码后的真实像素色彩空间填充（container 层不可靠）
      depth: undefined, // 同上：ImageIO 的 Depth 键口径与 sharp 不一致
      hasAlpha: props.hasAlpha === true,
    }
  } finally {
    source.release()
  }
}

class BunPipeline implements AdapterPipeline {
  constructor(
    private readonly image: unknown,
    private readonly sourceBytes: Uint8Array,
    private readonly options: AdapterOptions,
  ) {}

  /** 容器级元数据 + 解码补齐 depth/space 的像素级真值。hasAlpha 以容器声明为准。 */
  metadata(): Promise<AdapterMetadata> {
    const container = containerMetadata(this.sourceBytes)
    try {
      const source = imageSourceOf(this.sourceBytes)
      try {
        const decoded = decodedFactsOf(source)
        container.depth = depthOf(decoded.bitsPerComponent)
        container.space = spaceOf(decoded.colorSpaceModel, decoded.bitsPerComponent)
        // hasAlpha 保持容器声明（HasAlpha 键）—— 解码表面的 alphaInfo 对无 alpha
        // 的 JPEG 也是 premultiplied，用它会把每个不透明源都误判成带 alpha，
        // 进而让质量阶梯错选 WebP。
      } finally {
        source.release()
      }
    } catch (error) {
      // 解码失败 = 坏图：与 sharp 的 raw().toBuffer() 行为一致，向上抛。
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
    return Promise.resolve(container)
  }

  /** 强制完整像素解码：编码必经像素缓冲，截断/损坏输入在这里抛错。 */
  raw(): { toBuffer(): Promise<Uint8Array> } {
    return {
      toBuffer: async () => {
        try {
          return await toBytes(await (this.image as { png(): unknown }).png())
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
