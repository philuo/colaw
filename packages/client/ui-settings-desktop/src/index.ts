/**
 * Host registration for the desktop-control switches: one durable settings
 * namespace the browser tab edits and the desktop-facing providers read.
 * @module @deepseek-ai/dsh-client-ui-settings-desktop
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { DESKTOP_SETTINGS_NAMESPACE, DesktopSettingsSchema } from './desktop-settings.ts'

export {
  DESKTOP_FIELD_BROWSER_USE, DESKTOP_FIELD_COMPUTER_USE, DESKTOP_FIELD_LOCK_SCREEN,
  DESKTOP_SETTINGS_NAMESPACE, DesktopSettingsSchema,
  type DesktopSettings,
} from './desktop-settings.ts'

/**
 * Register the durable desktop-control section.
 * @param ctx - Host context that acquires the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(DESKTOP_SETTINGS_NAMESPACE, DesktopSettingsSchema)
  })
}
