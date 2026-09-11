/** macOS native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

/**
 * Open the macOS directory picker (`osascript choose folder`).
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform !== 'darwin') {
    throw new Error(`native directory picker is unsupported on ${platform}`)
  }
  try {
    const result = await run('osascript', [
      '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
      '-e', 'POSIX path of selectedFolder',
    ], signal)
    return outputPath(result.stdout)
  } catch (error: unknown) {
    if (!signal.aborted && errorCode(error) === 1
      && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
    throw error
  }
}
