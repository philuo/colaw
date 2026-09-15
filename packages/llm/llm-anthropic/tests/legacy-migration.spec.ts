import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmAnthropic from '@deepseek-ai/dsh-llm-anthropic'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

/**
 * The Messages-protocol half of the llm-pi-ai upgrade import: stored profiles
 * that spoke `anthropic-messages` fold into `llm-anthropic` and register live,
 * while openai-protocol and dropped-family routes stay out.
 */

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-anthropic-migration-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

const LEGACY_DOCUMENT = `llm-pi-ai:
  providers:
    claude-gateway:
      displayName: Claude Gateway
      api: anthropic-messages
      baseURL: https://gateway.example
      apiKeyEnv: CLAUDE_GATEWAY_API_KEY
      models:
        - id: claude-sonnet-4-5
          name: Claude Sonnet 4.5
          input:
            - text
            - image
    zai-coding-cn:
      api: openai-completions
      baseURL: https://api.z.ai/api/coding/paas/v4
      models:
        - id: glm-4.6
`

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmAnthropic, {})
  return ctx
}

describe('legacy llm-pi-ai migration (anthropic)', () => {
  it('folds anthropic-messages routes into llm-anthropic and registers them live', async () => {
    writeFileSync(join(testHome, 'settings.yaml'), LEGACY_DOCUMENT)
    const ctx = await boot()
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('claude-gateway')
    })
    const providers = ctx.settings.rawSection('llm-anthropic')?.['providers'] as Record<string, Record<string, unknown>>
    expect(providers['claude-gateway']).toEqual({
      displayName: 'Claude Gateway',
      baseURL: 'https://gateway.example',
      apiKeyEnv: 'CLAUDE_GATEWAY_API_KEY',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', inputModalities: ['text', 'image'] }],
    })
    // The Messages protocol is this adapter's only wire, so no `api` field
    // lands in the converted profile.
    expect(providers['claude-gateway']).not.toHaveProperty('api')
  })

  it('offers the anthropic catalog route while dormant', async () => {
    const ctx = await boot()
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      {
        provider: 'anthropic',
        displayName: 'Anthropic',
        settingsNs: 'llm-anthropic',
        settingsPath: ['providers', 'anthropic'],
        declared: false,
      },
    ])
  })
})
