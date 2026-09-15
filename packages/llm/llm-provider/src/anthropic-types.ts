/**
 * Anthropic messages wire format. Types only.
 *
 * Source of truth: pi-ai 0.85.1's `api/anthropic-messages.js` (the
 * implementation this adapter polyfills), cross-checked against the
 * official Messages API shape. Deliberately NOT polyfilled: OAuth flows,
 * prompt cache_control, beta headers (interleaved thinking / fine-grained
 * tool streaming / strict tools), thinking-signature replay (the harness
 * reasoning block carries no signature — pi-ai's default converts unsigned
 * thinking to plain text on replay, and so does this adapter), fallback
 * blocks, and managed providers.
 *
 * @module dsh-llm-provider/anthropic-types
 */

/** Request body for `POST {baseURL}/v1/messages`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  /** Required by the Messages API; always sent. */
  max_tokens: number
  stream: true
  /** Top-level system prompt (the Messages API has no system role in messages). */
  system?: string
  /** Extended thinking; sent only for catalog models declaring `reasoning`. */
  thinking?: { type: 'enabled'; budget_tokens: number }
  tools?: WireTool[]
  /**
   * Omitted when thinking is enabled (the Messages API requires the default
   * temperature there).
   */
  temperature?: number
  stop_sequences?: string[]
}

/** Text block inside a user or assistant message. */
export interface WireTextBlock {
  type: 'text'
  text: string
}

/** Inline base64 image block inside a user message. */
export interface WireImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

/** Ordered input part accepted by a user message. */
export type WireUserContentBlock = WireTextBlock | WireImageBlock

/** User-role message: plain string or ordered blocks. */
export interface WireUserMessage {
  role: 'user'
  content: string | WireUserContentBlock[]
}

/** One replayed tool call on an assistant message; `input` is the parsed JSON object. */
export interface WireToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Assistant-role message. Unsigned harness reasoning folds into a plain text
 * block (pi-ai's default for missing thinking signatures); the wire
 * `thinking` block type is intentionally absent.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: (WireTextBlock | WireToolUseBlock)[]
}

/** Tool-result block delivered inside a user message. */
export interface WireToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

/** User-role message carrying tool results (consecutive results share one message). */
export interface WireToolResultMessage {
  role: 'user'
  content: WireToolResultBlock[]
}

/** One entry of the request `messages` array, discriminated on role/shape. */
export type WireMessage =
  | WireUserMessage
  | WireAssistantMessage
  | WireToolResultMessage

/** One entry of the request `tools` array; `input_schema` is a JSON Schema object. */
export interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** One parsed SSE frame: the `event:` name plus its JSON `data` payload. */
export interface WireEvent {
  event: string
  data: WireEventData
}

export type WireEventData =
  | { type: 'message_start'; message?: { usage?: Partial<WireUsage> } }
  | {
    type: 'content_block_start'
    index: number
    content_block:
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; id?: string; name?: string }
      | { type: 'thinking'; thinking?: string }
      | { type: 'redacted_thinking'; data?: string }
  }
  | {
    type: 'content_block_delta'
    index: number
    delta:
      | { type: 'text_delta'; text?: string }
      | { type: 'input_json_delta'; partial_json?: string }
      | { type: 'thinking_delta'; thinking?: string }
      | { type: 'signature_delta'; signature?: string }
  }
  | { type: 'content_block_stop'; index: number }
  | {
    type: 'message_delta'
    delta?: { stop_reason?: string; stop_sequence?: string | null }
    usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }
  }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } }

/** Non-streaming usage accounting. `input_tokens` EXCLUDES the cache fields. */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Non-2xx error body. */
export interface WireError {
  error?: { type?: string; message?: string }
}
