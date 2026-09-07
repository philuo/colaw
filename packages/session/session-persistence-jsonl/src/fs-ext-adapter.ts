/**
 * fs-ext adapter module.
 *
 * This module exists solely to isolate the static `import * as fsExt from 'fs-ext'`
 * so that Bun can avoid loading the native module entirely. lease.ts dynamically
 * imports this module only when running under Node.js; under Bun it uses
 * Bun.FFI flock instead, so fs-ext's native ABI mismatch never triggers.
 *
 * Vitest mocking works here because the import is static (ES module), and
 * `vi.mock('fs-ext')` intercepts this static import when the adapter is loaded.
 *
 * @module @deepseek-ai/dsh-session-persistence-jsonl/fs-ext-adapter
 */

import * as fsExt from 'fs-ext'

export { fsExt }
