/**
 * Serialize harness messages into OpenAI Responses input items. The system
 * prompt rides in as a leading `developer` message for reasoning models and
 * `system` elsewhere; user text and images become ordered input parts;
 * assistant turns replay as completed `message` items and `function_call`
 * items; tool results return as `function_call_output` items.
 *
 * Replay-id conventions follow pi-ai 0.85.1 (the reference this wire
 * replaces): a streamed tool call joins its two provider ids as
 * `call_id|item_id`, so replay can restore both; an id without the joint
 * came from another protocol and replays with the item id omitted, which
 * makes the API skip pairing validation instead of failing it.
 *
 * @module dsh-llm-provider/responses-serialize
 */

import { contentHasImage, LlmError, offloadedImageText, offloadRequestImagesWithPolicy, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageSerializationOptions, ModelWireFacts, RequestDefaults } from './serialize.ts'
import { dataUrl, readNativeAttachment, ridesNatively } from './native-media.ts'
import type { NativeAttachmentOptions } from './native-media.ts'
import type {
  ResponsesFunctionCallItem,
  ResponsesInputImagePart,
  ResponsesInputItem,
  ResponsesInputTextPart,
  ResponsesRequest,
  ResponsesTool,
  ResponsesUserContentPart,
} from './responses-types.ts'

/** The API rejects `max_output_tokens` below this floor. */
const MIN_OUTPUT_TOKENS = 16

/** Prefix of the deterministic replay ids for assistant text items. */
const MESSAGE_ID_PREFIX = 'msg_pi_'

/** Text substituted when a tool produced neither text nor images. */
const EMPTY_TOOL_OUTPUT = '(no tool output)'

/**
 * Resolve the wire `reasoning` field: an explicit effort when the request or
 * the route default selects one (harness `max` maps to `high`, `off` maps to
 * an explicit `none` — omission on a reasoning model would default to medium
 * reasoning, not off), and nothing when nobody expressed a preference.
 */
