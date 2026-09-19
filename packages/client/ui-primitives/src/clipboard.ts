// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether the host accepted a write.

/** How long a desktop-bridge write waits for its ack before giving up. */
const DESKTOP_BRIDGE_TIMEOUT_MS = 2000

/**
 * Write text through the desktop host's native pasteboard, reached over the
 * preload bridge. WKWebView can deny the async Clipboard API — a key event's
 * user-activation token is not always honored — where the host's own write has
 * no such gate. The nonce matches the ack the host dispatches back into the
 * page, so the boolean stays honest.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host acknowledged the write.
 */
function writeViaDesktopBridge(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const desktop = (globalThis as { __electrobunSendToHost?: (message: string) => void })
      .__electrobunSendToHost
    if (desktop === undefined) {
      resolve(false)
      return
    }
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const onAck = (event: Event): void => {
      const detail = (event as CustomEvent<{ nonce?: string; ok?: boolean }>).detail
      if (detail.nonce !== nonce) return
      cleanup()
      resolve(detail.ok === true)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, DESKTOP_BRIDGE_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      window.removeEventListener('dsh:clipboard-written', onAck)
    }
    window.addEventListener('dsh:clipboard-written', onAck)
    desktop(JSON.stringify({ kind: 'clipboard-write', text, nonce }))
  })
}

/**
 * Write text to the host clipboard, preferring the async Clipboard API and
 * falling back to the desktop bridge and `execCommand('copy')` on hosts that
 * omit or deny it.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied permissions / iframe policy — the desktop bridge and the
      // command path below are still better than claiming failure.
    }
  }
  if (await writeViaDesktopBridge(text)) return true
  // jsdom and older hosts: best-effort execCommand path when present.
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
  /* oxlint-enable typescript/no-deprecated */
}
