/**
 * Decode an SSE byte stream into `{event, data}` frames. Anthropic types
 * every frame with an `event:` name (message_start, content_block_*,
 * message_delta, message_stop, ping, error); the JSON `data` arrives as one
 * line. Framing — chunk reassembly, UTF-8/CRLF/BOM handling, multi-`data:`
 * joining — is `eventsource-parser`'s. EOF before `message_stop` raises
 * {@link LlmError}: a truncated response cannot be trusted.
 *
 * @module dsh-llm-anthropic/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal event of every complete Messages API stream. */
export const MESSAGE_STOP = 'message_stop'

export interface SseFrame {
  event: string
  data: string
}

/**
 * Parse an SSE byte stream into `{event, data}` frames. Yields the
 * `message_stop` frame as the final value and returns; throws
 * `LlmError('STREAM_CLOSED')` when the stream ends without it.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback.
 * @returns each event's frame in arrival order, `message_stop` last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<SseFrame> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const parsed of events) {
    const event = parsed.event ?? ''
    const data = parsed.data
    if (event.length === 0) continue
    yield { event, data }
    if (event === MESSAGE_STOP) return
  }
  throw new LlmError('SSE stream ended without message_stop', 'STREAM_CLOSED')
}
