/**
 * sharp vs ImageIO-adapter 对照审计：
 *   1. 正确性 —— DetectedImage 全字段 diff（各格式 × 特殊场景）
 *   2. 泄漏 —— FFI 循环压力下的 RSS 稳定性
 *   3. 内存 —— 与 sharp 同负载的 RSS 对比
 *   4. 安全 —— 截断 / 伪造头 / 零字节 / 超大像素声明
 */
import sharp from 'sharp'
import { imageSourceOf, framePropertiesOf, mediaTypeOf, decodedFactsOf } from './src/imageio-ffi.ts'

interface Detected {
  mediaType: string
  width: number
  height: number
  animated: boolean
  carriesMetadata: boolean
  depth: string
  space: string
  hasAlpha: boolean
}

const MEDIA: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function rss(): number {
  if (typeof Bun !== 'undefined' && typeof Bun.gc !== 'undefined') Bun.gc(false)
  return process.memoryUsage().rss / 1048576
}

// ---------- adapter 路径（ImageIO FFI，同步） ----------
function adapterDetected(data: Uint8Array): Detected {
  const src = imageSourceOf(data)
  try {
    const props = framePropertiesOf(src)
    const format = mediaTypeOf(src)?.slice('image/'.length)
    if (!format || !MEDIA[format]) throw new Error(`INVALID_IMAGE (${format ?? 'unknown'})`)
    const decoded = decodedFactsOf(src)
    const transposed = (props.orientation ?? 1) >= 5
    const bits = decoded.bitsPerComponent
    const space = decoded.colorSpaceModel === 0 ? (bits === 16 ? 'b-w16' : 'b-w')
      : decoded.colorSpaceModel === 2 ? 'cmyk'
        : bits === 16 ? 'rgb16' : 'srgb'
    return {
      mediaType: MEDIA[format]!,
      width: transposed ? props.pixelHeight! : props.pixelWidth!,
      height: transposed ? props.pixelWidth! : props.pixelHeight!,
      animated: src.frameCount > 1,
      // sharp 的元数据存在性：exif/xmp/iptc/icc/hasProfile/tifftagPhotoshop/comments。
      // ImageIO 对应：{Exif}/{IPTC}/{TIFF} 字典与 orientation；profileName 不算
      // （jpeg 自带的 sRGB 标记在 sharp 里 hasProfile=false）。
      carriesMetadata: props.metadataDictionaries.some(d => ['{Exif}', '{IPTC}', '{TIFF}'].includes(d))
        || (props.orientation ?? 1) !== 1,
      depth: bits === 16 ? 'ushort' : 'uchar',
      space,
      // HasAlpha 属性键：png 4ch/webp/gif 带alpha = true，png 3ch/jpeg = undefined
      // —— 与 sharp 的 hasAlpha 逐格式对齐（解码表面的 alphaInfo 是 premultiplied，不可用）。
      hasAlpha: props.hasAlpha === true,
    }
  } finally {
    src.release()
  }
}

// ---------- sharp 路径（复刻 image.ts 的 probeImage 语义） ----------
async function sharpDetected(data: Uint8Array): Promise<Detected> {
  const image = sharp(data, { failOn: 'error', limitInputPixels: false })
  const metadata = await image.metadata()
  const mediaType = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[metadata.format as string]
  if (mediaType === undefined) throw new Error(`INVALID_IMAGE (${metadata.format})`)
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  const carries = metadata.exif !== undefined || metadata.xmp !== undefined || metadata.iptc !== undefined
    || metadata.icc !== undefined || metadata.hasProfile || metadata.tifftagPhotoshop !== undefined
    || metadata.comments !== undefined || metadata.orientation !== undefined
  return {
    mediaType,
    width: transposed ? metadata.height! : metadata.width!,
    height: transposed ? metadata.width! : metadata.height!,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carries,
    depth: metadata.depth!,
    space: metadata.space!,
    hasAlpha: metadata.hasAlpha!,
  }
}

