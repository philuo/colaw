/** Messages request contributions settle with the HTTP request that carries them. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekLlmApiExtensionRequest } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as DeepSeek from '../../src/index.ts'
import { MESSAGES_BASE_URL } from '../../src/config.ts'
import { assemble, options, sse, textEvents } from './helpers.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_messages_test: { value: string }
  }
}

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-extensions-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  // The managed store is the sole credential source: the launching
  // environment is deliberately not consulted, so a key must be written
  // through the seam rather than exported.
  await ctx.plugin(LocalCredentialProvider, { watch: false })
  await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'test-key')
  // Two facts decide this composition, both read from the product:
  // the provider contributes vendor-private fields only on DeepSeek's own
  // endpoint (isOfficialEndpoint), and its default protocol is
  // `openai-completions`. A Messages suite therefore selects the official
  // Messages root *and* the Messages protocol; the transport is stubbed, so no
  // request leaves the process.
  await ctx.plugin(DeepSeek, { protocol: 'anthropic-messages', baseURL: MESSAGES_BASE_URL })
  return ctx
}

/**
 * Build the stubbed reply the product's Messages path consumes.
 *
 * The adapter frames SSE over Bun 1.4's native `response.textStream()`, which
 * a plain `new Response(...)` does not carry, so the stub attaches one that
 * yields the whole fixture as a single decoded chunk.
 * @param text - the SSE fixture.
 * @returns a Response the Messages adapter can read.
 */
function sseResponse(text: string): Response {
  const response = new Response(text)
  Object.defineProperty(response, 'textStream', {
    value: () => new ReadableStream<string>({
      start(controller) { controller.enqueue(text); controller.close() },
    }),
  })
  return response
}

describe('Messages request extensions', () => {
  it('prepares the native body and accepts its contribution before yielding content', async () => {
    const ctx = await boot()
    let request: DeepSeekLlmApiExtensionRequest | undefined
    const accepted = vi.fn()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', {
      prepare: (value) => {
        request = value
        return { value: { value: 'inventory' }, accept: accepted }
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      expect(accepted).not.toHaveBeenCalled()
      return Promise.resolve(sseResponse(sse(textEvents)))
    })
    vi.stubGlobal('fetch', fetch)
    const stream = ctx.llm.stream(options({ sessionId: SessionId('session-parity'), purpose: 'compaction' }))
    for await (const chunk of stream) {
      expect(accepted).toHaveBeenCalledOnce()
      if (chunk.type === 'finish') expect(chunk.reason.kind).toBe('stop')
    }
    expect(request).toMatchObject({
      sessionId: 'session-parity', purpose: 'compaction',
      // The Messages endpoint rejects `thinking.type: 'enabled'` outright, so a
      // reasoning route names its depth through output_config.effort alone.
      body: { output_config: { effort: 'high' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    })
    expect(request?.body).not.toHaveProperty('dsh_messages_test')
    expect(fetch.mock.calls[0]?.[0]).toBe(`${MESSAGES_BASE_URL}/v1/messages`)
    const body = fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Expected a serialized Messages request')
    expect(JSON.parse(body)).toMatchObject({ dsh_messages_test: { value: 'inventory' } })
  })

  it('rejects preparation before dispatch', async () => {
    const ctx = await boot()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', { prepare() { throw new Error('inventory unavailable') } })
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'REQUEST_EXTENSION' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['http', 'transport', 'stream'] as const)('records acceptance only for HTTP success despite a later %s failure', async (failure) => {
    const ctx = await boot()
    const accept = vi.fn()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', { prepare: () => ({ value: { value: 'log' }, accept }) })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      if (failure === 'transport') return Promise.reject(new Error('connection lost'))
      if (failure === 'http') return Promise.resolve(Response.json({ error: { message: 'rejected' } }, { status: 400 }))
      return Promise.resolve(sseResponse(''))
    }))
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish.kind).toBe('error')
    expect(accept).toHaveBeenCalledTimes(failure === 'stream' ? 1 : 0)
  })

  it('retains the extension error category when acceptance fails', async () => {
    const ctx = await boot()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', {
      prepare: () => ({ value: { value: 'log' }, accept() { throw new Error('watermark storage failed') } }),
    })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(sseResponse(sse(textEvents))))
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'REQUEST_EXTENSION' } })
    expect(result.message.content).toEqual([])
  })
})
