import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  controlChunk,
  controlDuplex,
  openInheritedControlChannel,
  SUBPROCESS_CONTROL_ENV,
  SUBPROCESS_CONTROL_MARKER,
} from '../src/control.ts'
import type { ControlIpcPort } from '../src/control.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * A port double that records writes.
 *
 * `deferReceipts` withholds every send receipt until the test releases it, which
 * is what a real transport does while a frame is in flight.
 */
function fakePort(options: { deferReceipts?: boolean } = {}): ControlIpcPort & {
  sent: unknown[]
  disconnects: number
  releaseReceipts(): void
  deliver(message: unknown): void
  disconnect(): void
} {
  const listeners: ((message: unknown) => void)[] = []
  const disconnects: (() => void)[] = []
  const receipts: (() => void)[] = []
  const state = { disconnects: 0 }
  return {
    sent: [],
    get disconnects(): number { return state.disconnects },
    send(message: unknown, callback?: (error: Error | null) => void): boolean {
      this.sent.push(message)
      if (options.deferReceipts === true) receipts.push(() => { callback?.(null) })
      else callback?.(null)
      return true
    },
    on(event: 'message' | 'disconnect', listener: ((message: unknown) => void) | (() => void)): unknown {
      if (event === 'message') listeners.push(listener as (message: unknown) => void)
      else disconnects.push(listener as () => void)
      return this
    },
    releaseReceipts(): void { for (const receipt of receipts.splice(0)) receipt() },
    deliver(message: unknown): void { for (const listener of listeners) listener(message) },
    disconnect(): void { state.disconnects += 1; for (const listener of disconnects) listener() },
  }
}

describe('control chunk decoding', () => {
  it('accepts every binary form a transport may deliver', () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
    expect(controlChunk(bytes)).toEqual(bytes)
    expect(controlChunk(new Uint8Array(bytes))).toEqual(bytes)
    // Both runtimes serialize a Buffer message into this JSON wire form.
    expect(controlChunk({ type: 'Buffer', data: [...bytes] })).toEqual(bytes)
  })

  it('rejects a message that carries no bytes', () => {
    expect(() => controlChunk({ hello: 'world' })).toThrow('non-binary message')
    expect(() => controlChunk('text')).toThrow('non-binary message')
    expect(() => controlChunk(undefined)).toThrow('non-binary message')
  })
})

describe('control duplex over an IPC port', () => {
  it('turns writes into messages and messages into reads', async () => {
    const port = fakePort()
    const channel = controlDuplex(port)
    const received: Buffer[] = []
    channel.on('data', (chunk: Buffer) => { received.push(chunk) })

    const chunk = Buffer.from([9, 8, 7])
    channel.write(chunk)
    expect(port.sent).toEqual([chunk])

    const read = once(channel, 'data')
    port.deliver({ type: 'Buffer', data: [1, 2, 3] })
    await read
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('ends the stream when the peer disconnects', async () => {
    const port = fakePort()
    const channel = controlDuplex(port)
    // Reading puts the stream in flowing mode, which is what emits `end`.
    channel.on('data', () => {})
    const ended = once(channel, 'end')
    port.disconnect()
    await ended
  })

  it('hands every corked frame to the port before the cork is released', () => {
    // A deferred receipt must not strand the frames a cork holds: `uncork` cannot
    // flush while a write is in flight, so the receipt cannot gate the hand-off.
    const port = fakePort({ deferReceipts: true })
    const channel = controlDuplex(port)
    channel.cork()
    channel.write(Buffer.from([1]))
    channel.write(Buffer.from([2]))
    channel.uncork()
    expect(port.sent).toEqual([Buffer.from([1]), Buffer.from([2])])
  })

  it('waits for outstanding receipts before disconnecting the port', async () => {
    // A write-then-close caller must not lose the frame the transport still holds.
    const port = fakePort({ deferReceipts: true })
    const channel = controlDuplex(port)
    channel.write(Buffer.from([1]))
    const destroyed = once(channel, 'close')
    channel.destroy()
    await Promise.resolve()
    expect(port.disconnects).toBe(0)
    port.releaseReceipts()
    await destroyed
    expect(port.disconnects).toBe(1)
  })
})

describe('inherited control channel', () => {
  it('consumes the provider marker before refusing a process without an IPC channel', () => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_MARKER)
    const sendable = process as { send?: unknown }
    const original = sendable.send
    delete sendable.send
    try {
      expect(() => openInheritedControlChannel()).toThrow('IPC channel')
      expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    } finally {
      if (original !== undefined) sendable.send = original
    }
  })

  it.each([undefined, 'invalid'])('rejects an absent or invalid launch marker: %s', (marker) => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, marker)
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
  })
})
