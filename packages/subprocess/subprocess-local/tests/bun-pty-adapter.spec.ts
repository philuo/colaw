/**
 * The Bun PTY adapter owes the child a SIGWINCH on resize.
 *
 * Bun.Terminal.resize() applies the new winsize but the pty it creates has no
 * controlling terminal, so the kernel has no foreground process group to signal
 * and no SIGWINCH is ever delivered. A full-screen program only repaints when it
 * arrives — without it the pane reflowed while the program kept painting at the
 * old width, which is what "the terminal ignores the width it is given" and its
 * leftover cells actually are.
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
