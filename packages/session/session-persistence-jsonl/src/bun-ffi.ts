/**
 * Bun's `bun:ffi` surface, behind one static import.
 *
 * `bun:ffi` exists only under Bun, so the module naming it is reached through a
 * `require` here rather than an import at the use site: an import would be
 * resolved on Node too, where the specifier does not exist. The FFI shape is
 * typed structurally because the host program carries no Bun type package.
 *
 * Keeping the runtime-specific call behind this boundary is also what lets a
 * test substitute it: vitest's module registry covers imports, and the bare
 * `require('bun:ffi')` the caller would otherwise perform bypasses it entirely.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/bun-ffi
 */

/**
 * The `bun:ffi` surface this package drives.
 */
export interface BunFfiModule {
  // Property-style signatures, not methods: these are destructured off the
  // module object, so they carry no receiver to bind.
  readonly dlopen: (
    path: string,
    symbols: Record<string, { readonly args: readonly string[]; readonly returns: string }>,
  ) => { readonly symbols: Record<string, unknown> }
  readonly read: { readonly u32: (pointer: number) => number }
}

/** libc's path on this platform. */
export const LIBC_PATH = process.platform === 'darwin'
  ? '/usr/lib/libSystem.B.dylib'
  : 'libc.so.6'

/**
 * Load `bun:ffi` on first use.
 * @returns the module's FFI surface.
 */
function bunFfi(): BunFfiModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('bun:ffi') as BunFfiModule
}

/**
 * Open libc and resolve the given symbols.
 * @param symbols - the symbol table to resolve.
 * @returns the opened library's symbols.
 */
export function dlopenLibc(
  symbols: Record<string, { readonly args: readonly string[]; readonly returns: string }>,
): { readonly symbols: Record<string, unknown> } {
  return bunFfi().dlopen(LIBC_PATH, symbols)
}

/**
 * Read the 32-bit unsigned value at a pointer.
 * @param pointer - the address to read.
 * @returns the value stored there.
 */
export function readU32(pointer: number): number {
  return bunFfi().read.u32(pointer)
}
