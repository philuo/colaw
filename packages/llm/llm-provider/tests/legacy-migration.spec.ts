import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmProvider from '@deepseek-ai/dsh-llm-provider'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

/**
 * The upgrade story for the two-package era: a user who declared routes under
 * the retired `llm-openai` / `llm-anthropic` settings sections boots the new
 * build, and those routes reappear — served by the dedicated adapter,
 * editable, and removable — while everything else stays untouched.
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

async function bootOpenAi(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmProvider, {})
  return ctx
}

describe('legacy era-section migration', () => {
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

})
