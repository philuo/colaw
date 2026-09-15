import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'
import { DONE } from '../src/sse.ts'

async function* payloads(events: readonly string[]): AsyncGenerator<string> {
  for (const event of events) yield event
}

async function collect(events: readonly string[]): Promise<string[]> {
  const kinds: string[] = []
  for await (const chunk of translate(payloads(events))) kinds.push(chunk.type)
  return kinds
}

describe('mapFinishReason', () => {
  it('maps the shared vocabulary and falls back to an error finish', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('mapUsage', () => {
  it('subtracts cached reads out of the input count and carries reasoning tokens', () => {
    expect(mapUsage({
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 6 },
      completion_tokens_details: { reasoning_tokens: 2 },
    })).toEqual({
      inputTokens: 4,
      outputTokens: 4,
      totalTokens: 14,
      cacheReadTokens: 6,
      reasoningTokens: 2,
    })
  })

  it('keeps the total only when the aggregate counters agree', () => {
    const usage = mapUsage({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 99 })
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 1 })
  })
})

describe('translate', () => {
  it('streams text deltas and defers block-end, usage, and finish to [DONE]', async () => {
    const chunks = []
    for await (const chunk of translate(payloads([
      '{"choices":[{"delta":{"role":"assistant","content":"he"}}]}',
      '{"choices":[{"delta":{"content":"llo"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      DONE,
    ]))) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    const end = chunks[3] as { block: { text: string } }
    expect(end.block.text).toBe('hello')
  })

  it('assembles parallel tool calls from index-keyed deltas', async () => {
    const chunks = []
    for await (const chunk of translate(payloads([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"lookup","arguments":"{\\"q\\""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"other","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      DONE,
    ]))) chunks.push(chunk)
    const ends = chunks.filter(chunk => chunk.type === 'block-end') as Array<{ index: number; block: { type: string; id: string; name: string; arguments: string } }>
    expect(ends).toHaveLength(2)
    const first = ends[0]!
    const second = ends[1]!
    expect(first.block).toEqual({ type: 'tool-call', id: 'call_a', name: 'lookup', arguments: '{"q":"x"}' })
    expect(second.block).toEqual({ type: 'tool-call', id: 'call_b', name: 'other', arguments: '{}' })
  })

  it('opens reasoning blocks for gateway reasoning_content without touching official OpenAI', async () => {
    const kinds = await collect([
      '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
      '{"choices":[{"delta":{"content":"answer"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      DONE,
    ])
    expect(kinds).toEqual([
      'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'finish',
    ])
  })

  it('maps a content-free stop finish to an EMPTY_RESPONSE error finish', async () => {
    const chunks = []
    for await (const chunk of translate(payloads([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      DONE,
    ]))) chunks.push(chunk)
    const finish = chunks.at(-1) as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(EMPTY_RESPONSE_CODE)
  })

  it('throws MALFORMED_RESPONSE on a non-JSON payload', async () => {
    await expect(async () => {
      for await (const chunk of translate(payloads(['not-json', DONE]))) void chunk
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throws STREAM_CLOSED when the payload source ends without [DONE]', async () => {
    await expect(async () => {
      for await (const chunk of translate(payloads(['{"choices":[{"delta":{"content":"x"}}]}']))) void chunk
    }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
