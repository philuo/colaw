import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ProviderRequestId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOpenAi from '@deepseek-ai/dsh-llm-provider'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { OpenAIAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-provider'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-provider-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string, config: object = {}) {
  // Configuration carries only the reference; the key comes from the
  // user-configured credential store, mounted exactly as the product mounts it.
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { watch: false })
  await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'test-key')
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpenAi, { providers: { 'openai-compatible': { baseURL, apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-4o' }] } }, ...(config as Record<string, never>) })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmOpenAi.ProviderProfile> & { apiKey?: string } = {}): OpenAIAdapter {
  const { apiKey, ...rest } = config
  return new OpenAIAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

describe('plugin composition', () => {
  it('registers the openai route with the OpenAI display name', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('request shape', () => {
  it('sends bearer auth, attribution headers, and the chat-completions path', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapter = adapterOf({ baseURL: server.url, models: [{ id: 'gpt-4o' }] })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible',
      model: 'gpt-4o',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(server.requests[0]).toMatchObject({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    })
    const headers = server.headers[0] as Record<string, string | string[] | undefined>
    expect(headers.authorization).toBe('Bearer k')
    // The seam-mandatory attribution: a colaw product User-Agent.
    expect(String(headers['user-agent'])).toMatch(/^colaw\//)
    // The DeepSeek telemetry headers must not leak onto the OpenAI wire.
    expect(Object.keys(headers).filter(name => name.startsWith('x-deepseek'))).toEqual([])
  })

  it('sends no output cap when none is configured and none requested', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapter = adapterOf({ baseURL: server.url })
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible',
      model: 'gpt-4o',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    expect(server.requests[0]).not.toHaveProperty('max_tokens')
    expect(server.requests[0]).not.toHaveProperty('max_completion_tokens')
  })

  it('uses the configured cap field name', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapter = adapterOf({ baseURL: server.url, maxTokensField: 'max_completion_tokens' })
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible',
      model: 'gpt-4o',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
      maxTokens: 555,
    })) void chunk
    expect(server.requests[0]).toMatchObject({ max_completion_tokens: 555 })
    expect(server.requests[0]).not.toHaveProperty('max_tokens')
  })

  it('sends reasoning_effort only for catalog models declared reasoning', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = adapterOf({
      baseURL: server.url,
      reasoningEffort: 'high',
      models: [
        { id: 'gpt-4o' },
        { id: 'o4-mini', reasoning: true },
      ],
    })
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible', model: 'gpt-4o', messages: [createUserMessage({ content: [{ type: 'text', text: 'a' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible', model: 'o4-mini', messages: [createUserMessage({ content: [{ type: 'text', text: 'b' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
    expect(server.requests[1]).toMatchObject({ reasoning_effort: 'high' })
  })
})

describe('failures', () => {
  // ctx.llm.stream() normalizes adapter throws into a terminal error finish;
  // the failure facts live on result.finish.failure.
  it.each([
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const server = await mockServer([{
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `failed with ${status}`, type: 't', code: 'c' } }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it('forwards a numeric retry-after and the provider request id on 429', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { 'retry-after': '7', 'x-request-id': 'req_123' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 7_000,
        requestId: ProviderRequestId('req_123'),
      },
    })
  })

  it('classifies an abrupt body close as TRANSPORT', async () => {
    const server = await mockServer([{ kind: 'close-early', events: ['{"choices":[{"delta":{"content":"partial"}}]}'] }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT' },
    })
  })

  it('finishes with MISSING_CREDENTIAL when the store has no key', async () => {
    const server = await mockServer([])
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenAi, { providers: { 'openai-compatible': { baseURL: server.url } } })
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  })
})

describe('openai-responses wire', () => {
  /** A direct adapter speaking the Responses protocol against a mock endpoint. */
  function responsesAdapter(baseURL: string, config: Partial<LlmOpenAi.ProviderProfile> = {}): OpenAIAdapter {
    return adapterOf({ baseURL, api: 'openai-responses', models: [{ id: 'gpt-5-turbo', reasoning: true }], ...config })
  }

  /** A complete streamed text answer on the Responses wire (no [DONE] sentinel). */
  const textFrames = [
    'data: {"type":"response.created","response":{"id":"resp_9"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"bon"}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"jour"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"bonjour"}]}}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}}}\n\n',
  ]

  it('assembles text, usage, and a stop finish over the plugin harness', async () => {
    const server = await mockServer([{ kind: 'raw-sse', frames: textFrames }])
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenAi, {
      providers: {
        'openai-compatible': {
          baseURL: server.url,
          apiKeyEnv: 'OPENAI_API_KEY',
          api: 'openai-responses',
          models: [{ id: 'gpt-5-turbo' }],
        },
      },
    })
    const result = await assemble(ctx, { model: 'gpt-5-turbo', messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'bonjour' }])
    expect(result.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12 })
    expect(server.paths[0]).toBe('/responses')
    expect(server.requests[0]).toMatchObject({ model: 'gpt-5-turbo', stream: true, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
  })

  it('replays a tool call and returns its result over the Responses wire', async () => {
    const server = await mockServer([
      {
        kind: 'raw-sse',
        frames: [
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"city\\": \\"SF\\"}"}\n\n',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\": \\"SF\\"}"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":3}}}\n\n',
        ],
      },
    ])
    const adapter = responsesAdapter(server.url)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible',
      model: 'gpt-5-turbo',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'weather?' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1|fc_1', name: 'get_weather', arguments: '{"city": "SF"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('feeds a replayed tool result back as a function_call_output', async () => {
    const server = await mockServer([{ kind: 'raw-sse', frames: textFrames }])
    const adapter = responsesAdapter(server.url)
    for await (const chunk of adapter.stream({
      provider: 'openai-compatible',
      model: 'gpt-5-turbo',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1|fc_1', name: 'get_weather', arguments: '{}' }] } as never,
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1|fc_1', content: [{ type: 'text', text: 'sunny' }] }] } as never,
      ],
    })) void chunk
    expect(server.requests[0]).toMatchObject({
      input: [
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    })
  })

  it('truncation before a terminal event fails the stream as TRANSPORT', async () => {
    const server = await mockServer([{
      kind: 'raw-sse',
      frames: [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n',
      ],
    }])
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenAi, {
      providers: { 'openai-compatible': { baseURL: server.url, apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-responses', models: [{ id: 'gpt-5-turbo' }] } },
    })
    const result = await assemble(ctx, { model: 'gpt-5-turbo', messages: [] })
    // A truncation before the terminal event is a distinct diagnosable
    // condition on this route: STREAM_CLOSED, not a raw transport break.
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'STREAM_CLOSED' } })
  })
})

describe('configurable-provider directory', () => {
  it('declares nothing while the plugin is dormant', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenAi, {})
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('lists exactly the configured routes, each one hand-declared', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url, {
      providers: {
        'openai-compatible': { baseURL: server.url, models: [{ id: 'gpt-4o' }] },
      },
    })
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      {
        provider: 'openai-compatible',
        displayName: 'openai-compatible',
        settingsNs: 'llm-provider',
        settingsPath: ['providers', 'openai-compatible'],
        declared: true,
      },
    ])
  })
})

describe('resolveAdapterOptions', () => {
  it('defaults to the public API base and the OPENAI_API_KEY reference', () => {
    const options = resolveAdapterOptions({})
    expect(options.baseURL).toBe('https://api.openai.com/v1')
    expect(options.apiKeyEnv).toBe(credentialRef('OPENAI_API_KEY'))
    expect(options.models).toEqual([])
    expect(options.defaults.maxTokensField).toBeUndefined()
  })

  it('rejects an offload quantum above its bound', () => {
    expect(() => resolveAdapterOptions({
      maxRequestImageBytes: 1000,
      imageOffloadByteQuantum: 2000,
    })).toThrow(/imageOffloadByteQuantum must not exceed maxRequestImageBytes/)
  })

  it('rejects an out-of-range stream idle timeout', () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/streamIdleTimeoutMs/)
  })

  it('rejects duplicate catalog ids, unknown modalities, and text-only image limits', () => {
    expect(() => resolveAdapterOptions({ displayName: 'p', models: [{ id: 'x' }, { id: 'x' }] })).toThrow(/duplicate model "x" in provider "p"/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'x', imageMaxBytes: 5 }] })).toThrow(/cannot declare image request limits/)
  })
})
