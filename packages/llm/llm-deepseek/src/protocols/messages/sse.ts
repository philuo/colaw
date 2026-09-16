/**
 * SSE framing delegated to the shared WHATWG-strict framer; JSON errors remain
 * provider failures.
 */

import { LlmError, sseFrames } from '@deepseek-ai/dsh-llm'
import { object } from './replay.ts'
import { providerError } from './transport.ts'

/** Decode complete SSE frames without treating an unterminated tail as an event.
 * @param stream - decoded SSE text; the caller owns byte decoding (Bun 1.4's
 *   native `response.textStream()`).
 * @param activity - pulse the idle watchdog for events and heartbeat comments.
 * @returns JSON events, including message_stop; the translator owns completion.
 */
export async function* parseSse(stream: ReadableStream<string>, activity: () => void): AsyncGenerator<Record<string, unknown>> {
  for await (const frame of sseFrames(stream, activity)) {
    activity()
    let raw: unknown
    try { raw = JSON.parse(frame.data) } catch (_invalidSseJson) {
      throw new LlmError('DeepSeek Messages SSE contains invalid JSON', 'MALFORMED_RESPONSE')
    }
    const event = object(raw)
    if (typeof event.type !== 'string' || (frame.event !== '' && frame.event !== event.type)) {
      throw new LlmError('DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE')
    }
    if (event.type === 'error') throw providerError(event, undefined)
    yield event
  }
}
