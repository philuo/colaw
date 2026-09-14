/**
 * Serialize harness messages into OpenAI chat completions. Text-only
 * requests retain string user content; image requests resolve durable
 * attachments into ordered inline base64 data-URL parts (OpenAI's only
 * inline image form — there is no Files API here). Tool-result images
 * follow their string-only tool messages in a separate user message.
 * @module dsh-llm-openai/serialize
 */

import { contentHasImage, LlmError, offloadedImageText, offloadRequestImagesWithPolicy, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type {
  WireImageContentPart,
  WireMessage,
  WireRequest,
  WireTextContentPart,
  WireTool,
  WireUserContentPart,
} from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
  /** Output-cap wire field; `max_completion_tokens` for OpenAI reasoning models, `max_tokens` elsewhere. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | undefined
}

/** Wire-relevant facts of the catalog model this request targets. */
export interface ModelWireFacts {
  /** The model accepts a `reasoning_effort` field (OpenAI reasoning models). */
  reasoning: boolean
}

/** Provider representation for every retained image in one request. */
export interface ImageSerializationOptions {
  /** Request versions prepared for the conservatively retained normalized attachments, keyed by attachment id. */
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

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Validate the adapter-owned effort before resolving its OpenAI wire value. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `OpenAI does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Resolve the wire `reasoning_effort` value. OpenAI's vocabulary has no
 * `off` (the field is omitted — the provider default applies) and no `max`
 * (harness `max` maps to `high`, the strongest OpenAI level). Auxiliary
 * one-shot purposes carry no effort, mirroring the DeepSeek adapter's
 * session-title policy.
 * @returns the wire effort, or `undefined` to omit the field entirely.
 */
function resolveReasoningEffort(
  options: GenerateOptions,
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): 'low' | 'high' | undefined {
  if (model?.reasoning !== true) return undefined
  if (options.purpose === 'session-title') return undefined
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (effort === undefined || effort === 'off') return undefined
  return effort === 'max' ? 'high' : effort
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The OpenAI chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Reject roles whose chat-completions history format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The OpenAI chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Describe the exact request preview and its model-callable coordinate system. */
function imageHandle(
  ref: ImageAttachmentRef,
  version: RequestImageAttachment,
  resolveAccess: ImageAttachmentAccessResolver | undefined,
  precededByContent: boolean,
): WireTextContentPart {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
  }
}

/** Resolve one durable image into its descriptor and inline base64 image part. */
async function imageParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  precededByContent: boolean,
): Promise<[WireTextContentPart, WireImageContentPart]> {
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `OpenAI request image ${block.attachment.attachmentId} was not prepared.`,
      'INVALID_REQUEST',
    )
  }
  const image: WireImageContentPart = {
    type: 'image_url',
    image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
  }
  return [imageHandle(block.attachment, version, images.resolveImageAccess, precededByContent), image]
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  nextImage: { value: number },
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        nextImage.value += 1
        parts.push(...await imageParts(block, images, parts.length > 0))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, images, nextImage))
        break
      default:
        // Other merge-extensible blocks are not chat-completions user-input vocabulary.
        break
    }
  }
  return parts
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/** Serialize one assistant message (text + tool calls; no reasoning passback on the OpenAI wire). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns replay
    // `content: ""` and some gateways reject null outright; the message sits
    // durably in the session log, so a null here would brick every later
    // turn of that session.
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but chat completions want them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Serialize image-capable history after resolving durable attachments into
 * inline base64 parts. Consecutive tool results keep string `tool` messages
 * and share one following user message containing their images.
 * @param messages - transient request history after request-size offloading.
 * @param images - prepared request versions and the request budget.
 * @returns ordered chat-completions wire messages.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    const nextImage = { value: 0 }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const content = userContent(await contentParts(regular, images, nextImage))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({
        role: 'user',
        content,
      })
    }
    for (const result of toolResults) {
      const parts = await contentParts(result.content, images, nextImage)
      const imageParts = parts.filter((part): part is WireImageContentPart => part.type !== 'text')
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || '(no output)',
      })
      pendingToolImages.push(...imageParts)
    }
  }
  flushToolImages()
  return wire
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(
  options: GenerateOptions,
  messages: WireMessage[],
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const effort = resolveReasoningEffort(options, defaults, model)
  const maxTokensField = defaults.maxTokensField ?? 'max_tokens'
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...effort !== undefined ? { reasoning_effort: effort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...(options.maxTokens === undefined ? {} : { [maxTokensField]: options.maxTokens }) as Partial<WireRequest>,
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level defaults; undefined fields put nothing on the wire.
 * @param model - wire-relevant facts of the target catalog model; an
 *   uncatalogued model is treated as non-reasoning.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  model: ModelWireFacts | undefined = undefined,
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  return requestWithMessages(options, messages, defaults, model)
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Oversized oldest images become per-image text after their exact
 * request-version byte lengths are known and before provider serialization.
 * @param options - harness request containing image-capable user content.
 * @param images - prepared request versions, the current access resolver, and request bounds.
 * @param defaults - adapter-level defaults.
 * @param model - wire-relevant facts of the target catalog model.
 * @returns the fully materialized chat-completions request body.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
  model: ModelWireFacts | undefined = undefined,
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  const requestMessages = offloadRequestImagesWithPolicy(options.messages, {
    representation: 'base64',
    byteLength: (ref) => {
      const version = images.requestImages.get(ref.attachmentId)
      if (version === undefined) {
        throw new LlmError(`OpenAI request image ${ref.attachmentId} was not prepared.`, 'INVALID_REQUEST')
      }
      return version.bytes
    },
    maxBytes: images.maxRequestImageBytes,
    ...images.maxImagesPerRequest === undefined ? {} : { maxImages: images.maxImagesPerRequest },
    ...images.byteQuantum === undefined ? {} : { byteQuantum: images.byteQuantum },
    ...images.countQuantum === undefined ? {} : { countQuantum: images.countQuantum },
    placeholder: ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
  })
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessagesWithImages(requestMessages, images))
  return requestWithMessages(options, messages, defaults, model)
}