function resolveReasoning(
  options: GenerateOptions,
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): { effort: 'low' | 'high' | 'none' } | undefined {
  if (model?.reasoning !== true) return undefined
  if (options.purpose === 'session-title') return undefined
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : String(options.reasoningEffort)
  if (effort === undefined) return undefined
  if (effort === 'off') return { effort: 'none' }
  if (effort === 'low' || effort === 'high') return { effort }
  if (effort === 'max') return { effort: 'high' }
  throw new LlmError(
    `OpenAI does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The OpenAI responses adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Describe the exact request preview and its model-callable coordinate system. */
function imageHandle(
  ref: ImageAttachmentRef,
  version: RequestImageAttachment,
  resolveAccess: ImageAttachmentAccessResolver | undefined,
  precededByContent: boolean,
): ResponsesInputTextPart {
  return {
    type: 'input_text',
    text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
  }
}

/** Resolve one durable image into its descriptor and inline base64 image part. */
async function imageParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  precededByContent: boolean,
): Promise<[ResponsesInputTextPart, ResponsesInputImagePart]> {
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `OpenAI request image ${block.attachment.attachmentId} was not prepared.`,
      'INVALID_REQUEST',
    )
  }
  const image: ResponsesInputImagePart = {
    type: 'input_image',
    detail: 'auto',
    image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
  }
  return [imageHandle(block.attachment, version, images.resolveImageAccess, precededByContent), image]
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  native?: NativeAttachmentOptions,
): Promise<ResponsesUserContentPart[]> {
  const parts: ResponsesUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
        break
      case 'image':
        parts.push(...await imageParts(block, images, parts.length > 0))
        break
      case 'file': {
        // Only a reference the runtime kept (route family + declared modality)
        // reaches this branch; the Responses wire carries documents and has no
        // video input, so motion pictures never ride this route natively.
        if (!ridesNatively(native, block.attachment)) break
        const attachment = await readNativeAttachment(
          native as NativeAttachmentOptions, block.attachment, 'The OpenAI responses adapter')
        if (attachment.family === 'video') {
          throw new LlmError(
            'The OpenAI responses protocol has no video input; send the video through an openai-completions route',
            'UNSUPPORTED_CONTENT',
          )
        }
        parts.push({
          type: 'input_file',
          file_data: dataUrl(attachment.mediaType, attachment.bytes),
          filename: block.attachment.name,
        })
        break
      }
      case 'tool-result':
        parts.push(...await contentParts(block.content, images, native))
        break
      default:
        // Other merge-extensible blocks are not Responses user-input vocabulary.
        break
    }
  }
  return parts
}

/**
 * Split a streamed tool-call id back into its provider halves. Streamed
 * calls join `call_id|item_id`; a call from another protocol carries only
 * the call id, and its item id replays as omitted.
 */
export function splitToolCallId(id: string): { callId: string; itemId?: string } {
  const at = id.indexOf('|')
  if (at === -1) return { callId: id }
  return { callId: id.slice(0, at), itemId: id.slice(at + 1) }
}

/** Serialize one assistant message into completed output items. */
function serializeAssistant(message: Message, index: number): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  const text = flattenText(message.content)
  if (text.length > 0) {
    // Replay pairing keys off ids, so a replayed message item carries a
    // deterministic one derived from its position.
    items.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      status: 'completed',
      id: `${MESSAGE_ID_PREFIX}${index}`,
    })
  }
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    const { callId, itemId } = splitToolCallId(block.id)
    const call: ResponsesFunctionCallItem = {
      type: 'function_call',
      call_id: callId,
      name: block.name,
      arguments: block.arguments,
      ...itemId === undefined ? {} : { id: itemId },
    }
    items.push(call)
  }
  return items
}

/** Convert one tool result's blocks into the wire `output` value. */
async function toolResultOutput(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
  images: ImageSerializationOptions | undefined,
  modelAcceptsImages: boolean,
): Promise<string | (ResponsesInputTextPart | ResponsesInputImagePart)[]> {
  const text = flattenText(result.content)
  const imageBlocks = result.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => (
    block.type === 'image'
  ))
  if (images === undefined || imageBlocks.length === 0 || !modelAcceptsImages) {
    return text.length > 0 ? text : imageBlocks.length > 0 ? '(see attached image)' : EMPTY_TOOL_OUTPUT
  }
  const parts: (ResponsesInputTextPart | ResponsesInputImagePart)[] = []
  if (text.length > 0) parts.push({ type: 'input_text', text })
  for (const block of imageBlocks) parts.push(...await imageParts(block, images, parts.length > 0))
  return parts
}

/**
 * Serialize the conversation into input items. The harness puts each tool
 * result in its own user-role message, so a mixed user message contributes
 * its text first and each tool result as a separate item after. Without
 * prepared request images every image block is refused; with them, image
 * content is representable only in user messages and tool results for a
 * vision model.
 * @param messages - the harness conversation, in order.
 * @param images - prepared request versions when the request carries images.
 * @param modelAcceptsImages - whether the target model may receive image parts.
 * @returns ordered input items, message order preserved.
 */
export async function serializeResponsesMessages(
  messages: readonly Message[],
  images?: ImageSerializationOptions,
  modelAcceptsImages = false,
  native?: NativeAttachmentOptions,
): Promise<ResponsesInputItem[]> {
  const items: ResponsesInputItem[] = []
  let assistantIndex = 0
  for (const message of messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      items.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      items.push(...serializeAssistant(message, assistantIndex))
      assistantIndex += 1
      continue
    }
    // user role: text first, then each tool result as its own output item.
    const regular = message.content.filter(block => block.type !== 'tool-result')
    if (images === undefined) assertTextOnly(regular)
    const textParts = images === undefined
      ? regular
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => ({ type: 'input_text' as const, text: block.text }))
        .filter(part => part.text.length > 0)
      : await contentParts(regular, images, native)
    if (textParts.length > 0) items.push({ role: 'user', content: textParts })
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      items.push({
        type: 'function_call_output',
        call_id: splitToolCallId(block.toolCallId).callId,
        output: await toolResultOutput(block, images, modelAcceptsImages),
      })
    }
  }
  return items
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithInput(
  options: GenerateOptions,
  input: ResponsesInputItem[],
  defaults: RequestDefaults,
  model: ModelWireFacts | undefined,
): ResponsesRequest {
  const tools: ResponsesTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  // The wire lifts an output cap below the API's own floor up to it: a
  // smaller configured cap is not serviceable on this route.
  const cap = options.maxTokens ?? model?.maxTokens
  const reasoning = resolveReasoning(options, defaults, model)
  return {
    model: options.model,
    input,
    stream: true,
    store: false,
    ...cap === undefined ? {} : { max_output_tokens: Math.max(cap, MIN_OUTPUT_TOKENS) },
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...reasoning === undefined ? {} : { reasoning },
    // No `stop` field exists on this wire, so stop sequences cannot ride it.
  }
}

/** The leading role a system prompt takes: `developer` for reasoning models. */
function systemRole(model: ModelWireFacts | undefined): 'developer' | 'system' {
  return model?.reasoning === true ? 'developer' : 'system'
}

/** Prepend the one-shot system prompt as a leading input message. */
function withSystemPrompt(
  input: ResponsesInputItem[],
  options: GenerateOptions,
  model: ModelWireFacts | undefined,
): ResponsesInputItem[] {
  return options.system === undefined
    ? input
    : [{ role: systemRole(model), content: options.system }, ...input]
}

/**
 * Build the full text-only wire request.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level defaults; undefined fields put nothing on the wire.
 * @param model - wire-relevant facts of the target catalog model; an
 *   uncatalogued model is treated as non-reasoning.
 * @returns the Responses request body.
 */
export function serializeResponsesRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  model: ModelWireFacts | undefined = undefined,
): ResponsesRequest {
  const input = serializeResponsesMessagesSync(options.messages)
  return requestWithInput(options, withSystemPrompt(input, options, model), defaults, model)
}

/** Synchronous conversion for a request already known to be text-only. */
function serializeResponsesMessagesSync(messages: readonly Message[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  let assistantIndex = 0
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      items.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      items.push(...serializeAssistant(message, assistantIndex))
      assistantIndex += 1
      continue
    }
    const text = flattenText(message.content)
    if (text.length > 0) items.push({ role: 'user', content: [{ type: 'input_text', text }] })
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      items.push({
        type: 'function_call_output',
        call_id: splitToolCallId(block.toolCallId).callId,
        output: flattenText(block.content) || EMPTY_TOOL_OUTPUT,
      })
    }
  }
  return items
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Oversized oldest images become per-image text after their exact
 * request-version byte lengths are known and before provider serialization.
 * @param options - harness request containing image-capable user content.
 * @param images - prepared request versions, the current access resolver, and request bounds.
 * @param defaults - adapter-level defaults.
 * @param model - wire-relevant facts of the target catalog model.
 * @returns the fully materialized Responses request body.
 */
export async function serializeResponsesRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
  model: ModelWireFacts | undefined = undefined,
  native?: NativeAttachmentOptions,
): Promise<ResponsesRequest> {
  // Images are representable only in user messages on this route.
  for (const message of options.messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The OpenAI responses adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
  const modelAcceptsImages = options.messages.some(message => contentHasImage(message.content))
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
  const input = await serializeResponsesMessages(requestMessages, images, modelAcceptsImages, native)
  return requestWithInput(options, withSystemPrompt(input, options, model), defaults, model)
}
