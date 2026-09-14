/**
 * Synchronous ImageIO / CoreFoundation / CoreGraphics FFI — the macOS-native
 * metadata plane behind the image adapter.
 *
 * Bun.Image's `metadata()` carries only width/height/format (measured against
 * Bun 1.4.2), while the attachment pipeline needs the fields sharp/libvips used
 * to report: EXIF orientation, GIF frame count, bit depth, colour space, alpha,
 * and per-format metadata presence. ImageIO reads all of those from the
 * container without decoding pixels, synchronously, through the system's own
 * frameworks — no native addon, no network, macOS arm64 only by design.
 *
 * The `bun:ffi` module is typed structurally (the repo's host program carries
 * no Bun type package — same approach as lease.ts) and loaded lazily on first
 * use. Every property key's value type is statically known, so readers are
 * per-type instead of runtime-dispatched.
 *
 * Buffer ownership: `CFDataCreate` copies the input bytes, so the caller's
 * Uint8Array can be reused immediately.
 */

import { dlopen, ptr, type Pointer } from 'bun:ffi'

interface CfSymbols {
  CFDataCreate(allocator: number | null, bytes: number, length: number): number | null
  CFStringCreateWithCString(allocator: number | null, cString: string, encoding: number): number | null
  CFStringGetCString(string: number, buffer: number, size: number, encoding: number): boolean
  CFDictionaryGetValue(dictionary: number, key: number): number | null
  CFNumberGetValue(number: number, type: number, out: number): boolean
  CFBooleanGetValue(boolean: number): boolean
  CFRelease(cf: number): void
}

interface IoSymbols {
  CGImageSourceCreateWithData(data: number, options: number | null): number | null
  CGImageSourceCreateImageAtIndex(source: number, index: number, options: number | null): number | null
  CGImageSourceGetType(source: number): number | null
  CGImageSourceGetCount(source: number): number
  CGImageSourceCopyPropertiesAtIndex(source: number, index: number, options: number | null): number | null
}

interface CgSymbols {
  CGImageGetAlphaInfo(image: number): number
  CGImageGetBitsPerComponent(image: number): number
  CGImageGetColorSpace(image: number): number
  CGColorSpaceGetModel(space: number): number
  CGImageRelease(image: number): void
}

const CF_PATH = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const IMAGE_IO_PATH = '/System/Library/Frameworks/ImageIO.framework/ImageIO'
const CORE_GRAPHICS_PATH = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
const kCFStringEncodingUTF8 = 0x08000100
/** CFNumberGetValue's SInt64 request code. */
const kCFNumberSInt64Type = 4

interface Ffi {
  readonly cf: CfSymbols
  readonly io: IoSymbols
  readonly cg: CgSymbols
  readonly ptr: (value: ArrayBufferView) => Pointer
}

let cachedFfi: Ffi | undefined

