import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { mapResponsesStatus, mapResponsesUsage, translateResponses } from '../src/responses-translate.ts'

async function* payloads(events: readonly string[]): AsyncGenerator<string> {
  for (const event of events) yield event
}

async function chunksOf(events: readonly string[]): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of translateResponses(payloads(events))) chunks.push(chunk)
  return chunks
}

/** A minimal terminal completed event. */
const completed = (usage: unknown = { input_tokens: 5, output_tokens: 2 }): string =>
  JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage } })

describe('translateResponses: text', () => {
  it('streams one text block per message item, canonicalized at item done', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'hel' }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
      // The done item's own text is authoritative over the delta accumulation.
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'hello!' }] } }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello!' } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams refusal deltas as text', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: 'no' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'refusal', refusal: 'no.' }] } }),
      completed(),
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'no' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'no.' } })
  })

  it('closes still-open items at the terminal event, in announcement order', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'kept' }),
      completed(),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'kept' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'kept' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translateResponses: reasoning', () => {
  it('streams summary and raw reasoning deltas and joins summary parts', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } }),
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'thinking' }),
      JSON.stringify({ type: 'response.reasoning_summary_part.done', output_index: 0 }),
      JSON.stringify({ type: 'response.reasoning_text.delta', output_index: 0, delta: 'raw' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ text: 'thinking' }] } }),
      completed(),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'reasoning-delta', index: 0, text: '\n\n' },
      { type: 'reasoning-delta', index: 0, text: 'raw' },
      // The wire's own summary is canonical; live content stays a fallback.
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translateResponses: tool calls', () => {
  it('joins the call and item ids and maps a completed tool response to tool-calls', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' } }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city"' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: ': "SF"}' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city": "SF"}' } }),
      completed(),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1|fc_1', name: 'get_weather', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, id: 'call_1|fc_1', name: 'get_weather', argumentsDelta: ': "SF"}' },
      // The done arguments replace the accumulation and are not re-emitted.
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1|fc_1', name: 'get_weather', arguments: '{"city": "SF"}' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('flushes arguments.done suffix the deltas did not carry', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get' } }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a"' }),
      JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"a":1}' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: '{"a":1}' } }),
      completed(),
    ])
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: 'call_1|fc_1', name: 'get', argumentsDelta: ':1}' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1|fc_1', name: 'get', arguments: '{"a":1}' } })
  })

  it('omits the item-id half when the announcing item carried none', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'get' } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'get', arguments: '{}' } }),
      completed(),
    ])
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_9', name: 'get', arguments: '{}' } })
  })

  it('keeps parallel tool-call items on distinct blocks by output index', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'a' } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'b' } }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '2' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '1' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: '1' } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', arguments: '2' } }),
      completed(),
    ])
    expect(chunks.filter(chunk => (chunk as { type: string }).type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', index: 1, id: 'call_2|fc_2', name: 'b', argumentsDelta: '2' },
      { type: 'tool-call-delta', index: 0, id: 'call_1|fc_1', name: 'a', argumentsDelta: '1' },
    ])
  })
})

describe('translateResponses: terminals and failures', () => {
  it('maps incomplete max_output_tokens to a length finish', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'cut off' }),
      JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('maps an incomplete response without a reason to an error finish', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }),
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: 'Response incomplete: content_filter' } } })
  })

  it('throws SERVER on response.failed with the provider error details', async () => {
    await expect(chunksOf([
      JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }),
    ])).rejects.toMatchObject({ code: 'SERVER', message: 'server_error: boom' })
  })

  it('throws SERVER on a stream error event', async () => {
    await expect(chunksOf([
      JSON.stringify({ type: 'error', code: 'overloaded', message: 'try again' }),
    ])).rejects.toMatchObject({ code: 'SERVER', message: 'Error Code overloaded: try again' })
  })

  it('throws STREAM_CLOSED when the stream ends before a terminal event', async () => {
    await expect(chunksOf([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
    ])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('throws MALFORMED_RESPONSE for a non-JSON payload', async () => {
    await expect(chunksOf(['not json'])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('maps a completed empty response to EMPTY_RESPONSE, usage still reported first', async () => {
    const chunks = await chunksOf([completed(null)])
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
    }])
    const withUsage = await chunksOf([completed()])
    expect(withUsage).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
      },
    ])
  })

  it('ignores unknown event types and heartbeats', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ type: 'response.created', response: {} }),
      JSON.stringify({ type: 'response.in_progress', response: {} }),
      JSON.stringify({ type: 'response.queued.something.future', data: 1 }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      completed(),
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('mapResponsesUsage', () => {
  it('subtracts cached reads and cache writes out of the input count', () => {
    expect(mapResponsesUsage({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 8 },
    })).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      totalTokens: 80,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      reasoningTokens: 8,
    })
  })

  it('floors a nonsensical negative input at zero without crashing', () => {
    const usage = mapResponsesUsage({ input_tokens: 5, output_tokens: 5, input_tokens_details: { cached_tokens: 50 } })
    expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 5 })
  })
})

describe('mapResponsesStatus', () => {
  it('maps completed to stop, demoted to tool-calls when calls exist', () => {
    expect(mapResponsesStatus({ status: 'completed' }, false)).toEqual({ kind: 'stop' })
    expect(mapResponsesStatus({ status: 'completed' }, true)).toEqual({ kind: 'tool-calls' })
  })

  it('maps failed and cancelled to error finishes', () => {
    expect(mapResponsesStatus({ status: 'failed' }, false).kind).toBe('error')
    expect(mapResponsesStatus({ status: 'cancelled' }, false).kind).toBe('error')
  })

  it('treats the usage shape as a documented provider contract', () => {
    // Like the completions route, the translator reads the documented usage
    // fields without defending against wrong-typed values; a provider that
    // lies about its shape fails downstream in accounting, not here.
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    })
  })
})
