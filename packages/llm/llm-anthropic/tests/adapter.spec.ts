import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmAnthropic from '@deepseek-ai/dsh-llm-anthropic'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AnthropicAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-anthropic'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textFrames } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-anthropic-'))
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
  await ctx.credentials.set(credentialRef('ANTHROPIC_API_KEY'), 'test-key')
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmAnthropic, {
    providers: { 'anthropic-compatible': { baseURL, apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-fable-5' }], ...(config as Record<string, never>) } },
  })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmAnthropic.ProviderProfile> & { apiKey?: string } = {}): AnthropicAdapter {
  const { apiKey, ...rest } = config
  return new AnthropicAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

describe('plugin composition', () => {
  it('registers the anthropic-compatible route and completes a text turn', async () => {
    const server = await mockServer([{ kind: 'sse', frames: textFrames }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-fable-5', messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  })
})

describe('request shape', () => {
  it('sends x-api-key, the API version, attribution, and the /v1/messages path', async () => {
    const server = await mockServer([{ kind: 'sse', frames: textFrames }])
    const adapter = adapterOf({ baseURL: server.url, models: [{ id: 'claude-fable-5' }] })
    for await (const chunk of adapter.stream({
      provider: 'anthropic-compatible',
      model: 'claude-fable-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    expect(server.requests[0]).toMatchObject({
      model: 'claude-fable-5',
      max_tokens: 128_000,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const headers = server.headers[0] as Record<string, string | string[] | undefined>
    expect(headers['x-api-key']).toBe('k')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(String(headers['user-agent'])).toMatch(/^colaw\//)
    expect(Object.keys(headers).filter(name => name.startsWith('x-deepseek'))).toEqual([])
  })

  it('carries the top-level system and the catalog cap', async () => {
    const server = await mockServer([{ kind: 'sse', frames: textFrames }])
    const ctx = await harness(server.url, { models: [{ id: 'claude-fable-5', maxTokens: 32_000 }] })
    const result = await assemble(ctx, {
      model: 'claude-fable-5',
      system: 'be brief',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[0]).toMatchObject({ max_tokens: 32_000, system: 'be brief' })
  })

  it('sends the thinking budget only for catalog models declared reasoning', async () => {
    const server = await mockServer([
      { kind: 'sse', frames: textFrames },
      { kind: 'sse', frames: textFrames },
    ])
    const adapter = adapterOf({
      baseURL: server.url,
      reasoningEffort: 'high',
      thinkingBudgetTokens: 8_192,
      models: [
        { id: 'claude-haiku' },
        { id: 'claude-fable-5', reasoning: true },
      ],
    })
    for await (const chunk of adapter.stream({
      provider: 'anthropic-compatible', model: 'claude-haiku',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'a' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    for await (const chunk of adapter.stream({
      provider: 'anthropic-compatible', model: 'claude-fable-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'b' }], source: { kind: 'plugin', plugin: 'test' } })],
    })) void chunk
    expect(server.requests[0]).not.toHaveProperty('thinking')
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 8_192 } })
  })
})

describe('failures', () => {
  // ctx.llm.stream() normalizes adapter throws into a terminal error finish.
  it.each([
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [529, 'SERVER'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const server = await mockServer([{
      kind: 'http-error',
      status,
      body: JSON.stringify({ type: 'error', error: { type: 't', message: `failed with ${status}` } }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-fable-5', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it('forwards a numeric retry-after and the provider request id on 429', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ type: 'error', error: { message: 'slow down' } }),
      headers: { 'retry-after': '7', 'request-id': 'req_123' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-fable-5', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 7_000,
        requestId: 'req_123',
      },
    })
  })

  it('classifies an abrupt body close as TRANSPORT', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      frames: [{ event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' }],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-fable-5', messages: [] })
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
    await ctx.plugin(LlmAnthropic, { providers: { 'anthropic-compatible': { baseURL: server.url } } })
    const result = await assemble(ctx, { model: 'claude-fable-5', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  })
})

describe('resolveAdapterOptions', () => {
  it('defaults to the public API base, the ANTHROPIC_API_KEY reference, and the catalog cap', () => {
    const options = resolveAdapterOptions({})
    expect(options.baseURL).toBe('https://api.anthropic.com')
    expect(options.apiKeyEnv).toBe(credentialRef('ANTHROPIC_API_KEY'))
    expect(options.models).toEqual([])
    expect(options.maxTokens).toBe(128_000)
  })

  it('rejects an offload quantum above its bound and a sub-1024 thinking budget', () => {
    expect(() => resolveAdapterOptions({
      maxRequestImageBytes: 1000,
      imageOffloadByteQuantum: 2000,
    })).toThrow(/imageOffloadByteQuantum must not exceed maxRequestImageBytes/)
    expect(() => resolveAdapterOptions({ thinkingBudgetTokens: 512 })).toThrow(/thinkingBudgetTokens/)
  })

  it('rejects duplicate catalog ids and non-image modalities', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'x' }, { id: 'x' }] })).toThrow(/duplicate model "x"/)
  })

  it('rejects an out-of-range stream idle timeout', () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/streamIdleTimeoutMs/)
  })
})