// ---------- fixtures ----------
async function buildFixtures(): Promise<[string, Uint8Array][]> {
  const base = { width: 64, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } }
  const png = new Uint8Array(await sharp({ create: base }).png().toBuffer())
  const noisePixels = new Uint8Array(256 * 256 * 3).map((_, i) => (i * 37) & 0xff)
  const noisePng = new Uint8Array(await sharp(noisePixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer())
  const list: [string, Uint8Array][] = [
    ['png-不透明', png],
    ['png-带alpha', new Uint8Array(await sharp({ create: { ...base, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer())],
    ['jpeg', new Uint8Array(await sharp(png).jpeg({ quality: 80 }).toBuffer())],
    ['jpeg-EXIF6', new Uint8Array(await sharp(png).withMetadata({ orientation: 6 }).jpeg().toBuffer())],
    ['jpeg-带EXIF payload', new Uint8Array(await sharp(png).withMetadata().jpeg({ quality: 80 }).toBuffer())],
    ['webp', new Uint8Array(await sharp(png).webp().toBuffer())],
    ['gif', new Uint8Array(await sharp(png).gif().toBuffer())],
    ['png-16bit', new Uint8Array(await sharp(new Uint8Array(4 * 4 * 6).map((_, i) => (i % 2 ? 0xff : 0)), { raw: { width: 4, height: 4, channels: 3, depth: 'ushort' } }).png().toBuffer())],
    ['png-噪声256', noisePng],
  ]
  return list
}

// ---------- 1. 正确性 ----------
function diffField(name: string, field: string, a: unknown, b: unknown): boolean {
  if (a !== b) { console.log(`   ❌ ${name}.${field}: sharp=${JSON.stringify(b)} adapter=${JSON.stringify(a)}`); return false }
  return true
}

async function correctness(fixtures: [string, Uint8Array][]): Promise<void> {
  console.log('\n== 1. 正确性（DetectedImage 全字段）==')
  let failures = 0
  for (const [name, bytes] of fixtures) {
    const s = await sharpDetected(bytes)
    const a = adapterDetected(bytes)
    const fields: (keyof Detected)[] = ['mediaType', 'width', 'height', 'animated', 'carriesMetadata', 'depth', 'space', 'hasAlpha']
    const bad = fields.filter(field => !diffField(name, field, a[field], s[field]))
    if (bad.length > 0) failures += 1
    else console.log(`   ✅ ${name}: 全部一致（${s.mediaType} ${s.width}x${s.height} depth=${s.depth} space=${s.space} alpha=${s.hasAlpha} meta=${s.carriesMetadata}）`)
  }
  if (failures > 0) console.log(`   ⚠️ ${failures} 个场景存在差异（见上）`)
}

// ---------- 2. 泄漏（FFI 循环压力） ----------
async function leakLoop(fixtures: [string, Uint8Array][], iterations: number, label: string): Promise<number> {
  Bun.gc(false)
  const start = rss()
  let peak = start
  for (let i = 0; i < iterations; i += 1) {
    for (const [, bytes] of fixtures) {
      adapterDetected(bytes)
      if (i % 5000 === 0) { Bun.gc(false); peak = Math.max(peak, rss()) }
    }
  }
  Bun.gc(false)
  const end = rss()
  console.log(`   ${label}: 起始 ${start.toFixed(1)}MB → 结束 ${end.toFixed(1)}MB（峰值 ${peak.toFixed(1)}MB，增量 ${(end - start).toFixed(1)}MB）`)
  return end - start
}

async function leaks(fixtures: [string, Uint8Array][]): Promise<void> {
  console.log('\n== 2. 泄漏（adapter 循环，连续两轮对比增量是否回落）==')
  await leakLoop(fixtures, 500, '预热（500 轮）')
  const first = await leakLoop(fixtures, 10000, '正式（第一轮 10000 轮 × 9 图）')
  const second = await leakLoop(fixtures, 10000, '正式（第二轮 10000 轮，验证稳定性）')
  console.log(second > 5 ? `   ❌ 第二轮仍增 ${second.toFixed(1)}MB —— 无界泄漏` : `   ✅ 第二轮增量 ${second.toFixed(1)}MB 回落/稳定（首轮 ${first.toFixed(1)}MB 为一次性预热）—— 无泄漏`)
}

// ---------- 3. 内存对比（同负载 sharp vs adapter） ----------
async function memoryCompare(fixtures: [string, Uint8Array][]): Promise<void> {
  console.log('\n== 3. 内存（同 2000 次检测的 RSS 增量）==')
  const round = async (label: string, run: (bytes: Uint8Array) => Promise<unknown>): Promise<number> => {
    Bun.gc(false)
    const start = rss()
    for (let i = 0; i < 2000; i += 1) await run(fixtures[i % fixtures.length]![1])
    Bun.gc(false)
    const delta = rss() - start
    console.log(`   ${label}: +${delta.toFixed(1)}MB`)
    return delta
  }
  await round('sharp 预热', bytes => sharpDetected(bytes))
  const sharpDelta = await round('sharp', bytes => sharpDetected(bytes))
  await round('adapter 预热', bytes => adapterDetected(bytes))
  const adapterDelta = await round('adapter', bytes => Promise.resolve(adapterDetected(bytes)))
  console.log(`   对比: adapter ${adapterDelta.toFixed(1)}MB vs sharp ${sharpDelta.toFixed(1)}MB`)
}

// ---------- 4. 安全 ----------
async function security(fixtures: [string, Uint8Array][]): Promise<void> {
  console.log('\n== 4. 安全（恶意输入必须抛错，不得挂起/崩溃）==')
  const jpeg = fixtures.find(([name]) => name === 'jpeg')![1]
  const cases: [string, Uint8Array][] = [
    ['零字节', new Uint8Array(0)],
    ['伪造 PNG 头 + 垃圾', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Uint8Array(64).fill(0xaa)])],
    ['截断 JPEG', jpeg.slice(0, 200)],
    ['声明超大像素的 PNG 头', new Uint8Array(await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()).map((b, i) => (i >= 16 && i < 24 ? [0x00, 0x00, 0x7f, 0xff, 0x00, 0x00, 0x7f, 0xff][i - 16] : b))],
  ]
  for (const [name, bytes] of cases) {
    const started = Date.now()
    try {
      adapterDetected(bytes)
      console.log(`   ⚠️ ${name}: 未抛错（${Date.now() - started}ms）—— 需确认是否应该拒绝`)
    } catch (error) {
      console.log(`   ✅ ${name}: 抛错 ✓（${Date.now() - started}ms）${String(error).slice(7, 60)}`)
    }
  }
}

// ---------- main ----------
async function main(): Promise<void> {
  const fixtures = await buildFixtures()
  await correctness(fixtures)
  await leaks(fixtures)
  await memoryCompare(fixtures)
  await security(fixtures)
}

void main().catch((error) => { console.error('AUDIT FAILED', error); process.exit(1) })
