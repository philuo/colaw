/**
 * Spawn-environment materialization for local subprocesses: the Node-equivalent
 * validation of argv, cwd, and environment overrides, shared by every spawn
 * path. The Windows/Linux runner machinery this module once also carried is
 * gone — this fork targets macOS arm64 only.
 * @module dsh-subprocess-local/runner-launch
 */

import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from './spawn.ts'

function throwNullByteError(property: string, value: string, argument: boolean): never {
  const subject = argument ? `The argument '${property}'` : `The property '${property}'`
  const error = new TypeError(`${subject} must be a string without null bytes. Received ${inspect(value)}`)
  Object.assign(error, { code: 'ERR_INVALID_ARG_VALUE' })
  throw error
}

function validateNoNullByte(property: string, value: string, argument = false): void {
  if (value.includes('\0')) throwNullByteError(property, value, argument)
}

/**
 * Materialize and synchronously validate the final target environment.
 * @param spec - final target argv, cwd, and environment overrides.
 * @returns complete target environment after Node-equivalent validation.
 */
export function targetEnvironment(
  spec: Pick<SubprocessSpawnSpec, 'argv' | 'cwd' | 'env'>,
): Record<string, string> {
  spec.argv.forEach((value, index) => {
    validateNoNullByte(index === 0 ? 'file' : `args[${String(index - 1)}]`, value, true)
  })
  validateNoNullByte('options.cwd', spec.cwd)
  const env = Object.fromEntries(
    Object.entries(childEnv(spec.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const [key, value] of Object.entries(env)) {
    validateNoNullByte(`options.env['${key}']`, key)
    validateNoNullByte(`options.env['${key}']`, value)
  }
  return env
}

function inspect(value: string): string {
  return `'${value.replaceAll("'", "\\'")}'`
}
