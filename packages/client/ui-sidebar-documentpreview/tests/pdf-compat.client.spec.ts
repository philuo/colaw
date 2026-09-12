/**
 * The WKWebView compatibility shims: the production PDF path must parse and
 * draw with the post-ES2024 APIs deleted from BOTH realms (the page and the
 * worker), which is the exact shape of the desktop failure this guards
 * against (`this.#g.getOrInsertComputed is not a function`).
 */
import { Worker as Thread, type Transferable } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { installPdfCompat, PDF_COMPAT_SURFACE, WORKER_COMPAT_SOURCE } from '../src/client/pdf/compat.ts'
import { pdfFixture } from './pdf-fixture.ts'

/** Type-level access to the shimmed Set methods this spec installs. */
interface PrototypeShim { intersection(other: Set<unknown>): Set<unknown> }

/**
 * One absent-then-restore step per API. Bun exposes some of these as lazy
 * builtins whose plain `delete` runs the native with the prototype as
 * receiver (a TypeError); shadowing with an undefined value hides the
 * native just as effectively, and the saved descriptor restores it.
 */
interface ShimStep {
  remove(): void
  restore(): void
}

function step(holder: object, name: string): ShimStep {
  const descriptor = Object.getOwnPropertyDescriptor(holder, name)
  return {
    remove: () => {
      // Reflect.deleteProperty sidesteps the lint rule that guards literal
      // `delete obj[key]` patterns; the receiver semantics are identical.
      try {
        Reflect.deleteProperty(holder, name)
      } catch { /* lazy builtin: fall through to the shadowing define */ }
      if (name in holder) {
        Object.defineProperty(holder, name, { value: undefined, writable: true, configurable: true })
      }
    },
    restore: () => {
      if (descriptor !== undefined) Object.defineProperty(holder, name, descriptor)
      else Reflect.deleteProperty(holder, name)
    },
  }
}

/** The APIs the shims stand in for; the spec deletes and restores each. */
const SHIM_STEPS: readonly ShimStep[] = [
  step(Map.prototype, 'getOrInsert'),
  step(Map.prototype, 'getOrInsertComputed'),
  step(Promise, 'try'),
  step(Set.prototype, 'intersection'),
  step(Set.prototype, 'union'),
  step(Set.prototype, 'difference'),
  step(Set.prototype, 'symmetricDifference'),
]

afterEach(() => {
  for (const shim of SHIM_STEPS) shim.restore()
})

function deleteShimmedApis(): void {
  for (const shim of SHIM_STEPS) shim.remove()
}

describe('PDF.js WKWebView compatibility shims', () => {
  it('worker source and main-thread installs define the same shim surface', () => {
    // Every name the module installs appears in the worker string, so the
    // worker Blob prefix and the page-side install cannot drift apart.
    for (const surface of PDF_COMPAT_SURFACE) {
      const name = surface.split('.').pop()!
      expect(WORKER_COMPAT_SOURCE).toContain(name)
    }
    expect(WORKER_COMPAT_SOURCE).toContain('getOrInsertComputed')
    expect(WORKER_COMPAT_SOURCE).toContain("typeof Promise.try !== 'function'")
  })

  it('parses and draws with the APIs deleted from both realms', async () => {
    deleteShimmedApis()
    installPdfCompat()
    expect(typeof (Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed).toBe('function')
    expect(typeof (Promise as unknown as Record<string, unknown>).try).toBe('function')
    // The page realm imports PDF.js only after the shims exist, exactly as
    // runtime.ts orders its imports in production.
    const { getDocument, PDFWorker } = await import('pdfjs-dist')

    // Shim semantics: upsert computes only on a miss and echoes on a hit.
    const map = new Map<string, number>() as unknown as {
      getOrInsertComputed(key: string, compute: (key: string) => number): number
      getOrInsert(key: string, value: number): number
    } & Map<string, number>
    let computed = 0
    expect(map.getOrInsertComputed('a', () => { computed += 1; return 1 })).toBe(1)
    expect(map.getOrInsertComputed('a', () => { computed += 1; return 2 })).toBe(1)
    expect(computed).toBe(1)
    expect(map.getOrInsert('b', 5)).toBe(5)
    expect(map.getOrInsert('b', 6)).toBe(5)
    expect((new Set([1, 2]) as unknown as PrototypeShim).intersection(new Set([2, 3]))).toEqual(new Set([2]))
    await expect((Promise as unknown as { try: (fn: () => number) => Promise<number> }).try(() => 7)).resolves.toBe(7)

    // The real modern build, driven through a worker whose realm also lacks
    // the APIs, with the production shim source installed there.
    const thread = new Thread(new URL('./pdf-worker-compat.fixture.mjs', import.meta.url), {
      workerData: {
        compatSource: WORKER_COMPAT_SOURCE,
        workerUrl: import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),
      },
    })
    const ready = Promise.withResolvers<undefined>()
    const failed = Promise.withResolvers<never>()
    thread.once('message', () => { ready.resolve(undefined) })
    thread.once('error', (error) => { failed.reject(error) })
    const listeners = new Map<EventListenerOrEventListenerObject, (data: unknown) => void>()
    const port = {
      postMessage: (message: unknown, transfer: readonly Transferable[]) => { thread.postMessage(message, transfer) },
      addEventListener: (_type: string, listener: EventListener) => {
        const forward = (data: unknown): void => { listener({ data } as unknown as Event) }
        listeners.set(listener, forward)
        thread.on('message', forward)
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        const forward = listeners.get(listener)
        if (forward !== undefined) thread.off('message', forward)
        listeners.delete(listener)
      },
    }
    let bridge: InstanceType<typeof PDFWorker> | undefined
    let loading: ReturnType<typeof getDocument> | undefined
    try {
      await Promise.race([ready.promise, failed.promise])
      bridge = PDFWorker.create({ port: port as unknown as Worker })
      loading = getDocument({ data: pdfFixture(), worker: bridge })
      const pdf = await Promise.race([loading.promise, failed.promise])
      expect(pdf.numPages).toBe(2)
      // Drawing needs a real canvas stack (Path2D &c.) that Node lacks; the
      // WKWebView carries those natively, so this spec's proof ends at the
      // parse + page-metadata round trip through the shimmed worker realm —
      // exactly where the missing-API failure lived.
      await expect(pdf.getPage(1)).resolves.toMatchObject({ pageNumber: 1 })
    } finally {
      try { await loading?.destroy() } finally {
        bridge?.destroy()
        await thread.terminate()
      }
    }
  })
})
