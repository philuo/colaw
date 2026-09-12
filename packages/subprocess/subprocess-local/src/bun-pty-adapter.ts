/**
 * PTY adapter over Bun's native `Bun.Terminal` + `Bun.spawn({ terminal })`.
 * Implements the IPty surface the subprocess seam consumes:
 * pid, onData, onExit, write, kill, resize.
 *
 * @module dsh-subprocess-local/bun-pty-adapter
 */

// Bun global type declarations (avoid @types/bun dependency)
declare const Bun: {
  Terminal: new (options: {
    cols?: number
    rows?: number
    data?: (term: unknown, data: Uint8Array) => void
  }) => {
    write(data: string): void
    close(): void
    resize(cols: number, rows: number): void
  }
  spawn: (
    command: string[],
    options: {
      terminal?: unknown
      cwd?: string | undefined
      env?: Record<string, string>
      stdin?: string
      stdout?: string
      stderr?: string
    },
  ) => {
    pid: number
    kill(signal?: string): void
    exited: Promise<number>
  }
}

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
  signal?: number | undefined
}

export interface IPty {
  readonly pid: number
  readonly process: string
  onData(cb: (data: string) => void): IDisposable
  onExit(cb: (e: IPtyExitEvent) => void): IDisposable
  write(data: string): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
}

/**
 * Spawn a PTY process using Bun.Terminal + Bun.spawn.
 * Spawn signature matches the historical node-pty `spawn(file, args, options)`.
 */
export function spawn(
  file: string,
  args: string[] = [],
  options: IPtyForkOptions = {},
): IPty {
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const dataCallbacks = new Set<(data: string) => void>()
  const exitCallbacks = new Set<(e: IPtyExitEvent) => void>()
  let exited = false
  let exitEvent: IPtyExitEvent | null = null

  // Create Bun.Terminal with data callback
  const terminal = new Bun.Terminal({
    cols,
    rows,
    data(_term: unknown, data: Uint8Array) {
      const text = new TextDecoder().decode(data)
      for (const cb of dataCallbacks) {
        try { cb(text) } catch { /* ignore callback errors */ }
      }
    },
  })

  // Spawn the process with the terminal
  // Filter out undefined env values (Bun.spawn requires string values)
  const filteredEnv: Record<string, string> = {}
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) {
        filteredEnv[key] = value
      }
    }
  }
  const proc = Bun.spawn([file, ...args], {
    terminal,
    cwd: options.cwd,
    env: filteredEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  // Listen for process exit
  proc.exited.then((exitCode: number) => {
    if (exited) return
    exited = true
    exitEvent = { exitCode, signal: undefined }
    for (const cb of exitCallbacks) {
      try { cb(exitEvent) } catch { /* ignore callback errors */ }
    }
  }).catch(() => {
    if (exited) return
    exited = true
    exitEvent = { exitCode: -1, signal: 9 }
    for (const cb of exitCallbacks) {
      try { cb(exitEvent) } catch { /* ignore callback errors */ }
    }
  })

  return {
    get pid() {
      // Bun types `pid` as always set once the subprocess exists.
      return proc.pid
    },
    get process() {
      return file
    },
    onData(cb: (data: string) => void): IDisposable {
      dataCallbacks.add(cb)
      return {
        dispose() {
          dataCallbacks.delete(cb)
        },
      }
    },
    onExit(cb: (e: IPtyExitEvent) => void): IDisposable {
      if (exited && exitEvent !== null) {
        // Already exited, call immediately
        const capturedEvent = exitEvent
        queueMicrotask(() => { cb(capturedEvent) })
      } else {
        exitCallbacks.add(cb)
      }
      return {
        dispose() {
          exitCallbacks.delete(cb)
        },
      }
    },
    write(data: string) {
      terminal.write(data)
    },
    kill(signal?: string) {
      try {
        if (signal) {
          proc.kill(signal)
        } else {
          proc.kill()
        }
      } catch {
        // Process may already be dead
      }
      try {
        terminal.close()
      } catch {
        // Terminal may already be closed
      }
    },
    resize(cols: number, rows: number) {
      terminal.resize(cols, rows)
    },
  }
}

/**
 * Open an existing PTY (not supported in Bun, throws).
 * Provided for API compatibility only.
 */
export function open(_options: IPtyForkOptions): IPty {
  throw new Error('Bun.Terminal does not support opening existing PTYs')
}
