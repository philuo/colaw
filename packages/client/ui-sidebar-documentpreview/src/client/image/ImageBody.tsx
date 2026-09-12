/** Complete image bytes, fitted to the pane by default with focus-driven zoom. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import type {} from './locales.ts'
import css from './ImageBody.module.css'

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
} as const

type ImageMediaType = typeof IMAGE_MEDIA_TYPES[keyof typeof IMAGE_MEDIA_TYPES]

/** Standard document props plus the image renderer's dictionary. */
export type ImageBodyProps = DocumentPreviewProps & PropsLocale<'sidebarImage'>

type ImageSource =
  | {
    readonly kind: 'ready'
    readonly data: Uint8Array<ArrayBuffer>
    readonly mediaType: ImageMediaType
    readonly url: string
  }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: ImageMediaType }

/** Wheel zoom grows with the gesture's pixel magnitude, like Preview: a
 * notch is a comfortable step while a trackpad pinch's rapid small deltas
 * compose into one smooth continuous zoom instead of a per-event jump. */
const WHEEL_ZOOM_SENSITIVITY = 0.003
/** Per-event factor bounds, so one malformed delta cannot leap the view. */
const GESTURE_FACTOR_MIN = 0.5
const GESTURE_FACTOR_MAX = 2
/** The farthest scale, in natural pixels, the viewer allows. */
const ZOOM_MAX = 8

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the image media type, or undefined for an unregistered suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const extension = name.slice(name.lastIndexOf('.') + 1) as keyof typeof IMAGE_MEDIA_TYPES
  return IMAGE_MEDIA_TYPES[extension]
}

/**
 * Present complete image bytes: the resting posture is CSS containment — the
 * whole image centered and complete, never thinner than half the pane (a
 * width-floored tall image pans with wheel or drag like a scrollable
 * document). ⌘/Ctrl+wheel (the trackpad pinch gesture) zooms toward the
 * pointer with a factor proportional to the gesture, a double-click toggles
 * fit ↔ 2×, and the badge reports the natural-pixel scale and resets on
 * click.
 * @param props - document bytes, resource identity, and locale.
 * @returns the fitted, zoomable image surface.
 */
export function ImageBody({ content, resourceAddress, t }: ImageBodyProps): ReactNode {
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const mediaType = imageMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<ImageSource>()

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, mediaType, url })
    } catch {
      setSource({ kind: 'failed', data, mediaType })
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data || source.mediaType !== mediaType) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  if (source.kind === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(path)
  return <LoadedImage key={source.url} url={source.url} name={name} t={t} />
}

/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, t }: {
  readonly url: string
  readonly name: string
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  return (
    <div className={css.frame} data-image-preview>
      {state === 'loading' && <LoadingIndicator className={css.status} label={t('loading')} />}
      {state === 'failed' && <p className={css.status} role="alert">{t('failed')}</p>}
      {state !== 'failed' && (
        <ZoomableImage url={url} name={name} ready={state === 'ready'} onDecoded={() => { setState('ready') }} onFailed={() => { setState('failed') }} t={t} />
      )}
    </div>
  )
}

/** The operator's zoom and pan on top of the CSS-fitted posture. */
interface ZoomState {
  /** Multiplier over the browser's contain fit; 1 is exactly the whole image. */
  readonly k: number
  /** Translation from the fitted center, in CSS pixels. */
  readonly tx: number
  readonly ty: number
}

/**
 * The fitted, zoomable image. The resting posture is pure CSS containment
 * (`max-width/max-height: 100%` in a bounded, absolutely filled viewport), so
 * the whole image is centered and complete by construction — no measured
 * "fit scale" can strand it cropped, whatever the surrounding layout does
 * during tab restoration or pane transitions. Zoom is a transform on top:
 * ⌘/Ctrl+wheel anchors the pixel under the pointer, a drag pans with edge
 * clamping, a double-click toggles fit ↔ 2×, and the floor k = 1 is exactly
 * the complete view, so zooming out always lands back on the whole image.
 */
