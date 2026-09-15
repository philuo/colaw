import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmOpenAi from '@deepseek-ai/dsh-llm-openai'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

/**
 * The upgrade story, end to end over a real settings document: a user who
 * declared providers through the retired llm-pi-ai Models page boots the new
 * build, and the openai-protocol routes reappear — served by the dedicated
 * adapter, editable, and removable — while everything else stays untouched.
 */

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-openai-migration-'))
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
  await ctx.plugin(LlmOpenAi, {})
  return ctx
}

describe('legacy llm-pi-ai migration', () => {
  it('folds openai-protocol routes into llm-openai and registers them live', async () => {
    seed(LEGACY_DOCUMENT)
    const ctx = await bootOpenAi()
    await vi.waitFor(() => {
      const providers = Object.keys((ctx.settings.rawSection('llm-openai')?.['providers'] ?? {}) as object)
      expect(providers).toEqual(['zai-coding-cn'])
    })
    // The migrated route serves requests without a restart.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('zai-coding-cn')
    // The stored profile is schema-shaped: pi-ai's `input` list arrived as
    // `inputModalities`, and the route names the protocol it will speak.
    const providers = ctx.settings.rawSection('llm-openai')?.['providers'] as Record<string, Record<string, unknown>>
    expect(providers['zai-coding-cn']).toEqual({
      displayName: 'zai-coding-cn',
      api: 'openai-completions',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      models: [{ id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 200000, maxTokens: 128000, inputModalities: ['text', 'image'] }],
    })
  })

  it('leaves the stored document otherwise untouched and the legacy section in place', async () => {
    seed(LEGACY_DOCUMENT)
    const ctx = await bootOpenAi()
    await vi.waitFor(() => {
      expect(ctx.settings.rawSection('llm-openai')).toBeDefined()
    })
    // The anthropic-protocol route belongs to the llm-anthropic adapter, and
    // the dropped google family stays retired: neither lands here.
    expect(Object.keys(ctx.settings.rawSection('llm-openai')?.['providers'] as object)).toEqual(['zai-coding-cn'])
  })

  it('does not resurrect routes after the user deletes the migrated provider', async () => {
    seed(LEGACY_DOCUMENT)
    const first = await bootOpenAi()
    await vi.waitFor(() => {
      expect(first.settings.rawSection('llm-openai')).toBeDefined()
    })
    await first.settings.mutate('llm-openai', [{ op: 'unset', path: ['providers', 'zai-coding-cn'] }])
    expect(Object.keys(first.settings.rawSection('llm-openai')?.['providers'] as object)).toEqual([])

    // A second boot over the SAME document: the user layer exists, so the
    // migration is a no-op and the deletion sticks.
    const second = await bootOpenAi()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(Object.keys(second.settings.rawSection('llm-openai')?.['providers'] as object)).toEqual([])
    expect(second.llm.listProviders().map(provider => provider.id)).not.toContain('zai-coding-cn')
  })

  it('skips the import for a document a newer build already wrote', async () => {
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
    expect(Object.keys(ctx.settings.rawSection('llm-openai')?.['providers'] as object)).toEqual(['fresh-route'])
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('fresh-route')
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('old-route')
  })
})
