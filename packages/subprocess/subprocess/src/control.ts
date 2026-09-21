/** Inherited byte-channel protocol shared by subprocess launchers and their children. */

import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'

/** Private launch marker consumed before a child executes application code. */
export const SUBPROCESS_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL' as const

/**
 * Marker value naming the IPC-backed transport a parent wired up.
 *
 * The channel once rode an extra inherited descriptor at fd 7. Bun wires extra
 * stdio descriptors unreliably — the same spawn shape delivers bytes on one call
 * and drops them on the next, measured in one process — so the channel now rides
 * the IPC channel `stdio: 'ipc'` creates, which both runtimes deliver
 * deterministically. The value stays a named marker rather than a bare boolean so
 * a future transport can add its own without a compatibility break.
 */
export const SUBPROCESS_CONTROL_MARKER = 'ipc'

/**
 * The IPC port surface a parent's child handle and a child's `process` both
 * expose. Declared structurally because the two are different classes with
 * different overload sets, and the channel needs only these three members.
 */
export interface ControlIpcPort {
  /** Queue one message; the callback reports the transport's own failure. */
  send(message: unknown, callback?: (error: Error | null) => void): boolean
  /** Subscribe to inbound messages or to the peer's disconnect. */
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  /** Whether the channel is still connected; false once either side disconnected. */
  readonly connected?: boolean
  /** Close the channel. An IPC channel keeps its process alive, so teardown must reach it. */
  disconnect?(): void
}

/**
 * Recover one binary chunk from an IPC message.
 *
 * Both runtimes serialize a `Buffer` message with the JSON wire form
 * `{ type: 'Buffer', data: number[] }`, and a structured-clone transport may hand
 * back the typed array itself, so every shape a delivered chunk can take is
 * accepted here and anything else is a protocol error rather than silent bytes.
 *
 * @param message - one message delivered by the IPC port.
 * @returns the chunk as a Buffer owned by the caller.
 * @throws when the message is not a binary chunk.
 */
export function controlChunk(message: unknown): Buffer {
  if (Buffer.isBuffer(message)) return message
  if (message instanceof Uint8Array) return Buffer.from(message)
  if (typeof message === 'object' && message !== null) {
    const framed = message as { type?: unknown; data?: unknown }
    if (framed.type === 'Buffer' && Array.isArray(framed.data)) return Buffer.from(framed.data as number[])
  }
  throw new Error('subprocess control channel received a non-binary message')
}

/**
 * Wrap one IPC port as the byte-mode duplex the control protocol speaks.
 *
 * The port stays the transport: writes become messages, inbound messages become
 * reads, and the peer's disconnect becomes end-of-stream so a consumer observes
 * the same terminal event it saw from an inherited descriptor.
 *
 * @param port - the IPC port to adapt.
 * @returns a duplex owned by the caller.
 */
export function controlDuplex(port: ControlIpcPort): Duplex {
  const pending = new Set<Promise<void>>()
  const stream = new Duplex({
    read() {
      // Reads are pushed by the port's message listener.
    },
    write(chunk: Buffer, _encoding, callback) {
      // The Writable's receipt is this turn's hand-off, not the port's later
      // flush. A caller that corks several frames — the control protocol writes a
      // header and a body — would otherwise strand every frame after the first:
      // `uncork` cannot flush while a write is in flight, so a receipt deferred
      // past a program that blocks the event loop loses the frame. The port's own
      // receipt is tracked separately, so a write-then-close caller still flushes.
      const receipt = Promise.withResolvers<void>()
      pending.add(receipt.promise)
      void receipt.promise.then(() => { pending.delete(receipt.promise) })
      try {
        port.send(chunk, (error) => {
          if (error !== null && error !== undefined) stream.destroy(error)
          receipt.resolve()
        })
      } catch (error: unknown) {
        receipt.resolve()
        callback(error instanceof Error ? error : new Error(String(error)))
        return
      }
      callback()
    },
    destroy(error, callback) {
      void (async () => {
        // Let the transport take every handed-off frame before the channel closes,
        // or a program that writes its final frame and then closes would lose it.
        while (pending.size > 0) await Promise.all([...pending])
        if (port.connected !== false) port.disconnect?.()
        callback(error)
      })()
    },
  })
  port.on('message', (message) => { stream.push(controlChunk(message)) })
  port.on('disconnect', () => { stream.push(null) })
  return stream
}

/**
 * Consume the launch marker and open the inherited IPC control channel.
 * The returned stream owns the channel. Call once before executing untrusted code;
 * messages remain untrusted even though the channel was inherited.
 * @returns a connected byte-mode duplex stream owned by the caller.
 * @throws when the marker is missing/invalid or the process has no IPC channel.
 */
export function openInheritedControlChannel(): Duplex {
  const marker = process.env[SUBPROCESS_CONTROL_ENV]
  Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV)
  if (marker !== SUBPROCESS_CONTROL_MARKER) throw new Error('subprocess control channel was not inherited')
  if (typeof process.send !== 'function') {
    throw new Error('subprocess control channel requires an IPC channel; the child was not spawned with stdio ipc')
  }
  return controlDuplex(process as unknown as ControlIpcPort)
}