function ffi(): Ffi {
  if (cachedFfi !== undefined) return cachedFfi
  const cfLibrary = dlopen(CF_PATH, {
    CFDataCreate: { args: ['ptr', 'ptr', 'i64'], returns: 'ptr' },
    CFStringCreateWithCString: { args: ['ptr', 'cstring', 'u32'], returns: 'ptr' },
    CFStringGetCString: { args: ['ptr', 'ptr', 'i64', 'u32'], returns: 'u8' },
    CFDictionaryGetValue: { args: ['ptr', 'ptr'], returns: 'ptr' },
    CFNumberGetValue: { args: ['ptr', 'i32', 'ptr'], returns: 'u8' },
    CFBooleanGetValue: { args: ['ptr'], returns: 'u8' },
    CFGetTypeID: { args: ['ptr'], returns: 'i64' },
    CFStringGetTypeID: { args: [], returns: 'i64' },
    CFNumberGetTypeID: { args: [], returns: 'i64' },
    CFBooleanGetTypeID: { args: [], returns: 'i64' },
    CFDictionaryGetCount: { args: ['ptr'], returns: 'i64' },
    CFDictionaryGetKeysAndValues: { args: ['ptr', 'ptr', 'ptr'], returns: 'void' },
    CFRelease: { args: ['ptr'], returns: 'void' },
  })
  const ioLibrary = dlopen(IMAGE_IO_PATH, {
    CGImageSourceCreateWithData: { args: ['ptr', 'ptr'], returns: 'ptr' },
    CGImageSourceCreateImageAtIndex: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
    CGImageSourceGetType: { args: ['ptr'], returns: 'ptr' },
    CGImageSourceGetCount: { args: ['ptr'], returns: 'i64' },
    CGImageSourceCopyPropertiesAtIndex: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
  })
  const cgLibrary = dlopen(CORE_GRAPHICS_PATH, {
    CGImageGetAlphaInfo: { args: ['ptr'], returns: 'i32' },
    CGImageGetBitsPerComponent: { args: ['ptr'], returns: 'i64' },
    CGImageGetColorSpace: { args: ['ptr'], returns: 'ptr' },
    CGColorSpaceGetModel: { args: ['ptr'], returns: 'i32' },
    CGImageRelease: { args: ['ptr'], returns: 'void' },
  })
  cachedFfi = {
    cf: cfLibrary.symbols as unknown as CfSymbols,
    io: ioLibrary.symbols as unknown as IoSymbols,
    cg: cgLibrary.symbols as unknown as CgSymbols,
    ptr: (value: ArrayBufferView): Pointer => ptr(value as Uint8Array),
  }
  return cachedFfi
}

const isHandle = (value: unknown): value is number => typeof value === 'number' && value !== 0

/** Interned property-key strings: a bounded set (≈20), retained for the process lifetime by design. */
const keyCache = new Map<string, number>()
function internedKey(cf: CfSymbols, name: string): number {
  const cached = keyCache.get(name)
  if (cached !== undefined) return cached
  const created = cf.CFStringCreateWithCString(null, name, kCFStringEncodingUTF8)
  if (created === null) throw new Error('ImageIO: CFString interning failed')
  keyCache.set(name, created)
  return created
}

const VALUE_BUFFER = new Uint8Array(2048)

function readStringValue(cf: CfSymbols, value: number | null): string | undefined {
  if (!isHandle(value)) return undefined
  if (!cf.CFStringGetCString(value, ffi().ptr(VALUE_BUFFER), VALUE_BUFFER.byteLength, kCFStringEncodingUTF8)) return undefined
  const end = VALUE_BUFFER.indexOf(0)
  return new TextDecoder().decode(VALUE_BUFFER.subarray(0, end === -1 ? VALUE_BUFFER.length : end))
}

function numberValue(cf: CfSymbols, dictionary: number, key: string): number | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  const out = new BigInt64Array(1)
  cf.CFNumberGetValue(value, kCFNumberSInt64Type, ffi().ptr(out))
  return Number(out[0])
}

function booleanValue(cf: CfSymbols, dictionary: number, key: string): boolean | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  return cf.CFBooleanGetValue(value)
}

function stringValue(cf: CfSymbols, dictionary: number, key: string): string | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  return readStringValue(cf, value)
}

function hasKey(cf: CfSymbols, dictionary: number, key: string): boolean {
  return isHandle(cf.CFDictionaryGetValue(dictionary, internedKey(cf, key)))
}

/** One image container opened over copied bytes; release with {@link ImageSource.release}. */
export interface ImageSource {
  readonly handle: number
  /** Uniform type identifier sniffed from the bytes (never the file extension). */
  readonly uti: string | undefined
  /** Frames in the container: >1 means animated (the GIF multi-frame fact). */
  readonly frameCount: number
  release(): void
}

