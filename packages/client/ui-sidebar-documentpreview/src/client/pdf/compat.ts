/**
 * Runtime shims for the post-ES2024 APIs PDF.js 6 requires. The desktop
 * WKWebView this bundle runs in lacks the Map upsert proposal
 * (`getOrInsert`/`getOrInsertComputed`), and possibly `Promise.try` and the
 * Set methods on older macOS builds — the exact production symptom was
 * `this.#g.getOrInsertComputed is not a function` on every PDF open. Every
 * shim installs only when the API is missing, so newer runtimes stay on
 * their native implementations and repeated installs are no-ops.
 *
 * The same shims must exist inside the PDF worker: the worker is a separate
 * module Worker with its own globals, so {@link WORKER_COMPAT_SOURCE} carries
 * this exact list as plain JavaScript that {@link ./runtime.ts} prepends to
 * the worker's Blob source. Keep the two halves in sync — the compat spec
 * asserts both define the same surface.
 */

/** The shimmed method names, shared by the install and the worker source. */
const MAP_SHIMS = ['getOrInsert', 'getOrInsertComputed'] as const
const SET_SHIMS = ['intersection', 'union', 'difference', 'symmetricDifference'] as const

type PrototypeRecord = Record<string, unknown>

/** The structural stand-in for the native ReadonlySet used by the Set shims. */
interface ReadonlySetLikeShim {
  has(value: unknown): boolean
}

/**
 * Install every shim whose API is missing. Idempotent: a runtime that
 * already carries the native implementation keeps it.
 */
export function installPdfCompat(): void {
  if (typeof (Map.prototype as unknown as PrototypeRecord).getOrInsertComputed !== 'function') {
    const prototype = Map.prototype as unknown as PrototypeRecord & Map<unknown, unknown>
    Object.defineProperty(prototype, 'getOrInsert', {
      value(this: Map<unknown, unknown>, key: unknown, value: unknown): unknown {
        if (this.has(key)) return this.get(key)
        this.set(key, value)
        return value
      },
      writable: true, configurable: true,
    })
    Object.defineProperty(prototype, 'getOrInsertComputed', {
      value(this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown): unknown {
        if (this.has(key)) return this.get(key)
        const computed = compute(key)
        this.set(key, computed)
        return computed
      },
      writable: true, configurable: true,
    })
  }

  if (typeof (Promise as unknown as PrototypeRecord & { try?: unknown }).try !== 'function') {
    Object.defineProperty(Promise, 'try', {
      value<Return>(this: PromiseConstructor, attempt: (...args: unknown[]) => Return, ...args: unknown[]): Promise<Awaited<Return>> {
        try {
          const result = attempt(...args)
          return Promise.resolve(result)
        } catch (error) {
          // Polyfill fidelity: `Promise.try` forwards the thrown value as the
          // rejection reason verbatim, so wrapping it in an Error here would
          // invent a shape the spec does not have.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          return Promise.reject(error)
        }
      },
      writable: true, configurable: true,
    })
  }

  if (typeof (Set.prototype as unknown as PrototypeRecord).intersection !== 'function') {
    const prototype = Set.prototype as unknown as PrototypeRecord & Set<unknown>
    const wrap = (other: ReadonlySetLikeShim | Iterable<unknown>): Set<unknown> =>
      other instanceof Set ? other : new Set(other as Iterable<unknown>)
    Object.defineProperty(prototype, 'intersection', {
      value(this: Set<unknown>, other: ReadonlySetLikeShim | Iterable<unknown>): Set<unknown> {
        const result = new Set<unknown>()
        for (const value of this) if (wrap(other).has(value)) result.add(value)
        return result
      },
      writable: true, configurable: true,
    })
    Object.defineProperty(prototype, 'union', {
      value(this: Set<unknown>, other: ReadonlySetLikeShim | Iterable<unknown>): Set<unknown> {
        const result = new Set<unknown>(this)
        for (const value of wrap(other)) result.add(value)
        return result
      },
      writable: true, configurable: true,
    })
    Object.defineProperty(prototype, 'difference', {
      value(this: Set<unknown>, other: ReadonlySetLikeShim | Iterable<unknown>): Set<unknown> {
        const result = new Set<unknown>()
        for (const value of this) if (!wrap(other).has(value)) result.add(value)
        return result
      },
      writable: true, configurable: true,
    })
    Object.defineProperty(prototype, 'symmetricDifference', {
      value(this: Set<unknown>, other: ReadonlySetLikeShim | Iterable<unknown>): Set<unknown> {
        const wrapped = wrap(other)
        const result = new Set<unknown>()
        for (const value of this) if (!wrapped.has(value)) result.add(value)
        for (const value of wrapped) if (!this.has(value)) result.add(value)
        return result
      },
      writable: true, configurable: true,
    })
  }
}

// The page realm installs before any PDF.js code path can run: runtime.ts
// imports this module for the side effect ahead of its first document.
installPdfCompat()

/**
 * The same shim set as plain JavaScript, prepended to the PDF worker's Blob
 * source by {@link ./runtime.ts}. Mirrors the installs above — MAP_SHIMS,
 * SET_SHIMS, and `Promise.try` define the shared surface; the compat spec
 * pins the two halves together.
 */
export const WORKER_COMPAT_SOURCE: string = `
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsert', { value: function (key, value) {
    if (this.has(key)) return this.get(key)
    this.set(key, value)
    return value
  }, writable: true, configurable: true })
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', { value: function (key, compute) {
    if (this.has(key)) return this.get(key)
    const computed = compute(key)
    this.set(key, computed)
    return computed
  }, writable: true, configurable: true })
}
if (typeof Promise.try !== 'function') {
  Promise.try = function (attempt) {
    try {
      const result = attempt(...Array.prototype.slice.call(arguments, 1))
      return (result && typeof result.then === 'function') ? result : Promise.resolve(result)
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
if (typeof Set.prototype.intersection !== 'function') {
  const wrap = function (other) { return other instanceof Set ? other : new Set(other) }
  Object.defineProperty(Set.prototype, 'intersection', { value: function (other) {
    const result = new Set()
    for (const value of this) if (wrap(other).has(value)) result.add(value)
    return result
  }, writable: true, configurable: true })
  Object.defineProperty(Set.prototype, 'union', { value: function (other) {
    const result = new Set(this)
    for (const value of wrap(other)) result.add(value)
    return result
  }, writable: true, configurable: true })
  Object.defineProperty(Set.prototype, 'difference', { value: function (other) {
    const result = new Set()
    for (const value of this) if (!wrap(other).has(value)) result.add(value)
    return result
  }, writable: true, configurable: true })
  Object.defineProperty(Set.prototype, 'symmetricDifference', { value: function (other) {
    const wrapped = wrap(other)
    const result = new Set()
    for (const value of this) if (!wrapped.has(value)) result.add(value)
    for (const value of wrapped) if (!this.has(value)) result.add(value)
    return result
  }, writable: true, configurable: true })
}
`

/** The shim surface this module and the worker source both define. */
export const PDF_COMPAT_SURFACE: readonly string[] = [
  ...MAP_SHIMS.map(name => `Map.prototype.${name}`),
  'Promise.try',
  ...SET_SHIMS.map(name => `Set.prototype.${name}`),
]
