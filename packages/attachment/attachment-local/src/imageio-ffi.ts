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
 * FFI handle semantics (measured against Bun 1.4.2): a `'ptr'` return is a
 * `number` when the address fits a safe integer and a `bigint` otherwise, and
 * `'i64'` returns are always BigInt — so every handle flows through the code
 * as `CfHandle = number | bigint`. Handles are opaque; `ptr()` calls take the
 * typed arrays directly. Property keys' value types are statically known, so
 * readers are per-type instead of runtime-dispatched.
 *
 * Buffer ownership: `CFDataCreate` copies the input bytes, so the caller's
 * Uint8Array can be reused immediately.
 */

import { dlopen, ptr } from 'bun:ffi'

/** An opaque CF/CG handle: Bun FFI hands back `number` or `bigint` per call. */
type CfHandle = number | bigint

interface CfSymbols {
  CFDataCreate(allocator: null, bytes: CfHandle, length: number): CfHandle | null
  CFStringCreateWithCString(allocator: null, cString: string, encoding: number): CfHandle | null
  CFStringGetCString(string: CfHandle, buffer: CfHandle, size: number, encoding: number): boolean
  CFDictionaryGetValue(dictionary: CfHandle, key: CfHandle): CfHandle | null
  CFNumberGetValue(number: CfHandle, type: number, out: CfHandle): boolean
  CFBooleanGetValue(boolean: CfHandle): number
  CFRelease(cf: CfHandle): void
}

interface IoSymbols {
  CGImageSourceCreateWithData(data: CfHandle, options: null): CfHandle | null
  CGImageSourceCreateImageAtIndex(source: CfHandle, index: number, options: null): CfHandle | null
  CGImageSourceGetType(source: CfHandle): CfHandle | null
  CGImageSourceGetCount(source: CfHandle): bigint
  CGImageSourceCopyPropertiesAtIndex(source: CfHandle, index: number, options: null): CfHandle | null
}

interface CgSymbols {
  CGImageGetAlphaInfo(image: CfHandle): number
  CGImageGetBitsPerComponent(image: CfHandle): bigint
  CGImageGetColorSpace(image: CfHandle): CfHandle | null
  CGColorSpaceGetModel(space: CfHandle): number
  CGImageRelease(image: CfHandle): void
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
  }
  return cachedFfi
}

/** A live handle: any non-zero number or bigint Bun FFI handed back. */
const isHandle = (value: unknown): value is CfHandle =>
  (typeof value === 'number' || typeof value === 'bigint') && Number(value) !== 0

/** Interned property-key strings: a bounded set (≈20), retained for the process lifetime by design. */
const keyCache = new Map<string, CfHandle>()
function internedKey(cf: CfSymbols, name: string): CfHandle {
  const cached = keyCache.get(name)
  if (cached !== undefined) return cached
  const created = cf.CFStringCreateWithCString(null, name, kCFStringEncodingUTF8)
  if (created === null || !isHandle(created)) throw new Error('ImageIO: CFString interning failed')
  keyCache.set(name, created)
  return created
}

const VALUE_BUFFER = new Uint8Array(2048)
const NUMBER_OUT = new BigInt64Array(1)

function readStringValue(cf: CfSymbols, value: CfHandle | null): string | undefined {
  if (!isHandle(value)) return undefined
  if (!isHandle(value) || !cf.CFStringGetCString(value, ptr(VALUE_BUFFER), VALUE_BUFFER.byteLength, kCFStringEncodingUTF8)) return undefined
  const end = VALUE_BUFFER.indexOf(0)
  return new TextDecoder().decode(VALUE_BUFFER.subarray(0, end === -1 ? VALUE_BUFFER.length : end))
}

function numberValue(cf: CfSymbols, dictionary: CfHandle, key: string): number | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  cf.CFNumberGetValue(value, kCFNumberSInt64Type, ptr(NUMBER_OUT))
  return Number(NUMBER_OUT[0])
}

function booleanValue(cf: CfSymbols, dictionary: CfHandle, key: string): boolean | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  // CFBooleanGetValue's 'u8' return arrives as a number (1/0), not a boolean.
  return cf.CFBooleanGetValue(value) === 1
}

function stringValue(cf: CfSymbols, dictionary: CfHandle, key: string): string | undefined {
  const value = cf.CFDictionaryGetValue(dictionary, internedKey(cf, key))
  if (!isHandle(value)) return undefined
  return readStringValue(cf, value)
}

function hasKey(cf: CfSymbols, dictionary: CfHandle, key: string): boolean {
  return isHandle(cf.CFDictionaryGetValue(dictionary, internedKey(cf, key)))
}

/** One image container opened over copied bytes; release with {@link ImageSource.release}. */
export interface ImageSource {
  readonly handle: CfHandle
  /** Uniform type identifier sniffed from the bytes (never the file extension). */
  readonly uti: string | undefined
  /** Frames in the container: >1 means animated (the GIF multi-frame fact). */
  readonly frameCount: number
  release(): void
}

/** Open an image container for metadata reading. Throws on undecodable input. */
export function imageSourceOf(data: Uint8Array): ImageSource {
  const { cf, io } = ffi()
  const bytes = new Uint8Array(data)
  const cfData = cf.CFDataCreate(null, ptr(bytes), bytes.byteLength)
  if (!isHandle(cfData)) throw new Error('ImageIO: CFData creation failed')
  const source = io.CGImageSourceCreateWithData(cfData, null)
  cf.CFRelease(cfData)
  if (!isHandle(source)) throw new Error('ImageIO: image source creation failed')
  return {
    handle: source,
    uti: readStringValue(cf, io.CGImageSourceGetType(source)),
    frameCount: Number(io.CGImageSourceGetCount(source)),
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
  const properties = io.CGImageSourceCopyPropertiesAtIndex(source.handle, 0, null)
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

/** The alpha-info values whose surfaces carry no alpha plane at all. */
const ALPHA_INFO_OPAQUE = new Set([0, 5]) // kCGImageAlphaNone, kCGImageAlphaNoneSkipLast

export function decodedFactsOf(source: ImageSource): DecodedFacts {
  const { io, cg } = ffi()
  const image = io.CGImageSourceCreateImageAtIndex(source.handle, 0, null)
  if (!isHandle(image)) throw new Error('ImageIO: frame decode failed (truncated or corrupt input)')
  try {
    const colorSpace = cg.CGImageGetColorSpace(image)
    return {
      hasAlpha: !ALPHA_INFO_OPAQUE.has(cg.CGImageGetAlphaInfo(image)),
      bitsPerComponent: Number(cg.CGImageGetBitsPerComponent(image)),
      colorSpaceModel: isHandle(colorSpace) ? cg.CGColorSpaceGetModel(colorSpace) : -1,
    }
  } finally {
    cg.CGImageRelease(image)
  }
}
