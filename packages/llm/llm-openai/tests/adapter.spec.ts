import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ProviderRequestId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOpenAi from '@deepseek-ai/dsh-llm-openai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { OpenAIAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-openai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-openai-'))
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
  await ctx.plugin(LlmOpenAi, { baseURL, apiKeyEnv: 'OPENAI_API_KEY', ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmOpenAi.Config> & { apiKey?: string } = {}): OpenAIAdapter {
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
    await ctx.plugin(LlmOpenAi, { baseURL: server.url })
    const result = await assemble(ctx, { model: 'gpt-4o', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
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
    expect(() => resolveAdapterOptions({ models: [{ id: 'x' }, { id: 'x' }] })).toThrow(/duplicate catalog model/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: ['video' as never] }] })).toThrow(/only "text" and "image"/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'x', imageMaxBytes: 5 }] })).toThrow(/cannot declare image request limits/)
  })
})
