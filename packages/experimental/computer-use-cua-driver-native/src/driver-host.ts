/**
 * The Cua Driver, owned by a child process instead of by the host.
 *
 * The published SDK loads `libcua_driver_sdk.dylib` into the importing process
 * — `CuaDriver.create()` "runs the Rust driver in the importing process", and
 * the shipped package carries only that dylib plus a N-API shim, no executable
 * — so the driver and Colaw are one process. One class of driver failure is
 * therefore unfixable from JavaScript: an AppKit main-thread assertion raised
 * on the driver's own tokio worker reaches `__pthread_kill` and SIGTRAP-aborts
 * the whole process. `bun-2026-09-23-132012.ips` names the `cua-driver-abi`
 * thread, `platform_macos::tools::invoke_menu::focus_exact_window`, and
 * `-[NSWindow makeKeyAndOrderFront:]`; no `try`/`catch` runs and a
 * `tools/execute` middleware never resumes.
 *
 * Withholding the tools that reach that path removes the known trigger, but it
 * cannot promise the host survives the next abort-shaped bug. Process
 * isolation can, and it is what this module adds: the driver lives in a child,
 * an abort ends that child, and the host sees an exit.
 *
 * Measured against 0.28.0: a child holding the driver answers `list_windows`,
 * dies on SIGTRAP, and the parent survives, respawns it, and completes the
 * next call. The child is the same `bun` the host already runs on, so this
 * needs no new artifact — and because the host spawns it, macOS attributes the
 * child's TCC requests through Colaw's responsible process, so a restart never
 * re-prompts for something the user already granted.
 *
 * The price is stated plainly: in-flight driver state — a window snapshot's
 * `element_token`, a session, a recording — dies with the child, so a crash
 * costs the model a fresh snapshot instead of costing the user the app.
 *
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native/driver-host
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The driver surface proxied across the process boundary. */
export interface DriverHost {
  /**
   * Read the driver's tool catalog.
   * @param options - the cancellation the round trip rides on.
   * @returns the catalog as the driver's own JSON.
   */
  listToolsJson(options: { signal: AbortSignal }): Promise<string>
  /**
   * Invoke one driver tool.
   * @param name - the upstream tool name.
   * @param argsJson - the tool input as JSON.
   * @param options - the cancellation the call rides on; aborting cancels it in the child too.
   * @returns the driver's raw JSON result.
   */
  callTool(name: string, argsJson: string, options: { signal: AbortSignal }): Promise<{ rawJson: string }>
  /**
   * Stop the child and wait for it to go. Safe to call twice.
   * @returns after the child has exited or been killed.
   */
  shutdown(): Promise<void>
}

/**
 * The child program: own the native driver, answer calls over JSON lines.
 *
 * The first thing it does is move every other stdout writer to stderr, because
 * stdout is the frame channel — a library that prints would otherwise slice
 * into the stream and corrupt a frame.
 *
 * The SDK is loaded by package name through an ESM import with the package
 * directory as the child's working directory. That form resolves in both
 * layouts the driver ships in: the repo's pnpm links, where a CommonJS
 * `createRequire` fails on the package's ESM-only `exports`, and the packaged
 * flat `node_modules` of the app bundle.
 *
 * A frame is one JSON object per line, so an image-bearing result rides the
 * same channel as a small one; the reader below splits on newlines from a
 * growing buffer rather than trusting a line-oriented reader with a frame of
 * several megabytes.
 */
const WORKER_SOURCE = `const sdk = await import('@trycua/cua-driver');

const emit = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const send = (message) => { emit(JSON.stringify(message) + '\\n') };

let driver;
try {
  driver = sdk.CuaDriver.create(undefined);
} catch (error) {
  process.stderr.write('cua driver worker could not start: ' + String((error && error.message) || error) + '\\n');
  process.exit(1);
}

const inFlight = new Map();
let buffer = '';

const close = async () => {
  try { await driver.shutdown() } catch {}
  try { driver.uniffiDestroy() } catch {}
};

// Leaving must not wait on the driver's shutdown: that settles admitted work
// first, and a host that is already gone is not waiting for it.
const exitSoon = () => {
  setTimeout(() => process.exit(0), 1500);
  void close().then(() => process.exit(0));
};

const handle = async (line) => {
  let message;
  try { message = JSON.parse(line) } catch { return }
  if (message.op === 'shutdown') {
    for (const controller of inFlight.values()) controller.abort();
    exitSoon();
    return;
  }
  if (message.op === 'cancel') {
    inFlight.get(message.target)?.abort();
    return;
  }
  const controller = new AbortController();
  inFlight.set(message.id, controller);
  try {
    const result = message.op === 'list'
      ? await driver.listToolsJson({ signal: controller.signal })
      : (await driver.callTool(message.tool, JSON.stringify(message.args), { signal: controller.signal })).rawJson;
    send({ id: message.id, ok: true, result });
  } catch (error) {
    send({ id: message.id, ok: false, error: String((error && error.message) || error) });
  } finally {
    inFlight.delete(message.id);
  }
};

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line !== '') void handle(line);
  }
});

// The host is the only writer of this stdin, so EOF means the host is gone —
// by unload or by crash. Leaving here is what keeps a killed host from leaving
// an orphaned driver behind holding the desktop.
process.stdin.on('end', exitSoon);
process.stdin.resume();
`

