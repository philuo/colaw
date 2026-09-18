/**
 * The Bun PTY adapter owes the child a SIGWINCH on resize.
 *
 * Bun.Terminal.resize() applies the new winsize but the pty it creates has no
 * controlling terminal, so the kernel has no foreground process group to signal
 * and no SIGWINCH is ever delivered. A full-screen program only repaints when it
 * arrives — without it the pane reflowed while the program kept painting at the
 * old width, which is what "the terminal ignores the width it is given" and its
 * leftover cells actually are.
 *
 * It also owes the consumer whole characters: a pty read is capped, so a
 * multi-byte character straddles two chunks and each half must be held until
 * its continuation arrives.
 *
 * And it owes the consumer flow control: the seam pauses the pty when its own
 * buffer fills, so `pause`/`resume` have to hold and then release output in
 * order. Bun.Terminal has no pause of its own.
 */
import { afterEach, expect, it } from 'vitest'
import { getPtyModule } from '../src/pty-adapter.ts'

const running: (() => void)[] = []
afterEach(() => { for (const stop of running.splice(0)) stop() })

it('delivers SIGWINCH to the pty child on resize', async () => {
  let seen = ''
  const pty = getPtyModule().spawn('/bin/sh', ['-c',
    'trap \'echo "WINCH $(stty size)"\' WINCH; echo "READY $(stty size)"; while :; do sleep 0.05; done',
  ], { cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color' } })
  running.push(() => { pty.kill() })
  const data = pty.onData((chunk: string) => { seen += chunk })
  try {
    await expect.poll(() => seen, { timeout: 5000 }).toContain('READY')
    pty.resize(100, 30)
    await expect.poll(() => seen, { timeout: 5000 }).toContain('WINCH')
    expect(seen).toContain('WINCH 30 100')
  } finally { data.dispose() }
})

it('keeps a multi-byte character whole across a pty read boundary', async () => {
  // Every character here is three bytes and a pty read stops at 1024, so the
  // run is guaranteed to split one. Decoding each chunk with its own
  // non-streaming decoder (the shape this test pins down) would replace both
  // halves with U+FFFD: two cells where the program drew one, pushing the rest
  // of that line a column to the right — a TUI's box border and cursor land
  // wrong, and the leftovers read as garbled text.
  const payload = '─│╭╮╰╯…汉字'
  const writes = 600
  let seen = ''
  const pty = getPtyModule().spawn('/bin/sh', ['-c',
    `awk 'BEGIN { s = "${payload}"; for (i = 0; i < ${String(writes)}; i++) printf "%s", s }'`,
  ], { cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color' } })
  running.push(() => { pty.kill() })
  const data = pty.onData((chunk: string) => { seen += chunk })
  try {
    await expect.poll(() => seen.length, { timeout: 5000 }).toBe(payload.length * writes)
    expect(seen).not.toContain('\uFFFD')
    expect(seen).toBe(payload.repeat(writes))
  } finally { data.dispose() }
})

it('holds output while paused and releases it in order on resume', async () => {
  // The seam pauses the pty when its own buffer fills, and only it can resume.
  // An adapter that ignores the pause still receives everything, so the only
  // observable difference is *when* — which is the whole point of the signal,
  // and what this test holds it to.
  //
  // The child outlives the pause window on purpose: an exiting process ends the
  // output stream, and the adapter drains its queue then (nothing else ever
  // would), which would look like a pause that did not hold.
  let seen = ''
  const pty = getPtyModule().spawn('/bin/sh', ['-c',
    'sleep 0.2; printf first; sleep 1; printf second; sleep 1',
  ], { cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color' } })
  running.push(() => { pty.kill() })
  const data = pty.onData((chunk: string) => { seen += chunk })
  try {
    pty.pause()
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(seen).toBe('')
    pty.resume()
    await expect.poll(() => seen, { timeout: 5000 }).toBe('first')
    await expect.poll(() => seen, { timeout: 5000 }).toBe('firstsecond')
  } finally { data.dispose() }
})
