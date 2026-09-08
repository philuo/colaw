/**
 * node-pty adapter module with runtime detection.
 *
 * Under Node.js, re-exports the real node-pty native module.
 * Under Bun, exports a stub (Bun uses Bun.Terminal adapter directly in pty-adapter.ts),
 * so node-pty's native ABI mismatch never triggers at module load time.
 *
 * This module is statically imported by pty-adapter.ts, which allows vitest's
 * `vi.mock('node-pty')` to intercept the static import when running under Node.js.
 *
 * @module dsh-subprocess-local/node-pty-adapter
 */

const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

// Under Bun, use a stub to avoid loading the native module.
// Under Node.js, load the real node-pty module (static import for vitest mock compatibility).
const nodePty = isBun
  ? ({} as typeof import('node-pty'))
  : (await import('node-pty')) as typeof import('node-pty')

export { nodePty }
