import { describe, expect, it } from 'vitest'
import { mapStopReason, mapUsage, translate } from '../src/anthropic-translate.ts'

async function* frames(list: ReadonlyArray<{ event: string; data: string }>): AsyncGenerator<{ event: string; data: string }> {
  for (const frame of list) yield frame
}

describe('mapStopReason', () => {
  it('maps the Anthropic vocabulary', () => {
    expect(mapStopReason('end_turn')).toEqual({ kind: 'stop' })
    expect(mapStopReason('stop_sequence')).toEqual({ kind: 'stop' })
    expect(mapStopReason('pause_turn')).toEqual({ kind: 'stop' })
    expect(mapStopReason('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(mapStopReason('tool_use')).toEqual({ kind: 'tool-calls' })
    expect(mapStopReason('refusal')).toEqual({
      kind: 'error',
      failure: { message: 'The model refused to complete the request', code: 'REFUSAL' },
    })
    expect(mapStopReason('model_overloaded')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: model_overloaded', code: 'MODEL_OVERLOADED' },
    })
  })
})

describe('mapUsage', () => {
  it('keeps cache fields disjoint and folds cache-write into the true total', () => {
    expect(mapUsage({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 5,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 25,
      cacheReadTokens: 6,
    })
  })
})

describe('translate', () => {
  const f = (event: string, data: string) => ({ event, data })

  it('streams text deltas and defers block-end, usage, and finish to message_stop', async () => {
    const chunks = []
    for await (const chunk of translate(frames([
      f('message_start', '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}'),
      f('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}'),
      f('content_block_stop', '{"type":"content_block_stop","index":0}'),
      f('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}'),
      f('message_stop', '{"type":"message_stop"}'),
    ]))) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    const usage = chunks.find(chunk => chunk.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
    // message_start carries the input side; message_delta refreshes output only.
    expect(usage.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    const end = chunks.find(chunk => chunk.type === 'block-end') as { block: { text: string } }
    expect(end.block.text).toBe('hello')
  })

  it('assembles tool_use blocks from input_json_delta fragments', async () => {
    const chunks = []
    for await (const chunk of translate(frames([
      f('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}'),
      f('content_block_stop', '{"type":"content_block_stop","index":0}'),
      f('message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}'),
      f('message_stop', '{"type":"message_stop"}'),
    ]))) chunks.push(chunk)
    const end = chunks.find(chunk => chunk.type === 'block-end') as { block: { type: string; id: string; name: string; arguments: string } }
    expect(end.block).toEqual({ type: 'tool-call', id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}' })
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
  })

  it('translates thinking deltas into reasoning blocks and drops signature deltas', async () => {
    const chunks = []
    for await (const chunk of translate(frames([
      f('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig=="}}'),
      f('content_block_stop', '{"type":"content_block_stop","index":0}'),
      f('content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}'),
      f('content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}'),
      f('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'),
      f('message_stop', '{"type":"message_stop"}'),
    ]))) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'finish',
    ])
    const reasoning = chunks.find(chunk => chunk.type === 'reasoning-delta') as { text: string }
    expect(reasoning.text).toBe('pondering')
  })

  it('maps redacted thinking to a reasoning block with a marker', async () => {
    const chunks = []
    for await (const chunk of translate(frames([
      f('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}'),
      f('content_block_stop', '{"type":"content_block_stop","index":0}'),
      f('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'),
      f('message_stop', '{"type":"message_stop"}'),
    ]))) chunks.push(chunk)
    const end = chunks.find(chunk => chunk.type === 'block-end') as { block: { type: string; text: string } }
    expect(end.block).toEqual({ type: 'reasoning', text: '[Reasoning redacted]' })
  })

  it('surfaces an error event as a SERVER LlmError', async () => {
    await expect(async () => {
      for await (const chunk of translate(frames([
        f('error', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      ]))) void chunk
    }).rejects.toMatchObject({ code: 'SERVER', message: 'Overloaded' })
  })

  it('throws MALFORMED_RESPONSE when event and frame type diverge', async () => {
    await expect(async () => {
      for await (const chunk of translate(frames([
        f('content_block_delta', '{"type":"message_stop"}'),
      ]))) void chunk
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throws STREAM_CLOSED when the frame stream ends without message_stop', async () => {
    await expect(async () => {
      for await (const chunk of translate(frames([
        f('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
      ]))) void chunk
    }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
