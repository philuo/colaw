/**
 * The lazily loaded native face the permission controller drives.
 *
 * `@trycua/cua-driver` ships platform binaries through optional dependencies,
 * and its permission probes execute in the importing process so the OS
 * attributes the request to the host application — Colaw itself. Loading this
 * module at boot would put the native binding on every boot path, so the
 * controller `require`s it on first probe instead.
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native/native-probe
 */

import type { MacOsPermissionStatus } from '@trycua/cua-driver'

/**
 * Read the host process's TCC state.
 * @returns the accessibility and screen-recording grant states.
 */
export function currentPermissionStatus(): MacOsPermissionStatus {
  // The generated SDK answers synchronously from the native binding.
  // oxlint-disable-next-line typescript/no-require-imports -- optional platform binaries; non-probe paths stay free of the binding.
  const sdk = require('@trycua/cua-driver') as typeof import('@trycua/cua-driver')
  return sdk.currentMacOsPermissionStatus()
}

/**
 * Deep-link macOS System Settings to the Screen Recording pane.
 */
export function openScreenRecordingSettings(): void {
  // oxlint-disable-next-line typescript/no-require-imports -- same optional-dependency load as `currentPermissionStatus()`.
  const sdk = require('@trycua/cua-driver') as typeof import('@trycua/cua-driver')
  sdk.openMacOsScreenRecordingSettings()
}
