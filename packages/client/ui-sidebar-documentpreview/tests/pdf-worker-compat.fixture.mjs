/**
 * Real worker-thread carrier for the installed PDF.js worker, in a realm that
 * lacks the post-ES2024 APIs older WKWebView builds miss. The shim source is
 * the exact string runtime.ts prepends to the production worker Blob
 * (WORKER_COMPAT_SOURCE from pdf/compat.ts), so this fixture reproduces the
 * desktop's worker realm end to end.
 */
import { parentPort, workerData } from 'node:worker_threads'

// Bun exposes some of these as lazy builtins whose plain `delete` runs the
// underlying native with the prototype as receiver (a TypeError); shadowing
// with an undefined value hides the native just as effectively.
const absent = (holder, name) => {
  try {
    delete holder[name]
  } catch { /* lazy builtin: fall through to the shadowing define */ }
  if (name in holder) {
    Object.defineProperty(holder, name, { value: undefined, writable: true, configurable: true })
  }
}
absent(Map.prototype, 'getOrInsert')
absent(Map.prototype, 'getOrInsertComputed')
absent(Promise, 'try')
absent(Set.prototype, 'intersection')
absent(Set.prototype, 'union')
absent(Set.prototype, 'difference')
absent(Set.prototype, 'symmetricDifference')

// The string is the module-adjacent shim constant, not dynamic input.
;(0, eval)(workerData.compatSource) // eslint-disable-line no-eval

const listeners = new Map()
const port = {
  postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
  addEventListener: (_type, listener) => {
    const forward = data => listener({ data })
    listeners.set(listener, forward)
    parentPort.on('message', forward)
  },
  removeEventListener: (_type, listener) => {
    const forward = listeners.get(listener)
    if (forward !== undefined) parentPort.off('message', forward)
    listeners.delete(listener)
  },
}
const { WorkerMessageHandler } = await import(workerData.workerUrl)
WorkerMessageHandler.initializeFromPort(port)