/** One call awaiting its frame. */
interface PendingCall {
  resolve(value: string): void
  reject(error: Error): void
}

/** How many stderr bytes to keep for a crash report. */
const DIAGNOSTIC_LIMIT = 2_000

/** How long a graceful `shutdown` frame gets before the child is killed. */
const SHUTDOWN_GRACE_MS = 2_000

/** Launch options for {@link openDriverHost}. */
export interface DriverHostOptions {
  /**
   * Run this program in the child instead of the driver worker.
   *
   * The isolation behaviour worth testing is what the host does when a child
   * dies, and the real driver offers no way to ask it to die on cue. A test
   * supplies a worker that does, which exercises the same spawn, frame,
   * settlement and respawn paths.
   */
  workerSource?: string
}

/**
 * Start a driver in a child process.
 *
 * The child is spawned eagerly so a broken installation fails at mount rather
 * than at the model's first click, and every later call reuses it. A crash is
 * observed as an exit, which settles the calls that were in flight and leaves
 * the next call to start a fresh child — that respawn is the whole point, and
 * it costs only the driver state that died with the previous one.
 * @returns the host proxy, whose `shutdown` terminates the child.
 */
export function openDriverHost(options: DriverHostOptions = {}): DriverHost {
  // The child's working directory is what anchors the SDK import above, so it
  // must be this package's own directory — the app bundle keeps the driver
  // beside it in a flat node_modules, and the repo keeps it linked there.
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const source = options.workerSource ?? WORKER_SOURCE

  let child: ChildProcess | undefined
  let buffer = ''
  let diagnostics = ''
  let nextId = 1
  let stopped = false
  const pending = new Map<number, PendingCall>()

  /** Settle every call still waiting: the child that would answer them is gone. */
  const abandon = (reason: string): void => {
    const tail = diagnostics.trim().split('\n').slice(-3).join(' | ')
    const error = new Error(tail === '' ? reason : `${reason}: ${tail}`)
    for (const call of pending.values()) call.reject(error)
    pending.clear()
  }

  const write = (frame: unknown): void => {
    // `stdin` is undefined with no child and null once its pipe has closed;
    // both mean the same thing here — there is nobody to write a frame to.
    const channel = child?.stdin
    if (channel === undefined || channel === null || channel.destroyed) return
    channel.write(`${JSON.stringify(frame)}\n`)
  }

  const onFrame = (line: string): void => {
    let frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }
    try { frame = JSON.parse(line) as typeof frame } catch { return }
    if (typeof frame.id !== 'number') return
    const call = pending.get(frame.id)
    if (call === undefined) return
    pending.delete(frame.id)
    if (frame.ok === true) call.resolve(String(frame.result ?? ''))
    else call.reject(new Error(String(frame.error ?? 'Cua Driver call failed')))
  }

  const onData = (chunk: string): void => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line !== '') onFrame(line)
    }
  }

  const start = (): void => {
    const proc = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: root,
      // The environment is inherited deliberately: the permission policy the
      // provider writes before mounting reaches the driver only this way, and
      // the engine reads it once, when a runtime starts.
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = proc
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', onData)
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-DIAGNOSTIC_LIMIT)
    })
    proc.on('error', (error) => {
      if (child !== proc) return
      child = undefined
      abandon(`Cua Driver worker could not be spawned (${error.message})`)
    })
    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      child = undefined
      buffer = ''
      abandon(`Cua Driver worker exited (${signal ?? `code ${String(code)}`})`)
    })
  }

  const request = (frame: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
    if (stopped) return Promise.reject(new Error('Cua Driver host is closed'))
    signal.throwIfAborted()
    if (child === undefined) start()
    const id = nextId++
    return new Promise<string>((resolve, reject) => {
      const abort = (): void => {
        pending.delete(id)
        // Tell the child too, so a long operation stops consuming the desktop
        // rather than answering a call nobody is waiting for.
        write({ op: 'cancel', target: id })
        reject(signal.reason instanceof Error ? signal.reason : new Error('Cua Driver call aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      pending.set(id, {
        resolve: (value) => { signal.removeEventListener('abort', abort); resolve(value) },
        reject: (error) => { signal.removeEventListener('abort', abort); reject(error) },
      })
      write({ id, ...frame })
    })
  }

  start()

  return {
    listToolsJson: options => request({ op: 'list' }, options.signal),
    async callTool(name, argsJson, options) {
      const rawJson = await request({ op: 'call', tool: name, args: JSON.parse(argsJson) as unknown }, options.signal)
      return { rawJson }
    },
    async shutdown() {
      if (stopped) return
      stopped = true
      const proc = child
      if (proc === undefined) return
      write({ op: 'shutdown' })
      const gone = new Promise<void>((resolve) => {
        proc.once('exit', () => { resolve() })
      })
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
      }, SHUTDOWN_GRACE_MS)
      await gone
      clearTimeout(timer)
      if (child === proc) child = undefined
      abandon('Cua Driver host was closed')
    },
  }
}
