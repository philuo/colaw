/**
 * Serialize harness messages into DeepSeek Responses input items.
 *
 * Contract: `https://api-docs.deepseek.com/zh-cn/guides/responses_api`. The
 * rules this module exists to keep, all of them documented and all of them the
 * kind an endpoint enforces by silently ignoring rather than failing:
 *
 * - The system prompt travels as `instructions`, which the endpoint inserts as
 *   the leading system message. It is never a `developer` item: DeepSeek
 *   documents `developer` as equivalent to **user**, so that spelling would
 *   deliver instructions as user speech.
 * - Images may appear in `user`/`developer` messages and in a
 *   `function_call_output`'s parts; an image on a `system` or `assistant`
 *   message is a 400, so the roles are asserted before serializing.
 * - An `input_image` part carries **exactly one** of `image_url` or `file_id`:
 *   neither is a 400 and both is a 400.
 * - Tool results are `function_call_output` items keyed by `call_id`; replayed
 *   calls are `function_call` items. Tool-result images ride that item's own
 *   `output` parts instead of a separate user message, which this wire allows.
 * - Reasoning is not replayed. DeepSeek folds plain-text reasoning into the
 *   adjacent assistant message and supports neither `summary` nor
 *   `encrypted_content`, so a replayed reasoning item adds tokens and no
 *   information the assistant message does not already carry.
 *
 * @module dsh-llm-deepseek/openai-responses-serialize
 */

import { contentHasImage, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RequestDefaults } from '../../common/types.ts'
import type { ImageWireLocation } from '../../common/request-files.ts'
import type {
  WireFunctionCallItem,
  WireInputTextPart,
  WireFunctionCallOutputItem,
  WireInputImagePart,
  WireInputItem,
  WireInputMessage,
  WireMessagePart,
  WireRequest,
  WireTool,
} from './types.ts'

/**
 * Where an image occurrence sits in the conversation: the message index and its
 * ordinal among the request's images. The Files API upload index is keyed by
 * this pair, so it has to count across messages rather than restart per message.
 */
interface ImagePosition {
  message: number
  nextImage: number
}

/** Provider representation for every retained image in one request. */
export type ImageRequestRepresentation =
  | {
    kind: 'file'
    /** Resolve a retained request version to a reusable DeepSeek file id. */
    resolveFileId: (
      version: RequestImageAttachment,
      block: Extract<ContentBlock, { type: 'image' }>,
      location: ImageWireLocation,
    ) => Promise<string>
  }
  | { kind: 'base64' }

/** Dependencies required only when the request contains image input. */
export interface ImageSerializationOptions {
  /** One representation used for every retained image in this request. */
  representation: ImageRequestRepresentation
  /** Request versions prepared for the retained attachments, keyed by attachment id. */
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  /** Resolve current tool access independently from deterministic request-image versions. */
  resolveImageAccess?: ImageAttachmentAccessResolver
  /** Positive bound on accumulated represented image bytes. */
  maxRequestImageBytes: number
  /** Maximum represented images in one request. */
  maxImagesPerRequest?: number
  /** Represented-byte removal step applied after the request exceeds its byte bound. */
  byteQuantum?: number
  /** Image-count removal step applied after the request exceeds its count bound. */
  countQuantum?: number
}

