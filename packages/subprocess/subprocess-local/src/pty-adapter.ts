/**
 * Unified PTY adapter. Bun-only by fork policy: the terminal surface the
 * subprocess seam consumes is backed by Bun.Terminal + Bun.spawn (see
 * bun-pty-adapter.ts).
 *
 * @module dsh-subprocess-local/pty-adapter
 */

import * as bunPty from './bun-pty-adapter.ts'

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
  ptyModule = bunPty as unknown as IPtyModule
  return ptyModule
}

export { IPtyForkOptions as IPtyForkOptionsType }
