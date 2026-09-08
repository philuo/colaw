/**
 * Unified PTY adapter: selects node-pty on Node.js, Bun.Terminal on Bun.
 *
 * node-pty fails to start PTY shells in Bun ("PTY shell exited during startup").
 * Bun.Terminal is a native Bun API that provides equivalent PTY functionality.
 *
 * @module dsh-subprocess-local/pty-adapter
 */

const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

// Static import of node-pty-adapter allows vitest's vi.mock('node-pty') to intercept.
// Under Bun, node-pty-adapter exports a stub (avoids native ABI mismatch).
import { nodePty } from './node-pty-adapter'

export interface IPtyForkOptions {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
  encoding?: string | null
}

export interface IDisposable {
  dispose(): void
}

export interface IPtyExitEvent {
  exitCode: number
  signal?: number
}

export interface IPty {
  pid: number
  onData(cb: (data: string) => void): IDisposable
  onExit(cb: (e: IPtyExitEvent) => void): IDisposable
  write(data: string): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
}

export interface IPtyModule {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty
}

let ptyModule: IPtyModule | null = null

export function getPtyModule(): IPtyModule {
  if (ptyModule) return ptyModule
  if (isBun) {
    // Bun: use Bun.Terminal adapter
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('./bun-pty-adapter') as IPtyModule
  } else {
    // Node.js: use node-pty (static import via node-pty-adapter for vitest mock compatibility)
    ptyModule = nodePty as unknown as IPtyModule
  }
  return ptyModule
}

export { IPtyForkOptions as IPtyForkOptionsType }
