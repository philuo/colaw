/**
 * The one way a URL leaves the app: in the desktop shell the bridge hands it
 * to the host, which enforces the http(s) allowlist and opens the default
 * browser; in a plain browser the window opens a tab. Every surface that
 * turns URL-shaped text into a link (markdown anchors, user bubbles, code
 * blocks) routes through this — one seam, one policy.
 * @param url - The absolute http(s) URL to open.
 */
export function openExternal(url: string): void {
  const desktop = (globalThis as { __electrobunSendToHost?: (message: string) => void }).__electrobunSendToHost
  if (desktop !== undefined) {
    desktop(JSON.stringify({ kind: 'open-url', url }))
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Copy one URL — the right-click affordance every link surface shares. */
export function copyExternal(url: string): void {
  void navigator.clipboard?.writeText(url)
}
