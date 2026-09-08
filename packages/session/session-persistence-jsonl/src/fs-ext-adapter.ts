/**
 * fs-ext adapter module with runtime detection.
 *
 * Under Node.js, re-exports the real fs-ext native module.
 * Under Bun, exports a stub (Bun uses Bun.FFI flock directly in lease.ts),
 * so fs-ext's native ABI mismatch never triggers at module load time.
 *
 * This module is statically imported by lease.ts, which allows vitest's
 * `vi.mock('fs-ext')` to intercept the static import when running under Node.js.
 *
 * @module @deepseek-ai/dsh-session-persistence-jsonl/fs-ext-adapter
 */

const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

// Under Bun, use a stub to avoid loading the native module.
// Under Node.js, load the real fs-ext module (static import for vitest mock compatibility).
const fsExt = isBun
  ? ({} as typeof import('fs-ext'))
  : (await import('fs-ext')) as typeof import('fs-ext')

export { fsExt }