function ZoomableImage({ url, name, ready, onDecoded, onFailed, t }: {
  readonly url: string
  readonly name: string
  readonly ready: boolean
  readonly onDecoded: () => void
  readonly onFailed: () => void
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const frame = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState<ZoomState>({ k: 1, tx: 0, ty: 0 })
  const [panning, setPanning] = useState(false)
  const [percent, setPercent] = useState<number | undefined>()
  const [pannable, setPannable] = useState(false)
  const drag = useRef<{ readonly x: number; readonly y: number; readonly tx: number; readonly ty: number } | undefined>()

  const atFit = zoom.k <= 1 && zoom.tx === 0 && zoom.ty === 0

  /**
   * Whether the displayed image extends past the viewport on either axis —
   * the pan affordance covers a width-floored tall image at rest (its height
   * overflows the pane by design) just as it covers an explicit zoom.
   */
  const overflowsPane = useCallback((box?: DOMRect): boolean => {
    const viewport = frame.current
    const img = image.current
    if (viewport === null || img === null) return false
    const rect = box ?? img.getBoundingClientRect()
    return rect.width > viewport.clientWidth + 1 || rect.height > viewport.clientHeight + 1
  }, [])

  /** Report the displayed box's natural-pixel scale and pan affordance. */
  const refreshMetrics = useCallback((): void => {
    const img = image.current
    if (img === null) return
    const box = img.getBoundingClientRect()
    if (box.width > 0 && img.naturalWidth > 0) setPercent(Math.round((box.width / img.naturalWidth) * 100))
    setPannable(overflowsPane(box))
  }, [overflowsPane])

  // The resize observer never drives the resting posture (CSS owns it); it
  // refreshes the badge and re-clamps a zoom's translation to the new pane.
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const observer = new ResizeObserver(() => {
      refreshMetrics()
      setZoom((current) => {
        if (current.k <= 1) return current
        const img = image.current
        const paneShape = element.clientWidth > 0 ? element : undefined
        if (img === null || paneShape === undefined) return current
        const box = img.getBoundingClientRect()
        return {
          ...current,
          tx: clampPan(current.tx, box.width, paneShape.clientWidth),
          ty: clampPan(current.ty, box.height, paneShape.clientHeight),
        }
      })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [refreshMetrics])

  // The badge follows the fitted box once it exists and after every zoom.
  useEffect(() => {
    refreshMetrics()
  }, [refreshMetrics, zoom.k, ready])

  const reset = useCallback((): void => {
    setZoom({ k: 1, tx: 0, ty: 0 })
  }, [])

  /**
   * Zoom by a multiplicative factor over the contain fit while holding the
   * pane-space anchor fixed, then clamp the translation so the fitted edges
   * never strand blank space when the image overflows the pane. The browser's
   * fitted box (displayed rect divided by the current multiplier) is read
   * live, so no separately measured pane state can disagree with the layout.
   */
  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    const viewport = frame.current
    const img = image.current
    if (viewport === null || img === null || viewport.clientWidth <= 0) return
    const paneWidth = viewport.clientWidth
    const paneHeight = viewport.clientHeight
    const displayed = img.getBoundingClientRect()
    setZoom((current) => {
      const from = Math.max(current.k, 1)
      const next = Math.min(Math.max(from * factor, 1), ZOOM_MAX)
      if (next === from || displayed.width <= 0) return current
      // Anchor in pane space, relative to the pane's center; the fitted
      // image is centered, so the anchor's offset scales by the same factor.
      const cx = anchorX - paneWidth / 2
      const cy = anchorY - paneHeight / 2
      const tx = cx - (cx - current.tx) * (next / from)
      const ty = cy - (cy - current.ty) * (next / from)
      const fittedWidth = displayed.width / from
      const fittedHeight = displayed.height / from
      return {
        k: next,
        tx: clampPan(tx, fittedWidth * next, paneWidth),
        ty: clampPan(ty, fittedHeight * next, paneHeight),
      }
    })
  }, [])

  /**
   * Pan by wheel deltas (the natural trackpad scroll) while the image
   * extends past the viewport, so a width-floored tall screenshot reads like
   * an ordinary scrollable document at rest.
   */
  const panBy = useCallback((dx: number, dy: number): void => {
    const viewport = frame.current
    const img = image.current
    if (viewport === null || img === null) return
    const box = img.getBoundingClientRect()
    if (!overflowsPane(box)) return
    setZoom(current => ({
      ...current,
      tx: clampPan(current.tx - dx, box.width, viewport.clientWidth),
      ty: clampPan(current.ty - dy, box.height, viewport.clientHeight),
    }))
  }, [overflowsPane])

  // Ctrl/⌘+wheel (the trackpad pinch) zooms toward the pointer with a factor
  // that follows the delta's magnitude; a plain wheel scrolls an overflowing
  // image and leaves a contained one to the shared body.
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const factor = Math.min(
        Math.max(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), GESTURE_FACTOR_MIN),
        GESTURE_FACTOR_MAX,
      )
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
      return
    }
    if (overflowsPane()) event.preventDefault()
    panBy(event.deltaX, event.deltaY)
  }, [overflowsPane, panBy, zoomAt])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (zoom.k > 1 + Number.EPSILON) reset()
    else {
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(2, event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }, [reset, zoom.k, zoomAt])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !overflowsPane()) return
    // Pointer capture is best-effort: synthetic dispatchers (tests, AT) and
    // inactive pointers reject the request, and the drag works without it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* capture refused; the drag continues on shared handlers */ }
    drag.current = { x: event.clientX, y: event.clientY, tx: zoom.tx, ty: zoom.ty }
    setPanning(true)
  }, [overflowsPane, zoom.tx, zoom.ty])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const viewport = frame.current
    const img = image.current
    if (held === undefined || viewport === null || img === null) return
    const paneWidth = viewport.clientWidth
    const paneHeight = viewport.clientHeight
    const box = img.getBoundingClientRect()
    setZoom(current => ({
      ...current,
      tx: clampPan(held.tx + (event.clientX - held.x), box.width, paneWidth),
      ty: clampPan(held.ty + (event.clientY - held.y), box.height, paneHeight),
    }))
  }, [])

  const onPointerUp = useCallback((): void => {
    drag.current = undefined
    setPanning(false)
  }, [])

  return (
    <div
      ref={frame}
      className={css.viewport}
      data-zoom-at-fit={atFit || undefined}
      data-pannable={pannable || undefined}
      data-panning={panning || undefined}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        ref={image}
        className={css.image}
        src={url}
        alt={t('preview', { name })}
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
        hidden={!ready}
        style={{ transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${Math.max(zoom.k, 1)})` }}
        onLoad={onDecoded}
        onError={onFailed}
      />
      {ready && percent !== undefined && (
        <button type="button" className={css.badge} aria-label={t('zoomReset')} onClick={reset} disabled={atFit}>
          {t('zoomPercent', { percent })}
        </button>
      )}
    </div>
  )
}

/**
 * Keep a fitted-axis translation inside the image: free while the scaled
 * image is smaller than the pane (it stays centered anyway), otherwise the
 * edge may reach the pane's edge and no further. `scaled` is the displayed
 * (already transformed) axis length.
 */
function clampPan(translate: number, scaled: number, pane: number): number {
  const slack = pane < scaled ? (scaled - pane) / 2 : 0
  return Math.min(Math.max(translate, -slack), slack)
}
