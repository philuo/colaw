/**
 * OpenAI chat-completions wire format. Types only.
 *
 * Source of truth: the official OpenAI chat-completions API (the protocol the
 * DeepSeek endpoint is itself compatible with), cross-checked against the
 * wire shapes `dsh-llm-deepseek` has exercised against OpenAI-compatible
 * gateways. OpenAI-specific deltas from the DeepSeek dialect: no `thinking`
 * top-level field, no `reasoning_content` passback on assistant history,
 * `reasoning_effort` accepts only `low`/`high`, and the output-cap field name
 * is selectable (`max_tokens` vs `max_completion_tokens`).
 *
 * @module dsh-llm-provider/types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /**
   * Reasoning effort, sent only for catalog models declaring reasoning
   * support; OpenAI's vocabulary has no `off` (omitted) and no `max`
   * (harness `max` maps to `high`).
   */
  reasoning_effort?: 'low' | 'high'
  /**
   * zai-dialect thinking toggle (evidence: pi-ai's zai thinkingFormat) — an
   * explicit on/off with `clear_thinking: false`, sent even when the effort
   * is off, unlike `reasoning_effort`.
   */
  thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean }
  /** zai gateways stream tool-call arguments through a side channel when set. */
  tool_stream?: boolean
  tools?: WireTool[]
  temperature?: number
  /** Output cap; the field name is profile-selected (`maxTokensField`). */
  max_tokens?: number
  max_completion_tokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one
   * of these strings. Mapped from `GenerateOptions.stop`.
   */
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** Text part inside a multimodal user message. */
export interface WireTextContentPart {
  type: 'text'
  text: string
}

/** Inline base64 data URL inside a multimodal user message (OpenAI's only inline image form). */
export interface WireImageUrlContentPart {
  type: 'image_url'
  image_url: { url: string }
}

/** One image representation on this route (inline base64 only — no Files API). */
export type WireImageContentPart = WireImageUrlContentPart

/** Ordered input part accepted by a multimodal user message. */
export type WireUserContentPart = WireTextContentPart | WireImageUrlContentPart

/** User-role message: text-only string or ordered multimodal input. */
export interface WireUserMessage {
  role: 'user'
  content: string | WireUserContentPart[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/**
 * Assistant-role history message. The harness replays `content: ""` (never
 * null) on tool-call-only turns — some gateways reject null. OpenAI carries
 * no reasoning passback field, so reasoning text is intentionally absent.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: WireToolCall[]
}

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /**
   * CoT text. Official OpenAI chat completions do not emit reasoning text;
   * OpenAI-compatible gateways (DeepSeek dialect) do. Handled identically
   * wherever it appears, and absent without breaking anything when not.
   */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /**
   * Carried by the first delta of each call. Gateways observed in the wild
   * repeat it on continuation deltas as `''` or `null`; both mean "unchanged".
   */
  id?: string | null
  type?: 'function'
  function?: {
    /** Carried by the first delta of each call, with the same `''`/`null` repetition as {@link WireToolCallDelta.id}. */
    name?: string | null
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string | null
  }
}

/**
 * Wire token accounting. `prompt_tokens` INCLUDES cached reads
 * (`prompt_tokens_details.cached_tokens`), matching both OpenAI prompt-cache
 * and DeepSeek cache-hit semantics; `mapUsage` subtracts them to keep the
 * harness convention of disjoint counts.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  /** Provider-reported aggregate across prompt and completion tokens. */
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
