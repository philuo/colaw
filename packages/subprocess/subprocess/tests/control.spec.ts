import { spawn } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  openInheritedControlChannel,
  SUBPROCESS_CONTROL_FD,
  SUBPROCESS_CONTROL_ENV,
  SUBPROCESS_CONTROL_MARKER,
} from '../src/control.ts'

const helper = new URL('../src/control.ts', import.meta.url).href

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('inherited control channel', () => {
  it('consumes the provider marker before opening the descriptor', () => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_MARKER)
    // The unit process owns no control descriptor; the call may only pass the
    // marker gate, so a duplex over the absent fd is the expected outcome.
    const channel = openInheritedControlChannel()
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    channel.destroy()
  })

  it.each([undefined, 'invalid'])('rejects an absent or invalid launch marker: %s', (marker) => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, marker)
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
  })
})

describe('fd control transport', () => {
  /**
   * Spawn a child that mirrors the production shape: the shipped helper opens
   * the inherited descriptor, the child echoes every frame until the parent
   * half-closes, then exits. The parent endpoint is the stdio socket itself.
   */
  function echoChild(size: number): ReturnType<typeof spawn> {
    const source = `const {openInheritedControlChannel} = await import(${JSON.stringify(helper)});`
      + 'const c = openInheritedControlChannel();'
      + 'const chunks = []; let received = 0;'
      + 'c.on(\'data\', (b) => { chunks.push(b); received += b.length;'
      + `  if (received === ${size}) c.write(Buffer.concat(chunks), () => { c.destroy() }) });`
      + 'setTimeout(() => process.exit(1), 10_000)'
    return spawn(process.execPath, ['--input-type=module', '--eval', source], {
      stdio: ['ignore', 'ignore', 'inherit',
        ...(new Array(SUBPROCESS_CONTROL_FD - 3).fill('ignore')), 'overlapped'] as never,
      env: { ...process.env, [SUBPROCESS_CONTROL_ENV]: SUBPROCESS_CONTROL_MARKER },
    })
  }

  async function roundTrip(frame: Buffer): Promise<Buffer> {
    const child = echoChild(frame.length)
    // Node's stdio tuple type names only the first five slots; the extra
    // control descriptor exists at runtime.
    const streams = child.stdio as unknown as ReadonlyArray<Duplex | null>
    const control = streams[SUBPROCESS_CONTROL_FD]
    if (!(control !== null && typeof control === 'object' && 'write' in control)) {
      throw new Error('missing child control descriptor')
    }
    const received: Buffer[] = []
    const done = (async () => {
      for await (const chunk of control as AsyncIterable<Buffer>) received.push(Buffer.from(chunk))
    })()
    control.write(frame)
    await done
    const all = Buffer.concat(received)
    // Length first: a mismatch here reports as a count, not a wall of bytes.
    expect(all.length).toBe(frame.length)
    return all
  }

  it('echoes exact binary bytes through the inherited descriptor', async () => {
    const input = Buffer.alloc(256 * 1024)
    for (let index = 0; index < input.length; index++) input[index] = index % 256
    expect(await roundTrip(input)).toEqual(input)
  }, 15_000)

  it('survives twenty sequential spawns without losing a frame', async () => {
    for (let run = 0; run < 20; run += 1) {
      expect(await roundTrip(Buffer.from([run, 1, 2, 3, 4, 5, 6, 7, 8]))).toEqual(
        Buffer.from([run, 1, 2, 3, 4, 5, 6, 7, 8]),
      )
    }
  }, 60_000)
})
