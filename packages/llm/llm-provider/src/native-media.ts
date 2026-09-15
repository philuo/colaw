/**
 * Native media parts: moving pictures and documents that a provider wire
 * carries as content parts instead of the harness's handle-text projection.
 *
 * Shapes follow each vendor's own documentation, quoted where they are built:
 *
 * - Motion pictures ride `video_url`. GLM (Z.AI, `glm-5.3-flash`):
 *   `{"type":"video_url","video_url":{"url":"…"}}`; DashScope/Qwen's
 *   OpenAI-compatible mode is the same part, optionally with a sibling
 *   `fps` (0.1–10, default 2.0). Both accept a URL; DashScope documents base64
 *   as a `data:<mime>;base64,…` Data URL, which is the only form a local
 *   attachment can take.
 * - Documents ride `file` (GLM's unified part: `file_id`, `file_url`, or
 *   inline `file_data` + `filename`), `document` (Anthropic Messages:
 *   `source: {type: 'base64', media_type, data}`), or `input_file` (OpenAI
 *   Responses: `file_data` + `filename`).
 *
 * Bytes come from the durable verbatim store. A durable file reference carries
 * its exact byte length, so the route bound is enforced before any read, and
 * the read itself refuses when the backend is not host-file-backed (a remote
 * store has no inline path yet; uploading APIs are the next slice).
 *
 * @module dsh-llm-provider/native-media
 */

import { readFile } from 'node:fs/promises'
import {
  attachmentFamily, inferAttachmentMediaType, LlmError,
} from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { NativeAttachmentFamily } from '@deepseek-ai/dsh-llm'

/** Default inline bound per file or video part; a route may lower it. */
export const DEFAULT_MAX_REQUEST_FILE_BYTES = 20 * 1024 * 1024

/** How one route serializes native media, resolved from its profile. */
export interface NativeAttachmentOptions {
  /** Durable store the parts' bytes are read from. */
  attachments: AttachmentStore
  /** Families this wire serializes (the adapter's `nativeAttachments`). */
  families: readonly NativeAttachmentFamily[]
  /** Inline byte bound per part. */
  maxBytes: number
}

/** One attachment resolved to the facts a wire part needs. */
export interface NativeAttachmentBytes {
  /** Media family the filename implies. */
  family: NativeAttachmentFamily
  /** Media type inferred from the filename. */
  mediaType: string
  /** Verbatim bytes. */
  bytes: Uint8Array
}

/**
 * Whether this request's options serialize the given reference natively.
 * @param native - the route's native-media options, when it has any.
 * @param ref - durable verbatim file reference from the history.
 * @returns whether the wire carries this occurrence as a part.
 */
export function ridesNatively(
  native: { families: readonly NativeAttachmentFamily[] } | undefined,
  ref: FileAttachmentRef,
): boolean {
  if (native === undefined) return false
  const family = attachmentFamily(ref)
  return family !== undefined && native.families.includes(family)
}

/**
 * Read one attachment's bytes for a native part, enforcing the route bound
 * before touching the filesystem.
 * @param native - the route's native-media options.
 * @param ref - durable verbatim file reference.
 * @param label - route label used in diagnostics.
 * @returns the family, inferred media type, and verbatim bytes.
 * @throws LlmError when the reference exceeds the bound, the filename implies
 *   no supported media type, or the backend has no host-file path.
 */
export async function readNativeAttachment(
  native: NativeAttachmentOptions,
  ref: FileAttachmentRef,
  label: string,
): Promise<NativeAttachmentBytes> {
  const family = attachmentFamily(ref)
  const mediaType = inferAttachmentMediaType(ref.name)
  if (family === undefined || mediaType === undefined) {
    throw new LlmError(
      `${label} cannot send "${ref.name}": its file type has no native media part on this route`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (ref.bytes > native.maxBytes) {
    throw new LlmError(
      `${label} cannot inline "${ref.name}" (${String(ref.bytes)} bytes): the route's maxRequestFileBytes is`
      + ` ${String(native.maxBytes)}; raise it or send the file through a tool the model can read`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const hostPath = native.attachments.fileHostPath(ref)
  if (hostPath === undefined) {
    throw new LlmError(
      `${label} cannot read "${ref.name}": this deployment's attachment store has no host file path`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return { family, mediaType, bytes: new Uint8Array(await readFile(hostPath)) }
}

/**
 * The inline base64 Data URL every one of these wires accepts for a
 * locally-held attachment.
 * @param mediaType - media type inferred from the filename.
 * @param bytes - verbatim bytes.
 * @returns `data:<mediaType>;base64,<payload>`.
 */
export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}
