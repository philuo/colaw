/**
 * The desktop-control settings namespace shared between the Host schema and
 * the browser scope.
 *
 * Three switches gate which desktop-facing surfaces Colaw may use: operating
 * the machine's applications (Cua Driver), driving a browser over CDP
 * (chrome-devtools-mcp), and continuing to run while the Mac is locked. Each
 * is an independent preference with a schema default of `false`: enabling any
 * of them is an explicit user choice, made in the 电脑操控 settings tab.
 *
 * Turning a switch off hides the corresponding surface from new sessions; it
 * does not revoke any macOS permission the user has already granted — a
 * TCC grant belongs to the user and the system, not to this preference.
 * @module dsh-client-ui-settings-desktop/desktop-settings
 */

import z from '@deepseek-ai/schemastery'

/** Durable settings namespace for the desktop-control switches. */
export const DESKTOP_SETTINGS_NAMESPACE = 'ui-desktop-control'

/** Field carrying the browser-over-CDP switch. */
export const DESKTOP_FIELD_BROWSER_USE = 'browserUse'

/** Field carrying the computer-use (desktop applications) switch. */
export const DESKTOP_FIELD_COMPUTER_USE = 'computerUse'

/** Field carrying the locked-Mac operation switch. */
export const DESKTOP_FIELD_LOCK_SCREEN = 'lockScreenOperation'

/** The persisted desktop-control section; every field defaults to off. */
export interface DesktopSettings {
  /** Allow Colaw to drive a browser through CDP (chrome-devtools-mcp). */
  browserUse?: boolean
  /** Allow Colaw to operate the machine's applications (Cua Driver). */
  computerUse?: boolean
  /** Allow Colaw to keep operating while the Mac is locked. */
  lockScreenOperation?: boolean
}

/** Durable desktop-control schema; also the wire envelope the browser scope validates against. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  browserUse: z.boolean().default(false),
  computerUse: z.boolean().default(false),
  lockScreenOperation: z.boolean().default(false),
})