/** Data URL for one prepared image version. */
function dataUrl(version: RequestImageAttachment): string {
  return `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
}

/** Join the text blocks of one content list. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Reject an image on a role this endpoint refuses.
 * @param messages - transient request history.
 */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role === 'user') continue
    if (!contentHasImage(message.content)) continue
    throw new LlmError(
      'DeepSeek Responses accepts image input only on user messages and tool results; '
      + `an image on a ${message.role} message is rejected`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** One image as an `input_image` part, using exactly one of the two accepted fields. */
async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  location: ImageWireLocation,
): Promise<WireInputImagePart> {
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError('A retained image has no prepared request version.', 'UNSUPPORTED_CONTENT')
  }
  if (images.representation.kind === 'file') {
    return { type: 'input_image', file_id: await images.representation.resolveFileId(version, block, location) }
  }
  // `image_url` accepts an http(s) URL or a base64 data URL, so an inline image
  // needs no upload.
  return { type: 'input_image', image_url: dataUrl(version) }
}

/**
 * Convert one content list into ordered message parts.
 * @param blocks - content of a user message or a tool result.
 * @param images - prepared request versions and the representation to use.
 * @param location - which of the two allowed placements this content is in.
 * @param representImages - false for the text-only path, where a retained image
 *   is described by its handle instead of being sent.
 * @returns the ordered parts.
 */
async function messageParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions | undefined,
  position: ImagePosition,
  representImages: boolean,
): Promise<WireMessagePart[]> {
  const parts: WireMessagePart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
        break
      case 'image': {
        if (images === undefined) {
          throw new LlmError(
            'This request carries an image but no image serialization was prepared for the route.',
            'UNSUPPORTED_CONTENT',
          )
        }
        if (!representImages) {
          const version = images.requestImages.get(block.attachment.attachmentId)
          if (version === undefined) {
            throw new LlmError('A retained image has no prepared request version.', 'UNSUPPORTED_CONTENT')
          }
          parts.push({ type: 'input_text', text: requestImageHandleText(block.attachment, version, images.resolveImageAccess?.(block.attachment)) })
          break
        }
        parts.push(await imagePart(block, images, { message: position.message, image: position.nextImage++ }))
        break
      }
      case 'file':
        // This endpoint has no file input at all. The harness projects file
        // attachments to handle text before serialization, so a `file` block
        // arriving here means that projection did not run — failing is the only
        // honest answer, because emitting empty text would look like success
        // while the attachment silently vanished.
        throw new LlmError(
          'DeepSeek Responses has no file input; a file attachment has to reach the model as handle text.',
          'UNSUPPORTED_CONTENT',
        )
      case 'tool-result':
        // Nested results are flattened by their own item type; a result inside a
        // result is not a shape this wire has.
        break
      default:
        break
    }
  }
  return parts
}

/** One message as an input item, keeping string form when it is text-only. */
function textMessage(message: Message): WireInputMessage {
  const parts: WireMessagePart[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
  }
  const only = parts.length === 1 ? parts[0] : undefined
  return only !== undefined && only.type === 'input_text'
    ? { role: message.role, content: only.text }
    : { role: message.role, content: parts }
}

/** Replayed tool calls of one assistant turn, as their own items. */
function functionCalls(message: Message): WireFunctionCallItem[] {
  const items: WireFunctionCallItem[] = []
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    items.push({
      type: 'function_call',
      call_id: block.id,
      name: block.name,
      // Already the raw JSON string the provider issued.
      arguments: block.arguments,
    })
  }
  return items
}

/** Text-only serialization of history, without preparing any image. */
function textInput(messages: readonly Message[]): WireInputItem[] {
  const input: WireInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      input.push(textMessage(message))
      input.push(...functionCalls(message))
      continue
    }
    // Tool results arrive as user-role messages carrying `tool-result` blocks,
    // so this has to be decided before the plain-user case — otherwise a result
    // is sent as an empty user message and its call_id has no answer.
    const results = message.content.filter(block => block.type === 'tool-result')
    if (results.length > 0) {
      for (const block of results) {
        input.push({ type: 'function_call_output', call_id: block.toolCallId, output: flattenText(block.content) || '(no output)' })
      }
      continue
    }
    if (message.role === 'user') input.push(textMessage(message))
  }
  return input
}

/** The tool array of one request; `parameters` is already JSON Schema. */
function wireTools(options: GenerateOptions): WireTool[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined
  return options.tools.map(tool => ({
    type: 'function',
    name: tool.name,
    ...tool.description === undefined ? {} : { description: tool.description },
    parameters: tool.parameters as unknown as Record<string, unknown>,
  }))
}

/**
 * Resolve the reasoning effort this request asks for.
 *
 * DeepSeek documents `reasoning` as partially supported: `effort` works and
 * `summary` is accepted but generates nothing, so only `effort` is ever sent.
 * There is no documented value that turns thinking off on this wire, so `off`
 * omits the field and the endpoint's own default stands — the one place this
 * wire is weaker than the other two, and it is called out rather than faked
 * with an invented `'none'`.
 * @param options - the harness request.
 * @param defaults - adapter-level defaults.
 * @returns the effort to send, or `undefined` to send no `reasoning` field.
 */
function resolveEffort(
  options: GenerateOptions,
  defaults: RequestDefaults,
): 'low' | 'high' | 'max' | undefined {
  if (options.purpose === 'session-title') return undefined
  if (defaults.thinking === 'disabled') return undefined
  // The two sources are typed differently — the request carries a branded id,
  // the adapter default a plain union — so the value is narrowed once, here,
  // rather than through a helper that would have to accept both.
  const requested: string | undefined = options.reasoningEffort ?? defaults.reasoningEffort
  if (requested === undefined) return undefined
  if (requested !== 'off' && requested !== 'low' && requested !== 'high' && requested !== 'max') {
    throw new LlmError(
      `DeepSeek does not support reasoning effort "${requested}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return requested === 'off' ? undefined : requested
}

