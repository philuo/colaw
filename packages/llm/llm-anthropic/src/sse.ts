/**
 * Decode an SSE text stream into `{event, data}` frames, over the shared
 * WHATWG-strict framer. Anthropic types every frame with an `event:` name
 * (message_start, content_block_*, message_delta, message_stop, ping,
 * error); the JSON `data` arrives as one line. EOF before `message_stop`
 * raises {@link LlmError}: a truncated response cannot be trusted.
 *
 * @module dsh-llm-anthropic/sse
 */

import { LlmError, sseFrames } from '@deepseek-ai/dsh-llm'

/** The terminal event of every complete Messages API stream. */
export const MESSAGE_STOP = 'message_stop'

export interface SseFrame {
  event: string
  data: string
}

/**
 * Parse an SSE text stream into `{event, data}` frames. Yields the
 * `message_stop` frame as the final value and returns; throws
 * `LlmError('STREAM_CLOSED')` when the stream ends without it.
 * @param stream - decoded SSE text; chunk boundaries may split anywhere,
 *   including mid-line or mid-UTF-8 sequence (decoding is the caller's).
 * @param onComment - optional transport-activity callback.
 * @returns each event's frame in arrival order, `message_stop` last.
 */
export async function* parseSse(
  stream: ReadableStream<string>,
  onComment?: (comment: string) => void,
): AsyncGenerator<SseFrame> {
  for await (const parsed of sseFrames(stream, onComment)) {
    const event = parsed.event ?? ''
    const data = parsed.data
    if (event.length === 0) continue
    yield { event, data }
    if (event === MESSAGE_STOP) return
  }
  throw new LlmError('SSE stream ended without message_stop', 'STREAM_CLOSED')
}
