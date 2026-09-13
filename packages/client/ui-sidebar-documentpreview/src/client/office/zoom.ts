/**
 * The ⌘/Ctrl+wheel zoom gesture shared by the PDF and Office bodies.
 *
 * Two mechanical shapes live here. `createWheelZoom` coalesces a wheel stream
 * into one applied scale per animation frame — the image preview's continuous
 * exponential curve, never more than one expensive relayout per frame. The
 * Office variant layers a transform preview on top: during a gesture the
 * viewer's surface is scaled visually (a GPU transform, no layout), and the
 * real `setScale` lands once, 160ms after the last event, with the cursor
 * anchor restored — the gesture reads smoothly while the settle lands crisp.
 */

/** Wheel zoom grows with the gesture's pixel magnitude, identical to the image preview. */
const WHEEL_ZOOM_SENSITIVITY = 0.007
/** Per-event factor bounds, so one malformed delta cannot leap the view. */
export const GESTURE_FACTOR_MIN = 0.5
export const GESTURE_FACTOR_MAX = 2
/** A gesture settles this long after its last event. */
export const GESTURE_SETTLE_MS = 160

export interface WheelZoomOptions {
  readonly min: number
  readonly max: number
  readonly getScale: () => number
  /** Apply one settled scale; the anchor is the last gesture cursor point. */
  readonly apply: (scale: number, origin: { readonly x: number; readonly y: number }) => void
  /**
   * Optional visual-only preview during a gesture, when applying per frame is
   * too costly. `base` is the scale the preview transforms away from; the
   * settle commit must return the real view to `target`.
   */
  readonly preview?: (base: number, target: number, origin: { readonly x: number; readonly y: number }) => void
  readonly endPreview?: () => void
}

export interface WheelZoomBinding {
  readonly dispose: () => void
}

/**
 * Bind the pinch-zoom wheel handler to one element, capture phase.
 * @param element - the gesture surface (an ancestor of the viewer's own listeners).
 * @param options - scale bounds, the apply seam, and the optional preview seam.
 * @returns the binding; disposing removes the listener and pending frames.
 */
export function createWheelZoom(element: HTMLElement, options: WheelZoomOptions): WheelZoomBinding {
  let frame = 0
  let target = 0
  let base = 0
  let origin: { readonly x: number; readonly y: number } | undefined
  let lastEvent: WheelEvent | undefined
  let settle = 0

  const applyNow = (): void => {
    frame = 0
    const at = lastEvent
    lastEvent = undefined
    if (at === undefined) return
    const rect = element.getBoundingClientRect()
    options.apply(clampScale(target, options.min, options.max), {
      x: at.clientX - rect.left,
      y: at.clientY - rect.top,
    })
  }

  const listener = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const factor = Math.min(GESTURE_FACTOR_MAX, Math.max(
      GESTURE_FACTOR_MIN,
      Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
    ))
    if (target === 0) {
      base = options.getScale()
      target = clampScale(base * factor, options.min, options.max)
    } else {
      target = clampScale(target * factor, options.min, options.max)
    }
    const rect = element.getBoundingClientRect()
    origin = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    lastEvent = event
    if (options.preview !== undefined) {
      options.preview(base, target, origin)
      clearTimeout(settle)
      settle = setTimeout(() => {
        options.endPreview?.()
        applyNow()
      }, GESTURE_SETTLE_MS)
      return
    }
    if (frame === 0) frame = requestAnimationFrame(applyNow)
  }

  element.addEventListener('wheel', listener, { capture: true, passive: false })
  return {
    dispose: () => {
      element.removeEventListener('wheel', listener, { capture: true })
      if (frame !== 0) cancelAnimationFrame(frame)
      clearTimeout(settle)
    },
  }
}

function clampScale(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
