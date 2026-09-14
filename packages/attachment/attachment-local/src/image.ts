/** Raster inspection: full decode at admission, header-only probe on verified reads. */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { openPipeline, type AdapterMetadata, type AdapterPipeline } from './image-adapter.ts'

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  /** Intrinsic width with EXIF orientation applied — the width a viewer perceives. */
  width: number
  /** Intrinsic height with EXIF orientation applied — the height a viewer perceives. */
  height: number
  /** Whether the container carries more than one frame. */
  animated: boolean
  /** Whether the bytes carry descriptive metadata, a color profile, or orientation. */
  carriesMetadata: boolean
  /** Sample depth reported for the decoded channels. */
  depth: string
  /** Colour space reported for the decoded pixels. */
  space: string
  /** Whether decoded pixels carry an alpha channel. */
  hasAlpha: boolean
}

/**
 * Check alpha metadata for bytes produced by this package's encoders.
 * Encoders may omit an all-opaque alpha plane from WebP output; every
 * other addition or removal indicates that the encoded result is incompatible
 * with its source facts.
 * @param sourceHasAlpha - whether the source bytes declare an alpha plane, or undefined when the source frame is unspecified.
 * @param output - decoded media type and alpha metadata from the encoded result.
 * @returns whether the output alpha metadata is compatible with the source.
 */
export function encodedAlphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DetectedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return sourceHasAlpha === undefined
    || output.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Project the adapter's metadata onto the pipeline's DetectedImage facts. */
function toDetected(metadata: AdapterMetadata): DetectedImage {
  const mediaType = MEDIA_TYPES[metadata.format ?? '']
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  // EXIF orientations 5-8 transpose the stored raster; report the perceived
  // axes so limits, source facts, and coordinate advice all share them.
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  const storedWidth = metadata.width ?? 0
  const storedHeight = metadata.height ?? 0
  return {
    mediaType,
    width: transposed ? storedHeight : storedWidth,
    height: transposed ? storedWidth : storedHeight,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: metadata.exif !== undefined
      || metadata.xmp !== undefined
      || metadata.iptc !== undefined
      || metadata.icc !== undefined
      || metadata.hasProfile
      || metadata.tifftagPhotoshop !== undefined
      || metadata.comments !== undefined
      || metadata.orientation !== undefined,
    depth: metadata.depth ?? 'uchar',
    space: metadata.space ?? 'srgb',
    hasAlpha: metadata.hasAlpha ?? false,
  }
}

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  try {
    return toDetected(await openPipeline(data, { failOn: 'error', limitInputPixels: false }).probe())
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/** Admission limits applied to a decoded raster's intrinsic dimensions. */
export interface DecodedImageLimits {
  /** Decoded-pixel (width times height) admission limit. */
  maxPixels?: number
  /** Per-side admission limit applied to width and height independently. */
  maxDimension?: number
}

/**
 * Fully decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  try {
    const pipeline = openPipeline(data, { failOn: 'error', limitInputPixels: false })
    // Header facts first: the pixel budget is enforced from the declared
    // dimensions BEFORE any pixel materialization, so a decompression bomb
    // (crafted header, truncated body) is rejected without ever decoding.
    const header = toDetected(await pipeline.probe())
    if (limits?.maxPixels !== undefined && header.width * header.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(header.width, header.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    // Materialize once: the integrity proof (corrupt trailing data fails here)
    // and the pixel-true depth/space arrive together in this single decode.
    const detected = toDetected(await pipeline.metadata())
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/** The prepared (oriented, sRGB, resized) pixel pipeline behind the quality ladder. */
export type PreparedPipeline = AdapterPipeline
