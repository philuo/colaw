/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  IDENTITY_SECTION, IDENTITY_SECTION_ORDER, IDENTITY_SETTINGS_NAMESPACE,
  IdentitySettingsSchema, identitySectionText,
} from './identity-settings.ts'

/** Durable settings namespace for product-wide GUI onboarding facts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

interface OnboardingSettings {
  /** Last version acknowledged by the current product welcome step. */
  welcomeNoticeVersion?: string
}

const OnboardingSettingsSchema: z<OnboardingSettings> = z.object({
  welcomeNoticeVersion: z.string(),
})

/**
 * Register the durable sections this package owns: the GUI-onboarding facts,
 * and the 身份预设 namespace whose value publishes a system-prompt section
 * that follows every edit live (dispose-and-republish keeps the section
 * registry free of duplicate-name throws).
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      ONBOARDING_SETTINGS_NAMESPACE,
      OnboardingSettingsSchema,
    )
  })
  ctx.inject(['settings', 'systemPrompt'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(IDENTITY_SETTINGS_NAMESPACE, IdentitySettingsSchema)
    let disposeSection: (() => void) | undefined
    const publish = (): void => {
      disposeSection?.()
      disposeSection = undefined
      const text = identitySectionText(scope.get())
      if (text.length > 0) {
        disposeSection = settingsCtx.systemPrompt.section({
          name: IDENTITY_SECTION,
          order: IDENTITY_SECTION_ORDER,
          text,
        })
      }
    }
    publish()
    scope.watch(() => { publish() })
    ctx.effect(() => () => {
      disposeSection?.()
      disposeSection = undefined
    })
  })
}
