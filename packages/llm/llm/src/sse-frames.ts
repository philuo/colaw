/**
 * Frame an SSE text stream into events, WHATWG-spec-strict: lines split on
 * CRLF/CR/LF (including a CRLF the caller splits across chunks), a dispatch
 * happens only on the blank-line terminator, `data:` lines join with `\n`,
 * `id:`/`retry:` fields are ignored, and an unterminated tail at EOF is
 * truncation, not a flushable payload. Byte decoding is the caller's: the
 * adapters consume Bun 1.4's native `response.textStream()`, which decodes
 * each body chunk directly instead of piping bytes through a
 * `TextDecoderStream`, so the stream carries strings end to end and one less
 * transform stage holds buffers between provider writes.
 *
 * @module dsh-llm/sse-frames
 */

/** One dispatched SSE event: the `event:` field name (often absent) and the joined `data` payload. */
export interface SseFrame {
  event: string
  data: string
}

/**
 * Frame an SSE text stream into `{event, data}` pairs.
 * @param stream - decoded SSE text; chunk boundaries may split anywhere,
 *   including mid-line or mid-UTF-8 sequence (decoding is the caller's).
 * @param onComment - optional transport-activity callback; comments never
 *   enter the framed stream.
 * @returns each dispatched frame in arrival order; the stream's end is the
 *   only terminator — terminal-event contracts belong to the callers.
 */
export async function* sseFrames(
  stream: ReadableStream<string>,
  onComment?: (comment: string) => void,
): AsyncGenerator<SseFrame> {
  // The first chunk may carry the UTF-8 BOM; the decoder keeps it because it
  // decodes the bytes it is handed, not a framed document.
  let atStart = true
  let buffer = ''
  let event = ''
  let data: string[] = []

  /** Reset the buffers, yielding the frame only when data lines accumulated. */
  const dispatch = (): SseFrame | undefined => {
    // The spec dispatches on the JOINED data buffer: one bare `data:` line
    // leaves it empty, which resets without dispatching, while two join to a
    // non-empty leading-newline payload.
    const joined = data.join('\n')
    const frame = joined.length > 0 ? { event, data: joined } : undefined
    event = ''
    data = []
    return frame
  }

  /** Apply one terminated line; a blank line dispatches the pending event. */
  const processLine = (line: string): SseFrame | undefined => {
    if (line.length === 0) return dispatch()
    // A comment line carries no field; its text (one leading space stripped)
    // never enters the framed stream.
    if (line.startsWith(':')) {
      onComment?.(line.slice(1).replace(/^ /, ''))
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    // `id`/`retry` and anything unknown carry no meaning on these routes.
    return undefined
  }

  for await (let chunk of stream) {
    if (atStart) {
      atStart = false
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
    }
    buffer += chunk
    while (true) {
      const cut = nextLineEnd(buffer)
      // A lone CR can only be dispatched once the next byte proves it is not
      // the first half of a CRLF the caller split across chunks.
      if (cut === undefined || (cut.kind === 'cr' && cut.end === buffer.length)) break
      const line = buffer.slice(0, cut.start)
      buffer = buffer.slice(cut.end)
      const frame = processLine(line)
      if (frame !== undefined) yield frame
    }
  }
  // The final line (no terminator followed it) and a stream-trailing lone CR
  // terminate one last line; any event it joined stays undispatched.
  if (buffer.length > 0) {
    const frame = processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
    if (frame !== undefined) yield frame
  }
}

/** The earliest line terminator in `buffer`, classified so a trailing lone CR can wait for its LF. */
function nextLineEnd(buffer: string): { start: number; end: number; kind: 'cr' | 'lf' } | undefined {
  const cr = buffer.indexOf('\r')
  const lf = buffer.indexOf('\n')
  if (cr === -1 && lf === -1) return undefined
  if (lf === -1) return { start: cr, end: cr + 1, kind: 'cr' }
  if (cr === -1 || lf < cr) return { start: lf, end: lf + 1, kind: 'lf' }
  if (lf === cr + 1) return { start: cr, end: lf + 1, kind: 'lf' }
  return { start: cr, end: cr + 1, kind: 'cr' }
}
