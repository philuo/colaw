/**
 * PTY adapter over Bun's native `Bun.Terminal` + `Bun.spawn({ terminal })`.
 * Implements the IPty surface the subprocess seam consumes:
 * pid, onData, onExit, write, kill, resize.
 *
 * Three pty facts this adapter has to supply itself, because Bun's pty does not:
 * a resize must deliver SIGWINCH (no controlling terminal, so the kernel has no
 * foreground process group to signal), the byte stream must be decoded in
 * stream mode (a read boundary splits multi-byte characters), and `pause`/
 * `resume` must queue (the terminal has no flow control of its own). All three
 * are load-bearing for a full-screen TUI and none is visible in a smoke test.
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
  /** Hold output delivery; chunks arriving while paused are buffered in order. */
  pause(): void
  /** Resume output delivery, flushing everything buffered while paused. */
  resume(): void
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
  //
  // One decoder for the pty's whole life, in stream mode. A pty read is capped
  // (1024 bytes here), so a three-byte character routinely straddles two
  // chunks; decoding each chunk with a fresh, non-streaming TextDecoder turns
  // both halves into U+FFFD. Two cells where the program drew one is not a
  // cosmetic glitch: the rest of that line shifts by one column, so a TUI's box
  // borders and its last cell land in the wrong place — the reported "garbled
  // symbols", worst right after a full repaint (a resize), which is exactly
  // when the program writes the most bytes per frame. `terminal-bash/session.ts`
  // decodes this way for the same reason.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  // Output flow control. Bun.Terminal's surface is write/resize/close — it has
  // no pause of its own, while the seam stops the pty whenever its own buffer
  // fills and expects the producer to hold the rest. Without a queue here that
  // stop could not happen: `terminal.pause()` threw a TypeError into the
  // swallowed callback guard, leaving the consumer's `outputPaused` set, and the
  // `terminal.resume()` that followed threw from inside a 'drain' listener —
  // where nothing catches it.
  let paused = false
  const queued: string[] = []
  const deliver = (text: string): void => {
    for (const cb of dataCallbacks) {
      try { cb(text) } catch { /* ignore callback errors */ }
    }
  }
  const emit = (text: string): void => {
    if (text.length === 0) return
    if (paused) { queued.push(text); return }
    deliver(text)
  }
  const drainQueue = (): void => {
    // A callback may pause again mid-drain; whatever is left stays queued.
    let next = queued.shift()
    while (!paused && next !== undefined) {
      deliver(next)
      next = queued.shift()
    }
  }
  const terminal = new Bun.Terminal({
    cols,
    rows,
    data(_term: unknown, chunk: Uint8Array) {
      emit(decoder.decode(chunk, { stream: true }))
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

  /**
   * Deliver a signal the way a tty driver would: to the child's process group
   * first, so the shell's foreground job sees it too, then to the child itself
   * for a caller that never became a group leader. A reaped child's pid may
   * already belong to someone else, so nothing is sent once it has exited.
   *
   * @param name - signal name.
   */
  const signalGroup = (name: string): void => {
    if (exited) return
    for (const target of [-proc.pid, proc.pid]) {
      try { process.kill(target, name) } catch { /* already reaped, or not a leader */ }
    }
  }

  // Listen for process exit
  /**
   * Publish the exit exactly once, after draining the decoder.
   *
   * A half-decoded trailing sequence is flushed first: the process is gone, so
   * those bytes are all that will ever arrive, and the exit event is what ends
   * the consumer's output stream (`LocalTerminalHandle` ends it in `onExit`).
   * Flushing after the event would drop a character of the last line.
   *
   * @param event - the exit code and signal to publish.
   */
  const finish = (event: IPtyExitEvent): void => {
    if (exited) return
    exited = true
    exitEvent = event
    emit(decoder.decode())
    // Nothing will produce more output, and the exit event ends the consumer's
    // stream, so a pause must not hold the remainder back.
    paused = false
    drainQueue()
    for (const cb of exitCallbacks) {
      try { cb(event) } catch { /* ignore callback errors */ }
    }
  }
  proc.exited.then((exitCode: number) => {
    finish({ exitCode, signal: undefined })
  }).catch(() => {
    finish({ exitCode: -1, signal: 9 })
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
    pause() {
      paused = true
    },
    resume() {
      paused = false
      drainQueue()
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
      // Bun.Terminal.resize applies the new winsize (TIOCSWINSZ lands — the
      // child's `stty size` reports it), but the pty has no controlling
      // terminal, so the kernel has no foreground process group to hand
      // SIGWINCH to and the signal is never sent. A full-screen TUI only
      // redraws when it arrives, so the pane reflowed while the program kept
      // painting at its old width — the reported "terminal ignores the width it
      // is given", with the leftover cells reading as garbled text. The child
      // leads its own process group and the shell's jobs share it, so signalling
      // the group is what the tty driver would have done.
      signalGroup('SIGWINCH')
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
