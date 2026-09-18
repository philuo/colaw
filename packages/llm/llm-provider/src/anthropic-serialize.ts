/**
 * Serialize harness messages into Anthropic Messages requests. Tool results
 * become `tool_result` blocks inside user messages (consecutive results share
 * one message, mirroring pi-ai); unsigned harness reasoning folds into plain
 * assistant text (pi-ai's default for missing thinking signatures). Images
 * ride inline base64 sources; there is no Files API on this route.
 * @module dsh-llm-provider/anthropic-serialize
 */

import { contentHasFile, contentHasImage, LlmError, offloadedImageText, offloadRequestImagesWithPolicy, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { isTextMediaType, readNativeAttachment, ridesNatively } from './native-media.ts'
import type { NativeAttachmentOptions } from './native-media.ts'
import type {
  WireAssistantMessage,
  WireDocumentBlock,
  WireImageBlock,
  WireToolUseBlock,
  WireMessage,
  WireRequest,
  WireTextBlock,
  WireTool,
  WireToolResultBlock,
  WireUserContentBlock,
} from './anthropic-types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
  /**
   * Extended-thinking budget when a reasoning model is requested with an
   * effort. `budget_tokens` must be ≥1024 and below `max_tokens`.
   */
  thinkingBudgetTokens?: number | undefined
  /**
   * Vendor deviations this route needs honored, from the route's own profile.
   *
   * `'deepseek'` implements this wire but not all of it: reasoning depth comes
   * from `output_config.effort` (`thinking.budget_tokens` is documented as
   * ignored), `document` blocks are unsupported, and `temperature` stays
   * accepted while thinking is on. Without the flag the standard behaviour —
   * what Anthropic's own API requires — is what goes on the wire.
   */
  compat?: 'deepseek' | undefined
}

/** Whether this route needs DeepSeek's documented Messages deviations. */
function isDeepSeek(defaults: RequestDefaults): boolean {
  return defaults.compat === 'deepseek'
}

/** Wire-relevant facts of the catalog model this request targets. */
export interface ModelWireFacts {
  /** The model accepts extended thinking (`thinking` on the wire). */
  reasoning: boolean
  /** The model's own output cap, used when the request declares none. */
  maxTokens?: number | undefined
}

