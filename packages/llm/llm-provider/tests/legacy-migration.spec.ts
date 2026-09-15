import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmProvider from '@deepseek-ai/dsh-llm-provider'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

/**
 * The upgrade story, end to end over a real settings document: a user who
 * declared providers through the retired llm-pi-ai Models page boots the new
 * build, and the openai-protocol routes reappear — served by the dedicated
 * adapter, editable, and removable — while everything else stays untouched.
 */

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-provider-migration-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

/** Seed the stored settings document the way the retired build left it. */
function seed(yaml: string): void {
  writeFileSync(join(testHome, 'settings.yaml'), yaml)
}

const LEGACY_DOCUMENT = `llm-pi-ai:
  providers:
    zai-coding-cn:
      displayName: zai-coding-cn
      api: openai-completions
      baseURL: https://api.z.ai/api/coding/paas/v4
      apiKeyEnv: ZAI_CODING_CN_API_KEY
      models:
        - id: glm-4.6
          name: GLM-4.6
          contextWindow: 200000
          maxTokens: 128000
          input:
            - text
            - image
    claude-gateway:
      displayName: Claude Gateway
      api: anthropic-messages
      baseURL: https://gateway.example
      apiKeyEnv: CLAUDE_GATEWAY_API_KEY
      models:
        - id: claude-sonnet-4-5
          input:
            - text
    retired-google:
      api: google-generative-ai
      models:
        - id: gemini-pro
`

async function bootOpenAi(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmProvider, {})
  return ctx
}

describe('legacy llm-pi-ai migration', () => {
  it('folds openai-protocol routes into llm-openai and registers them live', async () => {
    seed(LEGACY_DOCUMENT)
    const ctx = await bootOpenAi()
    await vi.waitFor(() => {
      const providers = Object.keys((ctx.settings.rawSection('llm-provider')?.['providers'] ?? {}) as object)
      expect(providers).toEqual(['zai-coding-cn', 'claude-gateway'])
    })
    // Both migrated routes serve requests without a restart — each through
    // its own wire.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
      expect.arrayContaining(['zai-coding-cn', 'claude-gateway']),
    )
    // The stored profile is schema-shaped: pi-ai's `input` list arrived as
    // `inputModalities`, and each route names the protocol it will speak.
    const providers = ctx.settings.rawSection('llm-provider')?.['providers'] as Record<string, Record<string, unknown>>
    expect(providers['zai-coding-cn']).toEqual({
      displayName: 'zai-coding-cn',
      api: 'openai-completions',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      models: [{ id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 200000, maxTokens: 128000, inputModalities: ['text', 'image'] }],
    })
    expect(providers['claude-gateway']).toEqual({
      displayName: 'Claude Gateway',
      api: 'anthropic-messages',
      baseURL: 'https://gateway.example',
      apiKeyEnv: 'CLAUDE_GATEWAY_API_KEY',
      models: [{ id: 'claude-sonnet-4-5', inputModalities: ['text'] }],
    })
  })

  it('leaves the stored document otherwise untouched and the legacy section in place', async () => {
    seed(LEGACY_DOCUMENT)
    const ctx = await bootOpenAi()
    await vi.waitFor(() => {
      expect(ctx.settings.rawSection('llm-provider')).toBeDefined()
    })
    // The dropped google family stays retired: it lands nowhere.
    expect(Object.keys(ctx.settings.rawSection('llm-provider')?.['providers'] as object))
      .toEqual(['zai-coding-cn', 'claude-gateway'])
  })

  it('does not resurrect routes after the user deletes the migrated provider', async () => {
    seed(LEGACY_DOCUMENT)
    const first = await bootOpenAi()
    await vi.waitFor(() => {
      expect(first.settings.rawSection('llm-provider')).toBeDefined()
    })
    await first.settings.mutate('llm-provider', [
      { op: 'unset', path: ['providers', 'zai-coding-cn'] },
      { op: 'unset', path: ['providers', 'claude-gateway'] },
    ])
    expect(Object.keys(first.settings.rawSection('llm-provider')?.['providers'] as object)).toEqual([])

    // A second boot over the SAME document: the user layer exists, so the
    // migration is a no-op and the deletion sticks.
    const second = await bootOpenAi()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(Object.keys(second.settings.rawSection('llm-provider')?.['providers'] as object)).toEqual([])
    expect(second.llm.listProviders().map(provider => provider.id)).not.toContain('zai-coding-cn')
    expect(second.llm.listProviders().map(provider => provider.id)).not.toContain('claude-gateway')
  })

  it('folds a stored two-package-era llm-anthropic section into this namespace and empties it', async () => {
    seed(`llm-anthropic:
  providers:
    claude-relay:
      displayName: Claude Relay
      baseURL: https://relay.example
      apiKeyEnv: CLAUDE_RELAY_API_KEY
      models:
        - id: claude-sonnet-4-5
          input:
            - text
            - image
`)
    const ctx = await bootOpenAi()
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('claude-relay')
    })
    const providers = ctx.settings.rawSection('llm-provider')?.['providers'] as Record<string, Record<string, unknown>>
    expect(providers['claude-relay']).toEqual({
      displayName: 'Claude Relay',
      api: 'anthropic-messages',
      baseURL: 'https://relay.example',
      apiKeyEnv: 'CLAUDE_RELAY_API_KEY',
      models: [{ id: 'claude-sonnet-4-5', inputModalities: ['text', 'image'] }],
    })
    // The source section is emptied, so deleting the folded route sticks.
    expect(ctx.settings.rawSection('llm-anthropic')).toEqual({})
  })

  it('keeps a conflicting route as-is instead of overwriting it from the retired section', async () => {
    seed(`llm-openai:
  providers:
    claude-relay:
      api: openai-completions
      baseURL: https://mine.example/v1
      models:
        - id: m
llm-anthropic:
  providers:
    claude-relay:
      api: anthropic-messages
      baseURL: https://theirs.example
      models:
        - id: m
`)
    const ctx = await bootOpenAi()
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const providers = ctx.settings.rawSection('llm-provider')?.['providers'] as Record<string, Record<string, unknown>>
    expect(providers['claude-relay']).toMatchObject({ api: 'openai-completions', baseURL: 'https://mine.example/v1' })
    // The retired section is left untouched for the conflict to stay visible.
    expect(ctx.settings.rawSection('llm-anthropic')?.['providers']).toHaveProperty('claude-relay')
  })

  it('folds a pi-ai route and a pre-rename llm-openai route in one boot', async () => {
    seed(`llm-pi-ai:
  providers:
    old-route:
      api: openai-completions
      models:
        - id: m
llm-openai:
  providers:
    fresh-route:
      api: openai-responses
      baseURL: https://fresh.example/v1
      models:
        - id: gpt-5-turbo
`)
    const ctx = await bootOpenAi()
    await new Promise(resolve => setTimeout(resolve, 50))
    // The chain: the pi-ai import lands old-route first (the target starts
    // empty), then the llm-openai fold moves fresh-route beside it.
    expect(Object.keys(ctx.settings.rawSection('llm-provider')?.['providers'] as object))
      .toEqual(['old-route', 'fresh-route'])
    expect(ctx.llm.listProviders().map(provider => provider.id))
      .toEqual(expect.arrayContaining(['fresh-route', 'old-route']))
    // The retired llm-openai section was emptied by its fold.
    expect(ctx.settings.rawSection('llm-openai')).toEqual({})
  })
})
