import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../src/index.ts'
import {
  DEFAULT_AI_PERSONA, DEFAULT_USER_PERSONA, IDENTITY_SETTINGS_NAMESPACE, identitySectionText,
} from '../src/identity-settings.ts'

/** Mirrors the module-local namespace id in src/index.ts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-settings-general host', () => {
  it('registers and disposes the durable onboarding namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.settings.describe().map(row => row.ns)).toContain(
      ONBOARDING_SETTINGS_NAMESPACE,
    )
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(
      ONBOARDING_SETTINGS_NAMESPACE,
    )
  })

  it('publishes the identity preset as a live system-prompt section', async () => {
    // The guarantee the product makes: the 身份预设 text rides the assembled
    // system prompt on every request — the prompt is re-assembled per step and
    // rides the leading system message, which session compaction never rewrites
    // (compaction-basic excludes surface node 0 and re-normalizes it from the
    // fresh assembly afterwards). This spec pins the settings → section half:
    // a stored value reaches the assembly, and a later edit republishes it.
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment persona.' }).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()

    const mutate = (ai: string, user: string): Promise<unknown> => ctx.settings.mutate(
      IDENTITY_SETTINGS_NAMESPACE,
      [
        { op: 'set', path: ['aiPersona'], value: ai },
        { op: 'set', path: ['userPersona'], value: user },
      ],
      undefined,
    )

    await mutate('严谨、细心、程序员冲哥', '山东济南律师（琪琪）')
    const first = await ctx.systemPrompt.assemble()
    expect(first.sections.find(section => section.name === 'identity:preset')?.text).toBe(
      '## 身份预设\n- AI 助手人设：严谨、细心、程序员冲哥\n- 当前用户人设：山东济南律师（琪琪）',
    )

    // A later edit republishes the section — dispose-and-replace, never a
    // duplicate-name throw — so the next request speaks as the new identity.
    await mutate('谨慎的合同审查助手', '并购团队')
    const second = await ctx.systemPrompt.assemble()
    expect(second.sections.find(section => section.name === 'identity:preset')?.text).toBe(
      '## 身份预设\n- AI 助手人设：谨慎的合同审查助手\n- 当前用户人设：并购团队',
    )

    // Clearing both fields drops the section entirely (the off switch).
    await ctx.settings.mutate(
      IDENTITY_SETTINGS_NAMESPACE,
      [
        { op: 'set', path: ['aiPersona'], value: '' },
        { op: 'set', path: ['userPersona'], value: '' },
      ],
      undefined,
    )
    const cleared = await ctx.systemPrompt.assemble()
    expect(cleared.sections.some(section => section.name === 'identity:preset')).toBe(false)
    await fiber.dispose()
  })

  it('formats the identity section text and drops it when both personas are empty', () => {
    // An untouched install carries the product defaults, not an off state.
    expect(identitySectionText(undefined))
      .toBe(`## 身份预设\n- AI 助手人设：${DEFAULT_AI_PERSONA}\n- 当前用户人设：${DEFAULT_USER_PERSONA}`)
    expect(identitySectionText({ aiPersona: '', userPersona: '' })).toBe('')
    expect(identitySectionText({ aiPersona: 'A', userPersona: '' })).toBe('## 身份预设\n- AI 助手人设：A')
    expect(identitySectionText({ aiPersona: '', userPersona: 'U' })).toBe('## 身份预设\n- 当前用户人设：U')
  })
})
