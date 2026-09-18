/**
 * DeepSeek Responses wire format. Types only.
 *
 * Source of truth: the official API docs at
 * `https://api-docs.deepseek.com/zh-cn/guides/responses_api` (compatibility
 * matrix, consulted 2026-09). The Chinese page is authoritative where the two
 * languages disagree — the English one still says `developer` is treated as
 * `system`, while the Chinese matrix says `developer` 视同 `user`, and that
 * difference decides where a system prompt may be sent.
 *
 * Only the parameters DeepSeek documents as supported appear here. The endpoint
 * **silently ignores** unsupported ones, so sending any of `store`,
 * `previous_response_id`, `conversation`, `background`, `metadata`, `prompt`,
 * `include`, `truncation`, `service_tier`, `parallel_tool_calls`,
 * `max_tool_calls`, `context_management`, `prompt_cache_key` or
 * `stream_options` would not fail loudly — it would just not do what it looks
 * like it does. They are deliberately absent from {@link WireRequest}.
 *
 * @module dsh-llm-deepseek/openai-responses-types
 */

/** Request body for `POST {baseURL}/responses`. */
export interface WireRequest {
  model: string
  /**
   * Ordered input items. At least one of `input` and `instructions` is
   * required, so a request with no history sends `input: []` and instructions.
   */
  input: WireInputItem[]
  /**
   * The system prompt. DeepSeek inserts it as the leading system message, which
   * is why a caller with a system prompt does not also build a `system` item.
   */
  instructions?: string
  stream: true
  max_output_tokens?: number
  /** Range [0, 2]; DeepSeek notes it has no effect in thinking mode. */
  temperature?: number
  /** `summary` is accepted but produces nothing, so only `effort` is ever sent. */
  reasoning?: { effort: 'low' | 'high' | 'max' }
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  /** Rate-limit isolation key. */
  user?: string
}

/** Tool-choice selector; `required` and a named function are both supported. */
export type WireToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; name: string }

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
}

/** Text part of a message item. */
export interface WireInputTextPart {
  type: 'input_text'
  text: string
}

/** Assistant text replayed as an output part. */
export interface WireOutputTextPart {
  type: 'output_text'
  text: string
}

/**
 * Image part of a message item.
 *
 * `image_url` and `file_id` are mutually exclusive **and** one of them is
 * required: neither returns 400 ("input_image must have image_url or file_id")
 * and both returns 400 ("input_image cannot have both image_url and file_id").
 * `file_id` names a file uploaded through the Files API — which stores images
 * only — and `detail` is ignored for it.
 */
export type WireInputImagePart =
  | { type: 'input_image'; image_url: string; detail?: WireImageDetail }
  | { type: 'input_image'; file_id: string }

/** Image detail hint; `low` shrinks to 512x512 before inference. */
export type WireImageDetail = 'low' | 'high' | 'original' | 'auto'

/** Ordered content of a message item. */
export type WireMessagePart = WireInputTextPart | WireOutputTextPart | WireInputImagePart

/** One message item. */
export interface WireInputMessage {
  /**
   * `developer` is equivalent to `user` on this endpoint, so the only role that
   * carries instructions is `system`.
   */
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | WireMessagePart[]
}

/** One replayed tool call. The endpoint merges it into the adjacent assistant message. */
export interface WireFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  /** Raw JSON string of the arguments. */
  arguments: string
}

/** One tool result; `output` is a string or ordered parts, images included. */
export interface WireFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | WireFunctionCallOutputPart[]
}

/** Part accepted inside a `function_call_output`. */
export type WireFunctionCallOutputPart = WireInputTextPart | WireInputImagePart

/**
 * Replayed reasoning. DeepSeek folds plain-text `content` into the adjacent
 * assistant message and does not support `summary` or `encrypted_content`.
 */
export interface WireReasoningItem {
  type: 'reasoning'
  content: WireInputTextPart[]
}

/** One entry of the request `input` array, discriminated on `type` or `role`. */
export type WireInputItem =
  | WireInputMessage
  | WireFunctionCallItem
  | WireFunctionCallOutputItem
  | WireReasoningItem

/** Token usage; `output_tokens_details.reasoning_tokens` is the thinking share. */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/** One streamed event; every field beyond `type` belongs to that event's own shape. */
export interface WireStreamEvent {
  type: string
  sequence_number?: number
  delta?: string
  /** Which output item a delta belongs to; the wire's own routing key. */
  item_id?: string
  /** Position of that item within `response.output`. */
  output_index?: number
  item?: { type?: string; id?: string; name?: string; call_id?: string; phase?: string }
  /** Present on the three terminal events. */
  response?: WireResponse
}

/** The `response` object carried by a terminal event. */
export interface WireResponse {
  id?: string
  status?: string
  usage?: WireUsage
  output?: { type?: string; id?: string; name?: string; call_id?: string; content?: unknown }[]
  incomplete_details?: { reason?: string }
  error?: { code?: string; message?: string }
}

/** Error body of a non-2xx response; the shape the gateway really returns. */
export interface WireError {
  error?: { message?: string; type?: string; param?: string | null; code?: string }
}