/** Open an image container for metadata reading. Throws on undecodable input. */
export function imageSourceOf(data: Uint8Array): ImageSource {
  const { cf, io, ptr } = ffi()
  const bytes = new Uint8Array(data)
  const cfData = cf.CFDataCreate(null, ptr(bytes), bytes.byteLength)
  if (!isHandle(cfData)) throw new Error('ImageIO: CFData creation failed')
  const sourceValue = io.CGImageSourceCreateWithData(cfData, 0)
  cf.CFRelease(cfData)
  if (!isHandle(sourceValue)) throw new Error('ImageIO: image source creation failed')
  const source = sourceValue
  return {
    handle: source,
    uti: readStringValue(cf, io.CGImageSourceGetType(source)),
    frameCount: io.CGImageSourceGetCount(source),
    release: (): void => { cf.CFRelease(source) },
  }
}

/** The ImageIO property dictionary of frame zero, read eagerly into plain values. */
export interface FrameProperties {
  pixelWidth?: number | undefined
  pixelHeight?: number | undefined
  depth?: number | undefined
  bitsPerComponent?: number | undefined
  orientation?: number | undefined
  hasAlpha?: boolean | undefined
  colorModel?: string | undefined
  profileName?: string | undefined
  /** Presence of the format's metadata dictionary ({Exif}, {TIFF}, {IPTC}, {GIF}, {JFIF}). */
  readonly metadataDictionaries: readonly string[]
}

const NESTED_DICTIONARIES = ['{Exif}', '{TIFF}', '{IPTC}', '{GIF}', '{JFIF}', '{PNG}', '{WebP}'] as const

export function framePropertiesOf(source: ImageSource): FrameProperties {
  const { cf, io } = ffi()
  const properties = io.CGImageSourceCopyPropertiesAtIndex(source.handle, 0, 0)
  if (!isHandle(properties)) return { metadataDictionaries: [] }
  try {
    return {
      pixelWidth: numberValue(cf, properties, 'PixelWidth'),
      pixelHeight: numberValue(cf, properties, 'PixelHeight'),
      depth: numberValue(cf, properties, 'Depth'),
      bitsPerComponent: numberValue(cf, properties, 'BitsPerComponent'),
      orientation: numberValue(cf, properties, 'Orientation'),
      hasAlpha: booleanValue(cf, properties, 'HasAlpha'),
      colorModel: stringValue(cf, properties, 'ColorModel'),
      profileName: stringValue(cf, properties, 'ProfileName'),
      metadataDictionaries: NESTED_DICTIONARIES.filter(name => hasKey(cf, properties, name)),
    }
  } finally {
    cf.CFRelease(properties)
  }
}

/** UTI → media type, for the formats the attachment pipeline admits. */
const UTI_MEDIA_TYPES: Readonly<Record<string, string>> = {
  'public.png': 'image/png',
  'public.jpeg': 'image/jpeg',
  'org.webmproject.webp': 'image/webp',
  'com.compuserve.gif': 'image/gif',
}

export function mediaTypeOf(source: ImageSource): string | undefined {
  return source.uti === undefined ? undefined : UTI_MEDIA_TYPES[source.uti]
}

/** Fully decodes frame zero. Slow path — admission-time integrity proof only. */
export interface DecodedFacts {
  readonly hasAlpha: boolean
  readonly bitsPerComponent: number
  readonly colorSpaceModel: number
}

/** CGColorSpaceModel — the adapter's space mapping consumes these. */
export const GRAY_MODEL = 0
export const RGB_MODEL = 1
export const CMYK_MODEL = 2

export function decodedFactsOf(source: ImageSource): DecodedFacts {
  const { io, cg } = ffi()
  const image = io.CGImageSourceCreateImageAtIndex(source.handle, 0, 0)
  if (!isHandle(image)) throw new Error('ImageIO: frame decode failed (truncated or corrupt input)')
  try {
    return {
      hasAlpha: cg.CGImageGetAlphaInfo(image) !== 0 && cg.CGImageGetAlphaInfo(image) !== 5,
      bitsPerComponent: cg.CGImageGetBitsPerComponent(image),
      colorSpaceModel: cg.CGColorSpaceGetModel(cg.CGImageGetColorSpace(image)),
    }
  } finally {
    cg.CGImageRelease(image)
  }
}
