/**
 * The interpreter these suites run against.
 *
 * `PythonPtcRuntime` defaults `pythonBin` to the basename `python3` and resolves
 * it against `PATH`, then refuses anything older than CPython 3.10. On a host
 * whose `PATH` reaches a system 3.9 before a modern interpreter, that default
 * resolves to an interpreter the product is right to reject, and every real
 * subprocess case fails at load — a property of the host, not of the runtime.
 *
 * The suites below therefore state the premise the product documents
 * ("basename of a CPython 3.10+ interpreter") instead of inheriting whatever the
 * host's `PATH` happens to put first: they prepend a directory holding a
 * `python3` that satisfies it.
 * @module dsh-ptc-runtime-python/tests/support/interpreter
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** The minimum the product accepts. */
const MIN = { major: 3, minor: 10 } as const

/** Whether `bin` reports itself as CPython at or above {@link MIN}. */
function isSupported(bin: string): boolean {
  try {
    const output = execFileSync(bin, [
      '-I',
      '-c',
      'import sys; print(sys.implementation.name, sys.version_info.major, sys.version_info.minor)',
    ], { encoding: 'utf8', timeout: 10_000 }).trim()
    const match = /^(\S+) (\d+) (\d+)$/.exec(output)
    if (match === null || match[1] !== 'cpython') return false
    const major = Number(match[2])
    const minor = Number(match[3])
    return major > MIN.major || (major === MIN.major && minor >= MIN.minor)
  } catch {
    return false
  }
}

/**
 * Put a supported `python3` first on `PATH`.
 *
 * A candidate is taken from `PATH` itself when one is already supported; a
 * sibling name (`python3.13`, `python3.12`, …) is accepted as well, since a host
 * that ships both a system 3.9 and a modern build usually exposes the modern one
 * under a versioned name. The chosen executable is linked into a private
 * directory as `python3` and that directory is prepended to `PATH`.
 * @returns the absolute path now reachable as `python3`, or `undefined` when the
 *   host offers no supported interpreter (the caller then leaves `PATH` alone).
 */
export function preferSupportedPython(): string | undefined {
  const path = process.env.PATH ?? ''
  const candidates: string[] = []
  for (const dir of path.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue
    for (const name of ['python3', 'python3.13', 'python3.12', 'python3.11', 'python3.10']) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) candidates.push(candidate)
    }
  }
  const chosen = candidates.find(isSupported)
  if (chosen === undefined) return undefined

  const bin = join(tmpdir(), 'dsh-ptc-python')
  mkdirSync(bin, { recursive: true })
  const link = join(bin, 'python3')
  try {
    symlinkSync(chosen, link)
  } catch (error: unknown) {
    // A link from an earlier run in this process is fine; anything else means
    // the directory is unusable and PATH stays as the host set it.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
  }
  process.env.PATH = `${bin}${delimiter}${path}`
  return link
}
