/**
 * The DeepSeek Responses wire's documented constraints, pinned.
 *
 * Every case here corresponds to a line in the official compatibility matrix
 * (`api-docs.deepseek.com/zh-cn/guides/responses_api`), and to behaviour the
 * endpoint enforces in a way that does not announce itself: an unsupported
 * parameter is ignored, and a `developer` role is read as `user`. A test that
 * only checked "a request was produced" would pass with all of those wrong.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from '../src/protocols/openai-responses/serialize.ts'
import { parseSse } from '../src/protocols/openai-responses/sse.ts'
import { mapResponsesUsage, translateResponses } from '../src/protocols/openai-responses/translate.ts'

function request(overrides: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    messages: [],
    ...overrides,
  } as unknown as GenerateOptions
}

const user = (text: string): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } })

/** Drain the translator over a fixed event list. */
async function translate(payloads: unknown[]): Promise<{ chunks: { type: string }[]; error?: unknown }> {
  const chunks: { type: string }[] = []
  const source = async function* (): AsyncGenerator<string> {
    for (const payload of payloads) yield JSON.stringify(payload)
  }
  try {
    for await (const chunk of translateResponses(source())) chunks.push({ type: chunk.type })
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

describe('responses serialization', () => {
  it('carries the system prompt as instructions, never as a developer item', () => {
    // DeepSeek documents `developer` as equivalent to **user**, so that spelling
    // would deliver the instructions as user speech.
    const body = serializeRequest(request({ system: 'be brief', messages: [user('hi')] }), {})
    expect(body.instructions).toBe('be brief')
    expect(JSON.stringify(body)).not.toContain('developer')
  })

  it('keeps a text-only user message as a plain string', () => {
    const body = serializeRequest(request({ messages: [user('hi')] }), {})
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('sends no parameter the endpoint would silently ignore', () => {
    // These are documented as unsupported, and unsupported parameters are
    // ignored rather than rejected — so their presence would look harmless
    // while quietly not doing anything.
    const body = serializeRequest(request({ messages: [user('hi')] }), {})
    for (const ignored of [
      'store', 'previous_response_id', 'conversation', 'background', 'metadata',
      'prompt', 'include', 'truncation', 'service_tier', 'parallel_tool_calls',
      'max_tool_calls', 'context_management', 'prompt_cache_key', 'stream_options',
    ]) expect(body).not.toHaveProperty(ignored)
  })

  it('replays a tool call and its result as the wire items that pair by call_id', () => {
    const history: Message[] = [
      user('go'),
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{"path":"a"}' }],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('call_1'), content: [{ type: 'text', text: 'contents' }] }],
      } as Message,
    ]
    const body = serializeRequest(request({ messages: history }), {})
    expect(body.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' })
    expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'contents' })
  })

  it('sends reasoning effort only where the wire accepts it', () => {
    const body = serializeRequest(request({ reasoningEffort: 'high' }), {})
    expect(body.reasoning).toEqual({ effort: 'high' })
    // `off` omits the field: this wire documents no value that disables
    // thinking, and inventing one would be worse than not sending it.
    const off = serializeRequest(request({ reasoningEffort: 'off' }), {})
    expect(off.reasoning).toBeUndefined()
  })
})

describe('responses translation against a real captured stream', () => {
  // Captured from the product's own gateway (POST /v1/responses,
  // deepseek-v4-flash-0731, 2026-09-18): a real 20-event stream whose model
  // answer was "PONG". Synthetic events prove the shape we expect; this proves
  // the shape the endpoint actually sends — which is the only version that
  // matters, because unsupported parameters and unexpected event names do not
  // announce themselves.
  it('reproduces the answer from the wire, not from a mock', async () => {
    const raw = readFileSync(new URL('fixtures/responses-real-stream.txt', import.meta.url), 'utf8')
    const stream = new ReadableStream<string>({
      start(controller) { controller.enqueue(raw); controller.close() },
    })
    const chunks: string[] = []
    let text = ''
    for await (const chunk of translateResponses(parseSse(stream))) {
      if (chunk.type === 'text-delta') text += chunk.text
      chunks.push(chunk.type)
    }
    expect(chunks).toEqual([
      'block-start',
      ...Array.from({ length: 6 }, () => 'reasoning-delta'),
      'block-end',
      'block-start', 'text-delta', 'block-end',
      'usage', 'finish',
    ])
    expect(text).toBe('PONG')
  })
})

describe('responses translation', () => {
  it('refuses a stream that ended without its terminal event', async () => {
    // There is no `[DONE]` on this wire, so the terminal event is the only
    // proof the response finished; a socket that just closed is a truncation.
    const { error } = await translate([
      { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'partial' },
    ])
    expect(error).toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('emits the block, its text, usage and finish for a completed response', async () => {
    const { chunks } = await translate([
      { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hello' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 10, output_tokens: 5,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ])
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'block-end', 'usage', 'finish',
    ])
  })

  it('reads reasoning tokens from the field DeepSeek documents', () => {
    expect(mapResponsesUsage({
      input_tokens: 10, output_tokens: 5,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
    })).toMatchObject({ inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 2 })
  })

  it('maps an incomplete response to the output cap rather than a stop', async () => {
    const { chunks } = await translate([
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ])
    expect(chunks).toEqual([{ type: 'finish' }])
  })
})
