/**
 * The process boundary itself: a real child, real frames, real death.
 *
 * These cases are the whole reason the host exists. The driver used to run in
 * this process, where an AppKit assertion on its worker thread SIGTRAP-aborts
 * everything (`bun-2026-09-23-132012.ips`); hosting it in a child turns that
 * same failure into an exit the host survives.
 *
 * The death is provoked with SIGKILL rather than SIGTRAP so the suite does not
 * litter DiagnosticReports, and because the host treats every end-of-child the
 * same way. The SIGTRAP path was verified by hand against the packaged app.
 */

import { describe, expect, it } from 'vitest'
import { openDriverHost } from '../src/driver-host.ts'

/**
 * A worker that answers one call, then kills itself on the next one — stand-in
 * for a driver that reaches an abort mid-session. It speaks the same frame
 * protocol, so the host cannot tell it apart from the real child.
 */
const SUICIDAL_WORKER = `const emit = process.stdout.write.bind(process.stdout);
let seen = 0;
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (line === '') continue;
    const frame = JSON.parse(line);
    if (frame.op === 'shutdown') {
      emit(JSON.stringify({ id: 0, ok: true, result: 'bye' }) + '\\n');
      process.exit(0);
    }
    if (frame.op === 'cancel') continue;
    seen += 1;
    if (seen > 1) process.kill(process.pid, 'SIGKILL');
    else emit(JSON.stringify({ id: frame.id, ok: true, result: 'first:' + String(frame.op) }) + '\\n');
  }
});
process.stdin.resume();
`

/** A worker that hangs on its first call, so cancellation has something to cancel. */
const HANG_FIRST_WORKER = `const emit = process.stdout.write.bind(process.stdout);
let seen = 0;
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (line === '') continue;
    const frame = JSON.parse(line);
    if (frame.op === 'shutdown') process.exit(0);
    if (frame.op === 'cancel') continue;
    seen += 1;
    if (seen === 1) continue;
    emit(JSON.stringify({ id: frame.id, ok: true, result: 'after-hang:' + String(frame.op) }) + '\\n');
  }
});
process.stdin.resume();
`

/** A worker that reports an error the way the real one reports a refusal. */
const REFUSING_WORKER = `const emit = process.stdout.write.bind(process.stdout);
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (line === '') continue;
    const frame = JSON.parse(line);
    if (frame.op === 'shutdown') process.exit(0);
    if (frame.op === 'cancel') continue;
    emit(JSON.stringify({ id: frame.id, ok: false, error: 'Permission denied: user policy' }) + '\\n');
  }
});
process.stdin.resume();
`

describe('the child-hosted driver', () => {
  it('serves the real driver catalog across the process boundary', async () => {
    const host = openDriverHost()
    try {
      const catalog = JSON.parse(await host.listToolsJson({ signal: new AbortController().signal })) as { tools: Array<{ name: string }> }
      expect(catalog.tools.length).toBeGreaterThan(0)
      expect(catalog.tools.map(tool => tool.name)).toContain('get_window_state')
    } finally {
      await host.shutdown()
    }
  })

  it('survives a child that dies mid-session and completes the next call', async () => {
    const host = openDriverHost({ workerSource: SUICIDAL_WORKER })
    const signal = new AbortController().signal
    try {
      expect(await host.listToolsJson({ signal })).toBe('first:list')
      // This call kills the child while the call is in flight.
      await expect(host.listToolsJson({ signal })).rejects.toThrow(/worker exited/u)
      // The host is alive and starts a fresh child for the next call.
      expect(await host.listToolsJson({ signal })).toBe('first:list')
    } finally {
      await host.shutdown()
    }
  })

  it('settles every in-flight call when the child dies under them', async () => {
    const host = openDriverHost({ workerSource: SUICIDAL_WORKER })
    const signal = new AbortController().signal
    try {
      expect(await host.listToolsJson({ signal })).toBe('first:list')
      // Three at once: one kills the child, all three must settle rather than hang.
      const settled = await Promise.allSettled([
        host.listToolsJson({ signal }),
        host.listToolsJson({ signal }),
        host.listToolsJson({ signal }),
      ])
      expect(settled.every(entry => entry.status === 'rejected')).toBe(true)
    } finally {
      await host.shutdown()
    }
  })

  it('cancels a call the child is still holding, and stays usable after', async () => {
    const host = openDriverHost({ workerSource: HANG_FIRST_WORKER })
    const controller = new AbortController()
    try {
      // The child takes this call and never answers it, which is what a slow
      // desktop operation looks like from here.
      const hung = host.listToolsJson({ signal: controller.signal })
      controller.abort(new Error('caller gave up'))
      await expect(hung).rejects.toThrow('caller gave up')
      // A cancelled call must not leave the host thinking the child is gone.
      expect(await host.listToolsJson({ signal: new AbortController().signal })).toBe('after-hang:list')
    } finally {
      await host.shutdown()
    }
  })

  it('surfaces a driver refusal as a rejected call, not a crash', async () => {
    const host = openDriverHost({ workerSource: REFUSING_WORKER })
    try {
      await expect(host.callTool('list_windows', '{}', { signal: new AbortController().signal }))
        .rejects.toThrow('Permission denied: user policy')
    } finally {
      await host.shutdown()
    }
  })

  it('reaps the child on shutdown and refuses work afterwards', async () => {
    const host = openDriverHost({ workerSource: SUICIDAL_WORKER })
    expect(await host.listToolsJson({ signal: new AbortController().signal })).toBe('first:list')
    await host.shutdown()
    // Idempotent, and closed means closed.
    await host.shutdown()
    await expect(host.listToolsJson({ signal: new AbortController().signal })).rejects.toThrow('closed')
  })

  it('writes the permission policy into the ambient environment the child inherits', async () => {
    // The policy is armed by the provider, but its whole delivery mechanism is
    // "the child inherits this process's environment", so that is what is
    // pinned here: the child sees the variable the provider set.
    process.env.CUA_DRIVER_POLICY_FILE = '/tmp/colaw-cua-policy/policy.yaml'
    // The child inherits the environment as it stands at spawn, so the variable
    // has to be in place before the host starts it.
    const host = openDriverHost({
      workerSource: 'const emit = process.stdout.write.bind(process.stdout);'
        + 'process.stdin.on("data", (chunk) => { for (const line of chunk.toString().split("\\n")) {'
        + ' if (line === "") continue; const frame = JSON.parse(line);'
        + ' if (frame.op === "shutdown") process.exit(0);'
        + ' if (frame.op === "cancel") continue;'
        + ' emit(JSON.stringify({ id: frame.id, ok: true, result: String(process.env.CUA_DRIVER_POLICY_FILE) }) + "\\n"); } });'
        + 'process.stdin.resume();',
    })
    try {
      expect(await host.listToolsJson({ signal: new AbortController().signal })).toBe('/tmp/colaw-cua-policy/policy.yaml')
    } finally {
      await host.shutdown()
      delete process.env.CUA_DRIVER_POLICY_FILE
    }
  })
})
