// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from '../src/clipboard.ts'

type SendToHost = (message: string) => void

/** The desktop preload bridge global, absent in plain browsers and jsdom. */
function installBridge(send: SendToHost): void {
  ;(globalThis as { __electrobunSendToHost?: SendToHost }).__electrobunSendToHost = send
}

/** jsdom ships no execCommand at all; define the stub the copy path probes. */
function stubExecCommand(run: () => boolean): void {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: run })
}

afterEach(() => {
  delete (globalThis as { __electrobunSendToHost?: SendToHost }).__electrobunSendToHost
  delete (document as { execCommand?: unknown }).execCommand
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('writeClipboard', () => {
  it('uses the async Clipboard API when the host accepts it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const send = vi.fn()
    installBridge(send)

    await expect(writeClipboard('via-api')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('via-api')
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to the desktop bridge when the async API is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    installBridge((message) => {
      const parsed = JSON.parse(message) as { kind: string; text: string; nonce: string }
      window.dispatchEvent(new CustomEvent('dsh:clipboard-written', {
        detail: { nonce: parsed.nonce, ok: true },
      }))
    })

    await expect(writeClipboard('via-bridge')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('via-bridge')
  })

  it('ignores bridge acks for other nonces', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    stubExecCommand(() => { throw new Error('unsupported') })
    installBridge(() => {
      window.dispatchEvent(new CustomEvent('dsh:clipboard-written', {
        detail: { nonce: 'someone-else', ok: true },
      }))
    })

    await expect(writeClipboard('orphan')).resolves.toBe(false)
  })

  it('gives up on the bridge after its ack timeout', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    stubExecCommand(() => { throw new Error('unsupported') })
    installBridge(() => {})

    const pending = writeClipboard('never-acked')
    const settled = await Promise.race([pending.then(() => true), vi.advanceTimersByTimeAsync(1999).then(() => false)])
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(pending).resolves.toBe(false)
  })

  it('ignores a bridge ack that reports failure', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    stubExecCommand(() => { throw new Error('unsupported') })
    installBridge((message) => {
      const parsed = JSON.parse(message) as { nonce: string }
      window.dispatchEvent(new CustomEvent('dsh:clipboard-written', {
        detail: { nonce: parsed.nonce, ok: false },
      }))
    })

    await expect(writeClipboard('host-failed')).resolves.toBe(false)
  })

  it('keeps the execCommand path for hosts without either clipboard API', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} })
    const exec = vi.fn(() => true)
    stubExecCommand(exec)

    await expect(writeClipboard('via-command')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })
})
