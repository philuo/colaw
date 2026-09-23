/**
 * Bun's `bun:ffi` surface, behind one lazy import.
 *
 * `bun:ffi` exists only under Bun, so the module naming it reaches it through a
 * `require` here rather than an import at the use site: an import is resolved
 * by whatever loads this package, and a resolver that does not know the
 * specifier fails the whole module graph rather than the one call that needs
 * it. That is not hypothetical — vitest resolves `bun:ffi` on every host it
 * runs under, so a top-level import here takes down every test suite that
 * reaches the image adapter. The FFI shape is typed structurally because the
 * host program carries no Bun type package.
 *
 * Keeping the runtime-specific call behind this boundary is also what lets a
 * test substitute it: vitest's module registry covers imports, and the bare
 * `require('bun:ffi')` the caller would otherwise perform bypasses it entirely.
 * @module @deepseek-ai/dsh-attachment-local/bun-ffi
 */

/** One symbol's FFI signature, in `bun:ffi`'s own notation. */
export interface BunFfiSignature {
  readonly args: readonly string[]
  readonly returns: string
}

/** An opened library. The symbol table is typed by the caller's own interface. */
export interface BunFfiLibrary {
  readonly symbols: Record<string, unknown>
}

/** The `bun:ffi` surface this package drives. */
export interface BunFfiModule {
  // Property-style signatures, not methods: these are destructured off the
  // module object, so they carry no receiver to bind.
  readonly dlopen: (path: string, symbols: Record<string, BunFfiSignature>) => BunFfiLibrary
  /**
   * The address of a typed array's first byte. Bun answers a `number` when the
   * address fits a safe integer and a `bigint` otherwise, and every handle this
   * package passes around is typed to carry both.
   */
  readonly ptr: (bytes: ArrayBufferView) => number | bigint
}

/**
 * Load `bun:ffi` on first use.
 * @returns the module's FFI surface.
 */
function bunFfi(): BunFfiModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('bun:ffi') as BunFfiModule
}

/**
 * Open a system framework and resolve the given symbols.
 * @param path - the framework's absolute path.
 * @param symbols - the symbol table to resolve.
 * @returns the opened library's symbols.
 */
export function dlopenFramework(
  path: string,
  symbols: Record<string, BunFfiSignature>,
): BunFfiLibrary {
  return bunFfi().dlopen(path, symbols)
}

/**
 * The address of a typed array's first byte, for handing a buffer to an FFI call.
 * @param bytes - the buffer to address.
 * @returns the address, as the FFI handle type.
 */
export function pointerOf(bytes: ArrayBufferView): number | bigint {
  return bunFfi().ptr(bytes)
}
