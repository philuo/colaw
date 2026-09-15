/**
 * Decode an SSE text stream into event `data` payloads, over the shared
 * WHATWG-strict framer. Comments are reported only through an optional
 * transport-activity callback. This module keeps the OpenAI protocol: the
 * literal `[DONE]` is yielded so the caller owns final flushing, and EOF
 * before it raises {@link LlmError}.
 *
 * @module dsh-llm-openai/sse
 */

import { LlmError, sseFrames } from '@deepseek-ai/dsh-llm'

/** The terminal payload OpenAI (and every compatible gateway) send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE text stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - decoded SSE text; chunk boundaries may split anywhere,
 *   including mid-line or mid-UTF-8 sequence (decoding is the caller's).
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<string>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  for await (const { data } of sseFrames(stream, onComment)) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
