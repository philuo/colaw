/**
 * Picomatch adapter with runtime detection.
 *
 * In Bun, uses Bun.Glob.match() for glob pattern matching.
 * In Node.js, uses the picomatch library for full functionality.
 *
 * Note: Bun.Glob has fewer features than picomatch. Pattern arrays are
 * emulated by matching against each pattern. The `dot` option is emulated
 * by filtering dot-file matches when `dot: false`.
 */

/** Detect Bun runtime. */
const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

/** Picomatch options (subset). */
export interface PicomatchOptions {
  dot?: boolean
}

/** Match function returned by picomatch. */
export type MatchFunction = (str: string) => boolean

// ---------------------------------------------------------------------------
// Node.js picomatch implementation
// ---------------------------------------------------------------------------

function createPicomatchNode(pattern: string | string[], options?: PicomatchOptions): MatchFunction {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const picomatch = require('picomatch') as (pattern: string | string[], options?: unknown) => MatchFunction
  return picomatch(pattern, options)
}

// ---------------------------------------------------------------------------
// Bun.Glob implementation
// ---------------------------------------------------------------------------

function createPicomatchBun(pattern: string | string[], options?: PicomatchOptions): MatchFunction {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  const dot = options?.dot ?? false

  // Create a Glob matcher for each pattern
  const globs = patterns.map((p) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Glob } = require('bun') as { Glob: new (pattern: string) => { match(str: string): boolean } }
      return new Glob(p)
    } catch {
      // Fallback: always match (should not happen)
      return { match: () => true }
    }
  })

  return (str: string): boolean => {
    // Bun.Glob matches dot files by default. When dot: false, filter them out.
    if (!dot && isDotFile(str)) {
      return false
    }
    // Match against any pattern
    return globs.some((glob) => {
      try {
        return glob.match(str)
      } catch {
        return false
      }
    })
  }
}

/** Check if a path component starts with a dot (picomatch dot semantics). */
function isDotFile(str: string): boolean {
  // Check if any path component starts with a dot
  const components = str.split('/')
  return components.some(component => component.startsWith('.') && component !== '.' && component !== '..')
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a glob match function.
 * Uses Bun.Glob in Bun, picomatch in Node.js.
 */
export function createPicomatch(pattern: string | string[], options?: PicomatchOptions): MatchFunction {
  if (isBun) {
    return createPicomatchBun(pattern, options)
  }
  return createPicomatchNode(pattern, options)
}

/** Whether running in Bun runtime. */
export const IS_BUN = isBun
