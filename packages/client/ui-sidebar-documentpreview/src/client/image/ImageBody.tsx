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
const WHEEL_ZOOM_SENSITIVITY = 0.0025
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
 * Present complete image bytes fitted to the pane: the resting posture shows
 * the whole image centered on both axes (never upscaled past its natural
 * pixels). ⌘/Ctrl+wheel (the trackpad pinch gesture) zooms toward the pointer,
 * a drag pans while zoomed in, and a double-click toggles between fit and a
 * close-up — the badge reports the natural-pixel scale and resets on click.
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

/** The fitted posture plus the operator's zoom and pan on top of it. */
interface ZoomState {
  /** Display scale in natural pixels; 1 means one image pixel per CSS pixel. */
  readonly scale: number
  /** Translation from the fitted center, in CSS pixels. */
  readonly tx: number
  readonly ty: number
}

/**
 * The fitted, zoomable image: resting scale is the contain fit capped at one
 * natural pixel, and every gesture anchors the pixel under the pointer or
 * click so zooming reads as focusing on that detail.
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
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | undefined>()
  const [pane, setPane] = useState<{ readonly width: number; readonly height: number } | undefined>()
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, tx: 0, ty: 0 })
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ readonly x: number; readonly y: number; readonly tx: number; readonly ty: number } | undefined>()
  // The operator's own zoom outlives pane changes; without a gesture the
  // whole-image posture re-seats whenever the measured pane corrects itself.
  const userZoomed = useRef(false)

  const fitScale = useMemo(() => {
    if (natural === undefined || pane === undefined) return 1
    return Math.min(pane.width / natural.width, pane.height / natural.height, 1)
  }, [natural, pane])
  // The effective display scale never falls below the fit.
  const scale = Math.max(zoom.scale, fitScale)
  const atFit = zoom.scale <= fitScale && zoom.tx === 0 && zoom.ty === 0

  /** Refresh the fitted pane from the frame's current visible box. */
  const measurePane = useCallback((): void => {
    const element = frame.current
    if (element === null) return
    const next = visiblePaneOf(element)
    setPane(current =>
      current !== undefined && current.width === next.width && current.height === next.height
        ? current
        : next)
  }, [])

  // Live pane geometry: the observer tracks the frame, and the settle probes
  // (animation frame, late timer, window resize) re-measure because a
  // restored tab can mount before its container finishes laying out.
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const observer = new ResizeObserver(() => { measurePane() })
    observer.observe(element)
    measurePane()
    const settleFrame = requestAnimationFrame(() => { measurePane() })
    const settleTimer = window.setTimeout(() => { measurePane() }, 300)
    window.addEventListener('resize', measurePane)
    return () => {
      cancelAnimationFrame(settleFrame)
      window.clearTimeout(settleTimer)
      window.removeEventListener('resize', measurePane)
      observer.disconnect()
    }
  }, [measurePane])

  const reset = useCallback((): void => {
    userZoomed.current = false
    setZoom({ scale: fitScale, tx: 0, ty: 0 })
  }, [fitScale])

  // A new image, or a corrected pane while the operator has not zoomed,
  // re-seats the whole-image posture quietly.
  useEffect(() => {
    if (natural !== undefined && !userZoomed.current) reset()
  }, [natural?.width, natural?.height, pane, reset])

  /**
   * Zoom by a multiplicative factor while holding the pane-space anchor
   * fixed, then clamp the translation so the fitted edges never strand
   * blank space when the image overflows the pane.
   */
  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    // The live clamped box wins: a resize the observer has not delivered yet
    // must not anchor against the pane's previous shape. A degenerate read
    // (mid-teardown geometry) falls back to the last measured pane.
    const live = frame.current === null ? undefined : visiblePaneOf(frame.current)
    const paneShape = live !== undefined && live.width > 1 && live.height > 1 ? live : pane
    if (paneShape === undefined || natural === undefined) return
    if (factor > 1 || scale > fitScale) userZoomed.current = true
    setZoom((current) => {
      const from = Math.max(current.scale, fitScale)
      const next = Math.min(Math.max(from * factor, fitScale), ZOOM_MAX)
      if (next === from) return current
      // Anchor in pane space, relative to the pane's center; the fitted
      // image is centered, so the anchor's offset within the image scales
      // by the same factor.
      const cx = anchorX - paneShape.width / 2
      const cy = anchorY - paneShape.height / 2
      const tx = cx - (cx - current.tx) * (next / from)
      const ty = cy - (cy - current.ty) * (next / from)
      return {
        scale: next,
        tx: clampPan(tx, natural.width * next, paneShape.width),
        ty: clampPan(ty, natural.height * next, paneShape.height),
      }
    })
  }, [fitScale, natural, pane, scale])

  // The pinch gesture arrives as Ctrl+wheel in WebKit; ⌘+wheel joins it. The
  // factor follows the delta's magnitude, clamped per event.
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const factor = Math.min(
      Math.max(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), GESTURE_FACTOR_MIN),
      GESTURE_FACTOR_MAX,
    )
    const bounds = event.currentTarget.getBoundingClientRect()
    zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
  }, [zoomAt])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (scale > fitScale + Number.EPSILON) reset()
    else zoomAt(2, event.clientX - bounds.left, event.clientY - bounds.top)
  }, [fitScale, reset, scale, zoomAt])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || atFit) return
    // Pointer capture is best-effort: synthetic dispatchers (tests, AT) and
    // inactive pointers reject the request, and the drag works without it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* capture refused; the drag continues on shared handlers */ }
    drag.current = { x: event.clientX, y: event.clientY, tx: zoom.tx, ty: zoom.ty }
    setPanning(true)
  }, [atFit, zoom.tx, zoom.ty])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (held === undefined || frame.current === null) return
    const paneShape = visiblePaneOf(frame.current)
    if (natural === undefined) return
    setZoom(current => ({
      scale: Math.max(current.scale, fitScale),
      tx: clampPan(held.tx + (event.clientX - held.x), natural.width * Math.max(current.scale, fitScale), paneShape.width),
      ty: clampPan(held.ty + (event.clientY - held.y), natural.height * Math.max(current.scale, fitScale), paneShape.height),
    }))
  }, [fitScale, natural])

  const onPointerUp = useCallback((): void => {
    drag.current = undefined
    setPanning(false)
  }, [])

  const percent = Math.round(scale * 100)
  return (
    <div
      ref={frame}
      className={css.viewport}
      data-zoom-at-fit={atFit || undefined}
      data-panning={panning || undefined}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        className={css.image}
        src={url}
        alt={t('preview', { name })}
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
        hidden={!ready}
        style={{
          width: natural === undefined ? undefined : natural.width,
          height: natural === undefined ? undefined : natural.height,
          transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${scale})`,
        }}
        onLoad={(event) => {
          const target = event.currentTarget
          if (target.naturalWidth > 0 && target.naturalHeight > 0) {
            setNatural({ width: target.naturalWidth, height: target.naturalHeight })
          }
          onDecoded()
        }}
        onError={onFailed}
      />
      {ready && (
        <button type="button" className={css.badge} aria-label={t('zoomReset')} onClick={reset} disabled={atFit}>
          {t('zoomPercent', { percent })}
        </button>
      )}
    </div>
  )
}

/**
 * The pane the fit divides by: the frame's own box clamped to the visible
 * window region. Restored tabs and mid-settle layouts can leave the frame
 * taller than the window; dividing by that grown box strands the resting
 * posture above the true fit and crops the image. The window is the
 * outermost truth: the visible height is at most the window's bottom edge
 * below the frame's top.
 */
function visiblePaneOf(element: HTMLElement): { readonly width: number; readonly height: number } {
  const box = element.getBoundingClientRect()
  const height = Math.max(Math.min(element.clientHeight, window.innerHeight - Math.max(box.top, 0)), 1)
  const width = Math.max(Math.min(element.clientWidth, window.innerWidth - Math.max(box.left, 0)), 1)
  return { width, height }
}

/**
 * Keep a fitted-axis translation inside the image: free while the scaled
 * image is smaller than the pane (it stays centered anyway), otherwise the
 * edge may reach the pane's edge and no further.
 */
function clampPan(translate: number, scaled: number, pane: number): number {
  const slack = pane < scaled ? (scaled - pane) / 2 : 0
  return Math.min(Math.max(translate, -slack), slack)
}
