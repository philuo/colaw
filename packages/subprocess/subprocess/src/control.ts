/** Inherited byte-channel protocol shared by subprocess launchers and their children. */

import { createReadStream, writeSync } from 'node:fs'
import { Duplex } from 'node:stream'

/** Child stdio slot reserved for the optional subprocess control channel. */
export const SUBPROCESS_CONTROL_FD = 7

/** Private launch marker consumed before a child executes application code. */
export const SUBPROCESS_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL' as const

/**
 * Marker value for the extra-stdio-descriptor transport.
 *
 * The descriptor is a bidirectional socketpair: Bun 1.4.2 and Node both deliver
 * it deterministically (measured 20/20 frames each way). The child must consume
 * it with filesystem streams — `net.Socket({fd})` never receives on Bun while
 * the same descriptor reads fine through `createReadStream`, and it keeps
 * working on Node, so one implementation serves both runtimes.
 */
export const SUBPROCESS_CONTROL_MARKER = 'pipe'

/**
 * Consume the launch marker and open the inherited control descriptor.
 * The returned stream owns the child side of the channel. Call once before
 * executing untrusted code; messages remain untrusted even though the
 * descriptor was inherited.
 * @returns a connected byte-mode duplex stream owned by the caller.
 * @throws when the marker is missing/invalid.
 */
export function openInheritedControlChannel(): Duplex {
  const marker = process.env[SUBPROCESS_CONTROL_ENV]
  Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV)
  if (marker !== SUBPROCESS_CONTROL_MARKER) throw new Error('subprocess control channel was not inherited')
  return fdDuplex(SUBPROCESS_CONTROL_FD)
}

/**
 * Wrap one inherited socketpair descriptor as the byte-mode duplex the control
 * protocol speaks.
 *
 * Reads push from a read stream over the descriptor. Writes go to the kernel
 * synchronously: an async stream would strand a frame written immediately
 * before a program blocks the event loop — the runtime must observe console
 * output emitted right before a non-yielding loop — while a full descriptor
 * blocks here, which is the bounded backpressure the protocol's frame caps
 * assume. A write that fails because the parent went away surfaces as a
 * stream error, the same shape every transport reports.
 * @param fd - the inherited bidirectional descriptor.
 * @returns a duplex owned by the caller.
 */
function fdDuplex(fd: number): Duplex {
  const input = createReadStream('', { fd, autoClose: false })
  const stream = new Duplex({
    read() { input.resume() },
    write(chunk: Buffer, _encoding, callback) {
      try {
        let offset = 0
        while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset)
        callback()
      } catch (error: unknown) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    // End-of-stream on the parent's side is the process exit's job: the
    // descriptor closes with the child, and a socketpair cannot half-close
    // through the fs surface.
    final(callback) { callback() },
    destroy(error, callback) {
      input.destroy()
      callback(error)
    },
  })
  input.on('data', (chunk) => { if (!stream.push(chunk)) input.pause() })
  input.on('end', () => { stream.push(null) })
  input.on('error', (error: Error) => { stream.destroy(error) })
  return stream
}
