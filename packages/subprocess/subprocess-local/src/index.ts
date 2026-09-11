/**
 * Local Service Provider for the subprocess capability seam. Each spawn owns a
 * detached POSIX process group with the spec's per-stream stdio dispositions.
 * Normal disposal terminates and joins live ranges; Node's synchronous exit
 * phase force-stops any ranges the service still owns. It has no config: every
 * disposition and limit arrives on the spec, so deployment-varying choices
 * stay with the caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// Bun compatibility: the unified PTY adapter backs the PTY surface with Bun.Terminal.
import { getPtyModule } from './pty-adapter.ts'
import type { IPtyForkOptions } from './pty-adapter.ts'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { childEnv, spawnSubprocess, validateSubprocessSpec } from './spawn.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import { targetEnvironment } from './runner-launch.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/**
 * Local subprocess service: detached POSIX process groups, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and provider-owned range signalling.
 * Owners stage TERM before KILL. JavaScript-observable host exit also performs
 * synchronous final termination.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>()
  /** Test hook: process and spill operations forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        await this.disposeManagedProcesses()
        process.off('exit', onHostExit)
      }
    }, 'local subprocess teardown')
  }

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryRangeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Request termination, then await MANAGED-RANGE exit — not just the
    // direct command's settlement — so even a surviving descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Direct result and range observation are independent. Start both so an
      // unreadable owner cannot hide behind a result that never settles.
      pending.push(Promise.all([
        handle.done.catch(() => {}),
        handle.waitForExit(),
      ]).then(() => { this.live.delete(handle) }))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
    if (failures.length > 0) this.terminateForHostExit()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && command.includes('/')) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = env.PATH ?? ''
    return path.split(delimiter).map(directory => resolve(process.cwd(), directory, command))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    validateSubprocessSpec(spec)
    // Node-equivalent null-byte validation precedes every launch, fallback included.
    void targetEnvironment(spec)
    const handle = spawnSubprocess(spec, this.internals)
    this.live.add(handle)
    // Release ownership only once the whole managed range is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const env = targetEnvironment(spec)
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env,
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const terminal = getPtyModule().spawn(file, [...spec.argv.slice(1)], options)
    const handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs)
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

export default LocalSubprocessRuntime
