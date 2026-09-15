import { describe, expect, it } from 'vitest'
import { sseFrames } from '../src/sse-frames.ts'

/**
 * The shared SSE framer's contract, WHATWG-spec-strict. This is the framing
 * every LLM adapter consumes, so the spec's corner cases are proven here
 * once: line terminators, comment/field parsing, dispatch-on-blank-line,
 * chunk splits at every awkward offset, and the unterminated-tail rule.
 */

/** Build an SSE text stream from fragments (fragments = network reads). */
function chunks(...fragments: string[]): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(fragment)
      controller.close()
    },
  })
}

async function collect(
  stream: ReadableStream<string>,
  onComment?: (comment: string) => void,
): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = []
  for await (const frame of sseFrames(stream, onComment)) out.push(frame)
  return out
}

describe('sseFrames', () => {
  it('dispatches one event per blank-line-terminated block', async () => {
    const frames = await collect(chunks('data: one\n\ndata: two\n\n'))
    expect(frames).toEqual([{ event: '', data: 'one' }, { event: '', data: 'two' }])
  })

  it('strips exactly one leading space from field values', async () => {
    const frames = await collect(chunks('data: spaced\n\ndata:two-spaces:  x\n\n'))
    expect(frames.map(frame => frame.data)).toEqual(['spaced', 'two-spaces:  x'])
  })

  it('joins multiple data lines with newlines', async () => {
    const frames = await collect(chunks('data: first\ndata: second\n\ndata: x\n\n'))
    expect(frames).toEqual([{ event: '', data: 'first\nsecond' }, { event: '', data: 'x' }])
  })

  it('carries the event field alongside the data', async () => {
    const frames = await collect(chunks('event: message_start\ndata: {"a":1}\n\n'))
    expect(frames).toEqual([{ event: 'message_start', data: '{"a":1}' }])
  })

  it('lets a later event field overwrite an earlier one', async () => {
    const frames = await collect(chunks('event: first\nevent: second\ndata: x\n\n'))
    expect(frames).toEqual([{ event: 'second', data: 'x' }])
  })

  it('ignores id and retry fields', async () => {
    const frames = await collect(chunks('id: 7\nretry: 5000\ndata: x\n\n'))
    expect(frames).toEqual([{ event: '', data: 'x' }])
  })

  it('reports comments out of band, stripping one leading space', async () => {
    const comments: string[] = []
    const frames = await collect(chunks(': ping\n\n:keep-alive\ndata: x\n\n'), (line) => { comments.push(line) })
    expect(comments).toEqual(['ping', 'keep-alive'])
    expect(frames).toEqual([{ event: '', data: 'x' }])
  })

  it('drops an event with no data lines instead of dispatching it', async () => {
    const frames = await collect(chunks('event: orphan\n\ndata: real\n\n'))
    expect(frames).toEqual([{ event: '', data: 'real' }])
  })

  it('drops a bare data line with an empty value (empty joined buffer)', async () => {
    const frames = await collect(chunks('data:\n\ndata: real\n\n'))
    expect(frames).toEqual([{ event: '', data: 'real' }])
  })

  it('dispatches two bare data lines as a leading-newline payload', async () => {
    const frames = await collect(chunks('data:\ndata:\n\n'))
    expect(frames).toEqual([{ event: '', data: '\n' }])
  })

  it('accepts LF, CRLF, and lone CR terminators', async () => {
    const frames = await collect(chunks('data: a\ndata: b\r\ndata: c\r\ndata: d\n\n'))
    expect(frames).toEqual([{ event: '', data: 'a\nb\nc\nd' }])
  })

  it('frames incrementally across arbitrary chunk splits', async () => {
    const whole = 'event: e1\ndata: alpha\n\ndata: [DONE]\n\n'
    for (let at = 1; at < whole.length; at += 1) {
      const frames = await collect(chunks(whole.slice(0, at), whole.slice(at)))
      expect(frames).toEqual([{ event: 'e1', data: 'alpha' }, { event: '', data: '[DONE]' }])
    }
  })

  it('pairs a chunk-trailing CR with the following LF into one terminator', async () => {
    // A CR at the end of a chunk may be the first half of a CRLF: dispatching
    // it eagerly would turn the next chunk's LF into a blank line and split
    // one event into two.
    const frames = await collect(chunks('data: x\r', '\ndata: y\n\n'))
    expect(frames).toEqual([{ event: '', data: 'x\ny' }])
  })

  it('does not dispatch an event left pending at EOF by a trailing lone CR', async () => {
    // The CR terminates the data line, but no blank line follows, so the
    // event stays undispatched — truncation semantics.
    const frames = await collect(chunks('data: x\r'))
    expect(frames).toEqual([])
  })

  it('dispatches on a blank line spelled as a lone CR', async () => {
    const frames = await collect(chunks('data: x\r\r'))
    expect(frames).toEqual([{ event: '', data: 'x' }])
  })

  it('strips a leading UTF-8 BOM from the first chunk', async () => {
    const frames = await collect(chunks('\uFEFFdata: bom\n\n'))
    expect(frames).toEqual([{ event: '', data: 'bom' }])
  })

  it('discards an unterminated tail at EOF (truncation, not a flush)', async () => {
    const frames = await collect(chunks('data: done\n\ndata: half'))
    expect(frames).toEqual([{ event: '', data: 'done' }])
  })

  it('dispatches nothing for a stream of only comments and blank lines', async () => {
    const frames = await collect(chunks(': a\n\n: b\n\n'))
    expect(frames).toEqual([])
  })

  it('dispatches data before the blank line even when the stream never ends cleanly', async () => {
    // Real providers keep sockets open between events; the framer must yield
    // each event on its terminator, not hold everything for EOF.
    const frames = await collect(chunks('event: e\ndata: 1\n\n'))
    expect(frames).toEqual([{ event: 'e', data: '1' }])
  })
})