/** Provider representation for every retained image in one request. */
export interface ImageSerializationOptions {
  /** Request versions prepared for the retained normalized attachments, keyed by attachment id. */
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

/**
 * The request-preview policy applied to every image on this route
 * (aspect-preserving projection to the pixel budget, then the encoded-byte
 * quality ladder).
 */
export function resolveRequestImagePolicy(): { maxPixels: number; maxBytes: number } {
  return { maxPixels: 640_000, maxBytes: 1024 * 1024 }
}

/**
 * Resolve the fixed-route request target for one attachment: the
 * aspect-preserving projection of the source onto this route's pixel budget,
 * carrying its encoded-byte budget. The attachment seam takes resolved target
 * dimensions, so the budget is applied here rather than inside the encoder.
 * @param ref - provider-independent attachment reference carrying the source size.
 * @returns the seam's target dimensions and byte budget.
 */
export function resolveRequestImageTarget(
  ref: Pick<ImageAttachmentRef, 'width' | 'height'>,
): ImageRequestTarget {
  const policy = resolveRequestImagePolicy()
  return {
    ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
    maxBytes: policy.maxBytes,
  }
}

/** Validate the adapter-owned effort before resolving its wire budget. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `Anthropic does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * What the request says about extended thinking.
 *
 * `omit` and `disabled` are deliberately different: omitting the field leaves
 * the vendor's own default in force, which for a reasoning model is usually
 * "thinking on". A user who turned thinking off asked for it to be off, so the
 * request says `{type: 'disabled'}` — the spelling both Anthropic and DeepSeek
 * document for that instruction — instead of hoping the absence is read that
 * way. The budget ladder is adapter policy over the wire fact
 * `{type: 'enabled', budget_tokens}`.
 */
type ThinkingSetting =
  | { readonly kind: 'omit' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'enabled'; readonly budget: number; readonly effort: 'low' | 'high' | 'max' }

/**
 * Resolve the extended-thinking instruction for one request.
 * @returns `omit` for a model that cannot reason or a request that names no
 *   policy, `disabled` for an explicit `off`, otherwise the wire budget.
 */
function resolveThinking(
  options: GenerateOptions,
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): ThinkingSetting {
  // A non-reasoning model: putting the field on the wire at all is not
  // meaningful, and Anthropic rejects the request for models without it.
  if (model?.reasoning !== true) return { kind: 'omit' }
  // Auxiliary one-shot purposes never pay for thinking.
  if (options.purpose === 'session-title') return { kind: 'disabled' }
  const requested = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (requested === undefined) return { kind: 'omit' }
  if (requested === 'off') return { kind: 'disabled' }
  const budget = defaults.thinkingBudgetTokens ?? 16_384
  if (requested === 'low') return { kind: 'enabled', budget: Math.max(1024, Math.floor(budget / 4)), effort: 'low' }
  return { kind: 'enabled', budget, effort: requested }
}

/** Join the text blocks of a message. */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The Anthropic messages adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
  // A file reaching the text-only path means request assembly kept it without
  // this route claiming its family; dropping it silently would lose content.
  if (contentHasFile(blocks)) {
    throw new LlmError(
      'The Anthropic messages adapter received an unserialized file attachment;'
      + " declare the model's file input on the route first",
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Reject roles whose history format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The Anthropic messages adapter cannot represent image content in a ${message.role} message.`,
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
): WireTextBlock {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
  }
}

/** Resolve one durable image into its descriptor and inline base64 image block. */
function imageBlocks(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
): [WireTextBlock, WireImageBlock] {
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `Anthropic request image ${block.attachment.attachmentId} was not prepared.`,
      'INVALID_REQUEST',
    )
  }
  const image: WireImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
    },
  }
  return [imageHandle(block.attachment, version, images.resolveImageAccess, false), image]
}

/** Convert user or nested tool-result blocks into ordered wire blocks. */
async function contentBlocks(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  native: NativeAttachmentOptions | undefined,
  deepseek: boolean,
): Promise<WireUserContentBlock[]> {
  const parts: WireUserContentBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'file': {
        if (!ridesNatively(native, block.attachment)) break
        const attachment = await readNativeAttachment(
          native as NativeAttachmentOptions, block.attachment, 'The Anthropic messages adapter')
        if (attachment.family === 'video') {
          throw new LlmError(
            'The Anthropic messages protocol has no video input; send the video through an OpenAI-compatible route',
            'UNSUPPORTED_CONTENT',
          )
        }
        if (isTextMediaType(attachment.mediaType)) {
          parts.push({ type: 'text', text: Buffer.from(attachment.bytes).toString('utf8') })
          break
        }
        if (deepseek) {
          // DeepSeek's Messages wire documents `document` as unsupported, so
          // sending the block would either be rejected or silently dropped —
          // and a dropped attachment is worse than a refusal. Text-extractable
          // files already took the text branch above; anything left here is
          // binary and has to travel a wire that carries it.
          throw new LlmError(
            'This Messages route declares DeepSeek compatibility, which has no document input; '
            + 'send the file through an OpenAI-compatible route or as text',
            'UNSUPPORTED_CONTENT',
          )
        }
        parts.push({
          type: 'document',
          source: { type: 'base64', media_type: attachment.mediaType, data: Buffer.from(attachment.bytes).toString('base64') },
        } satisfies WireDocumentBlock)
        break
      }
      case 'image':
        parts.push(...imageBlocks(block, images))
        break
      case 'tool-result':
        parts.push(...await contentBlocks(block.content, images, native, deepseek))
        break
      default:
        break
    }
  }
  return parts
}

/**
 * Serialize one assistant message, preserving the harness content order:
 * unsigned reasoning replays as plain text in place (pi-ai's default when a
 * thinking signature is missing — an aborted stream is the common case),
 * tool calls replay as `tool_use` with parsed JSON inputs.
 */
function serializeAssistant(message: Message): WireAssistantMessage | undefined {
  const blocks: (WireTextBlock | WireToolUseBlock)[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        // Unsigned reasoning folds into plain text; empty text is skipped by
        // the same trim rule pi-ai applies to text blocks.
        if (block.text.trim().length > 0) blocks.push({ type: 'text', text: block.text })
        break
      case 'tool-call':
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parseToolArguments(block.arguments),
        })
        break
      default:
        break
    }
  }
  if (blocks.length === 0) return undefined
  return { role: 'assistant', content: blocks }
}

/** Parse a tool-call arguments JSON string; the wire carries a JSON object. */
function parseToolArguments(argumentsText: string): Record<string, unknown> {
  if (argumentsText.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch (error) {
    throw new LlmError(
      `Anthropic history replay hit a tool-call with malformed arguments: ${(error as Error).message}`,
      'MALFORMED_RESPONSE',
      { cause: error },
    )
  }
}

/**
 * Serialize the conversation. Tool results become `tool_result` blocks
 * inside user messages; consecutive tool results share one user message
 * (evidence: pi-ai's convertMessages). System-role messages in history are
 * folded into the leading wire system prompt — the Messages API has no
 * system role below the top level.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages.
 */
export function serializeMessages(messages: Message[]): { systemParts: string[]; messages: WireMessage[] } {
  const systemParts: string[] = []
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      systemParts.push(flattenText(message.content))
      continue
    }
    if (message.role === 'assistant') {
      const assistant = serializeAssistant(message)
      if (assistant !== undefined) wire.push(assistant)
      continue
    }
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    if (toolResults.length > 0) {
      const resultBlocks: WireToolResultBlock[] = toolResults.map(result => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      }))
      wire.push({ role: 'user', content: resultBlocks })
    }
  }
  return { systemParts, messages: wire }
}

/**
 * Serialize image-capable history. Tool-result images are displaced into one
 * following user message after their `tool_result` blocks (evidence: pi-ai).
 * @param messages - transient request history after request-size offloading.
 * @param images - prepared request versions and the request budget.
 * @param native - inline-attachment limits for this route, when it has any.
 * @param deepseek - whether the route declared DeepSeek compatibility, which
 *   has no `document` input; a binary file then fails loudly instead of
 *   travelling as a block the endpoint would reject or drop.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
  native?: NativeAttachmentOptions,
  deepseek = false,
): Promise<{ systemParts: string[]; messages: WireMessage[] }> {
  assertSupportedImageRoles(messages)
  const systemParts: string[] = []
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageBlock[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      systemParts.push(flattenText(message.content))
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      const assistant = serializeAssistant(message)
      if (assistant !== undefined) wire.push(assistant)
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    const parts = await contentBlocks(regular, images, native, deepseek)
    // Any non-text part (image or document) needs the structured content form.
    const hasMedia = parts.some(part => part.type !== 'text')
    const text = parts.filter((part): part is WireTextBlock => part.type === 'text').map(part => part.text).join('')
    if (parts.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({
        role: 'user',
        content: hasMedia ? parts : text,
      })
    }
    for (const result of toolResults) {
      const resultParts = await contentBlocks(result.content, images, native, deepseek)
      const imageBlocks = resultParts.filter((part): part is WireImageBlock => part.type === 'image')
      const resultText = resultParts.filter((part): part is WireTextBlock => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: result.toolCallId, content: resultText || '(no output)' }],
      })
      pendingToolImages.push(...imageBlocks)
    }
  }
  flushToolImages()
  return { systemParts, messages: wire }
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(
  options: GenerateOptions,
  system: string | undefined,
  messages: WireMessage[],
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  const thinking = resolveThinking(options, defaults, model)
  const thinkingBudget = thinking.kind === 'enabled' ? thinking.budget : undefined
  // The Messages API requires the default temperature while thinking is on;
  // DeepSeek accepts temperature in thinking mode, so only the standard vendor
  // drops it.
  const temperature = options.temperature !== undefined
      && (isDeepSeek(defaults) || thinkingBudget === undefined)
    ? options.temperature
    : undefined
  const maxTokens = options.maxTokens
    ?? model?.maxTokens
    // The Messages API requires max_tokens on every request; the shipped
    // catalog's own output cap is the evidence-based floor default.
    ?? 128_000
  return {
    model: options.model,
    messages,
    max_tokens: Math.max(maxTokens, thinkingBudget !== undefined ? thinkingBudget + 1024 : 0),
    stream: true,
    ...system !== undefined && system.length > 0 ? { system } : {},
    ...thinking.kind === 'omit'
      ? {}
      : thinking.kind === 'disabled'
        ? { thinking: { type: 'disabled' as const } }
        : { thinking: { type: 'enabled' as const, budget_tokens: thinking.budget } },
    // DeepSeek documents `thinking.budget_tokens` as ignored and takes the
    // depth from `output_config.effort` instead, so the budget alone would
    // leave the user's chosen effort unsent. Anthropic's own API has no
    // `output_config` and rejects unknown top-level fields, which is why this
    // rides the route's `compat` declaration rather than every Messages route.
    ...isDeepSeek(defaults) && thinking.kind === 'enabled' ? { output_config: { effort: thinking.effort } } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...temperature === undefined ? {} : { temperature },
    ...options.stop !== undefined ? { stop_sequences: options.stop } : {},
  }
}

/**
 * Build the full wire request. Always streaming; optional fields are omitted
 * rather than sent as null.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level defaults; undefined fields put nothing on the wire.
 * @param model - wire-relevant facts of the target catalog model; an
 *   uncatalogued model is treated as non-reasoning.
 * @returns the Messages request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  model?: ModelWireFacts,
): WireRequest {
  const { systemParts, messages } = serializeMessages(options.messages)
  const system = joinSystem(options.system, systemParts)
  return requestWithMessages(options, system, messages, defaults, model)
}

/**
 * Build one image-capable request. Oversized oldest images become per-image
 * text after their exact request-version byte lengths are known and before
 * provider serialization.
 * @param options - harness request containing image-capable user content.
 * @param images - prepared request versions, the current access resolver, and request bounds.
 * @param defaults - adapter-level defaults.
 * @param model - wire-relevant facts of the target catalog model.
 * @returns the fully materialized Messages request body.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
  model?: ModelWireFacts,
  native?: NativeAttachmentOptions,
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  const requestMessages = offloadRequestImagesWithPolicy(options.messages, {
    representation: 'base64',
    byteLength: (ref) => {
      const version = images.requestImages.get(ref.attachmentId)
      if (version === undefined) {
        throw new LlmError(`Anthropic request image ${ref.attachmentId} was not prepared.`, 'INVALID_REQUEST')
      }
      return version.bytes
    },
    maxBytes: images.maxRequestImageBytes,
    ...images.maxImagesPerRequest === undefined ? {} : { maxImages: images.maxImagesPerRequest },
    ...images.byteQuantum === undefined ? {} : { byteQuantum: images.byteQuantum },
    ...images.countQuantum === undefined ? {} : { countQuantum: images.countQuantum },
    placeholder: ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
  })
  const { systemParts, messages } = await serializeMessagesWithImages(requestMessages, images, native, isDeepSeek(defaults))
  const system = joinSystem(options.system, systemParts)
  return requestWithMessages(options, system, messages, defaults, model)
}

/** Fold the one-shot system option and in-history system messages together. */
function joinSystem(oneShot: string | undefined, historyParts: readonly string[]): string | undefined {
  const parts = [...(oneShot === undefined ? [] : [oneShot]), ...historyParts].filter(part => part.length > 0)
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
