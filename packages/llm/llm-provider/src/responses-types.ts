/**
 * OpenAI Responses wire format. Types only.
 *
 * Source of truth: the official OpenAI Responses API, cross-checked against
 * pi-ai 0.85.1's `openai-responses` implementation (the reference this wire
 * replaces). Every streamed event is a JSON object whose `type` field names
 * it; the SSE `event:` field is redundant and ignored.
 *
 * @module dsh-llm-provider/responses-types
 */

/** Request body for `POST {baseURL}/responses` (always `stream: true`). */
export interface ResponsesRequest {
  model: string
  /** Ordered input items; the system prompt is a leading `developer`/`system` message item. */
  input: ResponsesInputItem[]
  stream: true
  /** Statelessness is explicit: nothing is stored server-side between turns. */
  store: false
  /**
   * Output cap. The API rejects values below 16, so a smaller configured cap
   * clamps up (pi-ai 0.85.1 behavior).
   */
  max_output_tokens?: number
  temperature?: number
  tools?: ResponsesTool[]
  /**
   * Reasoning controls for reasoning models: an effort level, `none` when the
   * request turns reasoning off. Omitted entirely otherwise (the provider's
   * default effort then applies).
   */
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'none' }
}

/** One `input` entry, discriminated on `type` (message roles have no `type`). */
export type ResponsesInputItem =
  | { role: 'developer' | 'system'; content: string }
  | { role: 'user'; content: ResponsesUserContentPart[] }
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

/** Text part inside a multimodal user message. */
export interface ResponsesInputTextPart {
  type: 'input_text'
  text: string
}

/** Inline base64 data-URL image part inside a user message (no Files API here). */
export interface ResponsesInputImagePart {
  type: 'input_image'
  /** Always `auto`: the harness sizes images before serialization. */
  detail: 'auto'
  image_url: string
}

/**
 * Document part — OpenAI Responses' `input_file`, whose `file_data` carries a
 * base64 Data URL (or a Files API `file_id`, which this route does not use).
 */
export interface ResponsesInputFilePart {
  type: 'input_file'
  file_data: string
  filename?: string
}

/** Ordered input part accepted by a user message. */
export type ResponsesUserContentPart =
  | ResponsesInputTextPart
  | ResponsesInputImagePart
  | ResponsesInputFilePart

/** An assistant text turn replayed as a completed output message. */
export interface ResponsesMessageItem {
  type: 'message'
  role: 'assistant'
  content: { type: 'output_text'; text: string; annotations: never[] }[]
  status: 'completed'
  /**
   * Deterministic replay id. The Responses API pairs tool calls with the
   * items around them by id, so replayed text carries a stable id derived
   * from its position (pi-ai's `msg_pi_<n>` scheme); ids longer than the
   * API's 64-character bound are hashed down by the same scheme.
   */
  id: string
}

/** An assistant tool call replayed; `arguments` is the raw JSON string. */
export interface ResponsesFunctionCallItem {
  type: 'function_call'
  /**
   * The item id the API issued (`fc_…`), when the harness id carries one.
   * Omitting it is accepted: the API then skips pairing validation, which is
   * exactly what a call replayed from another protocol wants.
   */
  id?: string
  /** The call correlation id shared with the matching function_call_output. */
  call_id: string
  name: string
  arguments: string
}

/** A tool result returned to the API; `call_id` pairs it with the call. */
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  /** Text, or ordered parts when the result carries images for a vision model. */
  output: string | (ResponsesInputTextPart | ResponsesInputImagePart)[]
}

/** One entry of the request `tools` array; flat, unlike chat completions. */
export interface ResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** The usage report carried by the terminal `response.completed` event. */
export interface ResponsesUsage {
  /** INCLUDES cached reads and cache writes, matching the harness's subtraction rule. */
  input_tokens: number
  output_tokens: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/** The response summary embedded in terminal events. */
export interface ResponsesResponseSummary {
  id?: string
  status?: 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'in_progress' | 'queued'
  /** Present on `incomplete`; `max_output_tokens` maps to a length finish. */
  incomplete_details?: { reason?: string } | null
  error?: { code?: string; message?: string } | null
  usage?: ResponsesUsage | null
}

/** Any streamed event payload, discriminated on `type`. */
export type ResponsesEvent =
  | { type: 'response.created'; response: ResponsesResponseSummary }
  | { type: 'response.in_progress'; response: ResponsesResponseSummary }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_text.delta'; output_index: number; delta: string }
  | { type: 'response.refusal.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_text.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_summary_part.done'; output_index: number }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; output_index: number; arguments?: string }
  | { type: 'response.completed'; response: ResponsesResponseSummary }
  | { type: 'response.incomplete'; response: ResponsesResponseSummary }
  | { type: 'response.failed'; response: ResponsesResponseSummary }
  | { type: 'error'; code?: string; message?: string }

/** One output item as announced by `output_item.added`/`done`. */
export type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesReasoningOutput
  | ResponsesFunctionCallOutput

/** A completed assistant message item on the output stream. */
export interface ResponsesMessageOutput {
  type: 'message'
  id?: string
  /** `final_answer` marks the visible answer of a phased model. */
  phase?: 'commentary' | 'final_answer' | string
  content?: ({ type: 'output_text'; text?: string } | { type: 'refusal'; refusal?: string })[]
}

/** A reasoning item; its summary/content text is what the wire streams live. */
export interface ResponsesReasoningOutput {
  type: 'reasoning'
  id?: string
  summary?: { type?: string; text?: string }[]
  content?: { type?: string; text?: string }[]
}

/** A function-call item on the output stream. */
export interface ResponsesFunctionCallOutput {
  type: 'function_call'
  id?: string
  call_id?: string
  name?: string
  arguments?: string
}

/** Non-2xx error body (same envelope as chat completions). */
export interface ResponsesErrorBody {
  error?: { message?: string; type?: string; code?: string }
}
