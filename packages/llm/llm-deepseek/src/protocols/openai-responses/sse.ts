/**
 * Decode an SSE text stream into event payloads, over the shared strict framer.
 *
 * This wire has **no `data: [DONE]` sentinel**: DeepSeek ends a Responses stream
 * with a `response.completed` / `response.incomplete` / `response.failed` event.
 * So this module deliberately has no terminal marker to look for and no
 * end-of-stream check of its own — deciding whether a stream ended properly
 * requires reading the events, which is the translator's job. An EOF here is
 * just an EOF; `translateResponses` is what refuses a stream that stopped
 * without its terminal event.
 *
 * Comments are reported only through the transport-activity callback, which is
 * what keeps a heartbeat from counting as provider progress: they never enter
 * the yielded payload stream.
 *
 * @module dsh-llm-deepseek/openai-responses-sse
 */

import { sseFrames } from '@deepseek-ai/dsh-llm'

/**
 * Parse an SSE text stream into data payloads, in arrival order.
 *
 * @param stream - decoded SSE text; chunk boundaries may split anywhere,
 *   including mid-line or mid-UTF-8 sequence (decoding is the caller's).
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload, with no terminal marker appended.
 */
export async function* parseSse(
  stream: ReadableStream<string>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  for await (const { data } of sseFrames(stream, onComment)) {
    yield data
  }
}