/** Assemble the request from its already-built input items. */
function requestWithInput(
  options: GenerateOptions,
  input: WireInputItem[],
  defaults: RequestDefaults,
): WireRequest {
  const tools = wireTools(options)
  const effort = resolveEffort(options, defaults)
  const maxTokens = options.maxTokens
  return {
    model: options.model,
    input,
    ...options.system === undefined || options.system.length === 0 ? {} : { instructions: options.system },
    stream: true,
    ...maxTokens === undefined ? {} : { max_output_tokens: maxTokens },
    // Supported, and documented as having no effect while thinking is on — so
    // it is sent whenever the caller set one rather than dropped by a rule the
    // endpoint does not actually have.
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...effort === undefined ? {} : { reasoning: { effort } },
    ...tools === undefined ? {} : { tools },
    // A stop sequence has no field on this wire, so `options.stop` is not sent.
  }
}

/**
 * Build the text-only wire request.
 *
 * Used for requests that carry no image at all — the harness routes images
 * through {@link serializeRequestWithImages} — and for the paths that
 * deliberately describe an image by its handle instead of sending it.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level defaults; undefined fields put nothing on the wire.
 * @returns the Responses request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  return requestWithInput(options, textInput(options.messages), defaults)
}

/**
 * Build the wire request for a history that carries images.
 *
 * Images on roles this endpoint refuses are rejected before anything is
 * serialized, and any image the request budget could not retain is replaced by
 * its handle text, exactly so the model still learns the image existed.
 * @param options - the harness request.
 * @param images - prepared request versions, the representation, and its budget.
 * @param defaults - adapter-level defaults.
 * @returns the Responses request body.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  const projected = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)))
  const input: WireInputItem[] = []
  const position: ImagePosition = { message: 0, nextImage: 0 }
  for (const [index, message] of projected.entries()) {
    position.message = index
    if (message.role === 'assistant') {
      const parts = await messageParts(message.content, images, position, true)
      input.push(parts.length > 0 && parts.every(part => part.type === 'input_text')
        ? { role: 'assistant', content: parts.map(part => (part as { text: string }).text).join('') }
        : { role: 'assistant', content: parts })
      input.push(...functionCalls(message))
      continue
    }
    const results = message.content.filter(block => block.type === 'tool-result')
    if (results.length > 0) {
      for (const block of results) {
        const parts = await messageParts(block.content, images, position, true)
        const onlyOutput = parts.length === 1 ? parts[0] : undefined
        const output: WireFunctionCallOutputItem['output'] = onlyOutput !== undefined && onlyOutput.type === 'input_text'
          ? onlyOutput.text
          : parts.filter((part): part is WireInputTextPart | WireInputImagePart =>
            part.type === 'input_text' || part.type === 'input_image')
        input.push({ type: 'function_call_output', call_id: block.toolCallId, output })
      }
      continue
    }
    if (message.role === 'user') {
      const parts = await messageParts(message.content, images, position, true)
      const carried = message.content.some(block => block.type === 'image' && images.requestImages.has(block.attachment.attachmentId))
      const only = parts.length === 1 ? parts[0] : undefined
      input.push(!carried && only !== undefined && only.type === 'input_text'
        ? { role: 'user', content: only.text }
        : { role: 'user', content: parts })
      continue
    }
  }
  return requestWithInput(options, input, defaults)
}
