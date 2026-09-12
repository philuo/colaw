/** Complete image bytes, fitted to the pane by default with focus-driven zoom. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { createResampleScheduler } from '../resample.ts'
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
const WHEEL_ZOOM_SENSITIVITY = 0.007
/** Per-event factor bounds, so one malformed delta cannot leap the view. */
const GESTURE_FACTOR_MIN = 0.5
const GESTURE_FACTOR_MAX = 2
/** A gesture stream commits to React state after this idle, so no render
 * ever sits between a pointermove/wheel event and the compositor. */
const GESTURE_COMMIT_MS = 160
/** A silent recognition answer is dropped past this window. */
const OCR_RESPONSE_TIMEOUT_MS = 35_000

/** One recognized text block; normalized [0,1], top-left origin. */
interface OcrItem {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Recognized text by file path. Recognition is silent and automatic (no user
 * action, WeChat-style), so re-opening an image must not pay for it twice.
 */
const ocrCache = new Map<string, readonly OcrItem[]>()
/** Cache stays small: a preview session touches a handful of images. */
const OCR_CACHE_LIMIT = 24

/** The farthest scale, in natural pixels, the viewer allows. */
const ZOOM_MAX = 8
/**
 * Beyond this many device pixels on the displayed longer axis, a transform-
 * scaled <img> layer exceeds WebKit's raster budget and clamps — the
 * permanently-blurry regime. The viewer then switches to a viewport-sized
 * canvas that samples the visible region at display resolution instead
 * (Preview.app's deep-zoom approach): the backing store stays pane-sized,
 * so any zoom level renders sharp.
 */
const CANVAS_LAYER_BUDGET = 4096

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
export function ImageBody({ content, resourceAddress, sessionId, t }: ImageBodyProps): ReactNode {
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
  return <LoadedImage key={source.url} url={source.url} name={name} path={path} sessionId={sessionId} t={t} />
}

/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, path, sessionId, t }: {
  readonly url: string
  readonly name: string
  readonly path: string
  readonly sessionId: ImageBodyProps['sessionId']
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  return (
    <div className={css.frame} data-image-preview>
      {state === 'loading' && <LoadingIndicator className={css.status} label={t('loading')} />}
      {state === 'failed' && <p className={css.status} role="alert">{t('failed')}</p>}
      {state !== 'failed' && (
        <ZoomableImage url={url} name={name} path={path} sessionId={sessionId} ready={state === 'ready'} onDecoded={() => { setState('ready') }} onFailed={() => { setState('failed') }} t={t} />
      )}
    </div>
  )
}

/** The operator's zoom and pan on top of the contained posture. */
interface ZoomState {
  /** Multiplier over the containment; 1 is exactly the whole image. */
  readonly k: number
  /** Translation from the fitted center, in CSS pixels. */
  readonly tx: number
  readonly ty: number
}

/** The image's contained size and scale inside a pane, by pure aspect math. */
interface ContainedShape {
  readonly width: number
  readonly height: number
  readonly scale: number
}

/**
 * Containment arithmetic: the largest box with the image's aspect that fits
 * the pane. The element's inline box IS this size (layout-sized, never
 * object-fit — WebKit's object-fit drawing path rasterizes large bitmaps at
 * reduced quality on Retina), and the zoom math derives from it directly,
 * so the box and the math can never disagree.
 */
function containedIn(natural: { width: number; height: number }, pane: { width: number; height: number }): ContainedShape {
  const scale = Math.min(pane.width / natural.width, pane.height / natural.height, 1)
  return { width: natural.width * scale, height: natural.height * scale, scale }
}

/**
 * The fitted, zoomable image. The resting posture is a layout-sized element
 * at exactly the contained size: the whole image is centered, complete, and
 * proportion-exact by construction — a sidebar resize re-contains it without
 * ever stretching, and no measured "fit scale" exists that a mid-settle
 * layout could corrupt. Rendering goes through the browser's native image
 * path, so it stays sharp on Retina. No transform is applied at rest. Zoom
 * is a transform on top: ⌘/Ctrl+wheel anchors the pixel under the pointer,
 * a drag pans with edge clamping, a double-click toggles fit ↔ 2×, and the
 * floor k = 1 is exactly the complete view, so zooming out always lands back
 * on the whole image.
 */
function ZoomableImage({ url, name, path, sessionId, ready, onDecoded, onFailed, t }: {
  readonly url: string
  readonly name: string
  readonly path: string
  readonly sessionId: ImageBodyProps['sessionId']
  readonly ready: boolean
  readonly onDecoded: () => void
  readonly onFailed: () => void
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const frame = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const deepCanvas = useRef<HTMLCanvasElement | null>(null)
  const annotations = useRef<HTMLDivElement | null>(null)
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | undefined>()
  const [zoom, setZoom] = useState<ZoomState>({ k: 1, tx: 0, ty: 0 })
  const [panning, setPanning] = useState(false)
  const [shape, setShape] = useState<{ readonly pane: { readonly width: number; readonly height: number } } | undefined>()
  const drag = useRef<{ readonly x: number; readonly y: number; readonly tx: number; readonly ty: number } | undefined>()
  // The in-flight gesture accumulator: while it exists, the element's
  // transform is written straight to the DOM and React renders nothing.
  const live = useRef<ZoomState | undefined>(undefined)
  const settle = useRef<number | undefined>(undefined)
  // The deep-zoom draw's latest state and its rAF gate.
  const deepPending = useRef<ZoomState | undefined>(undefined)
  const deepFrame = useRef<number | undefined>(undefined)
  // Silent on-image text recognition (Apple Vision, host-side): recognized
  // blocks become an invisible selectable text layer over the image, so the
  // operator can select and copy image text like any document — no button,
  // no dialog, no visible chrome.
  const [ocrItems, setOcrItems] = useState<readonly OcrItem[] | undefined>(undefined)
  const ocrRequest = useRef<string | undefined>(undefined)
  const ocrTimer = useRef<number | undefined>(undefined)
  const sendHost = (globalThis as { __electrobunSendToHost?: (message: unknown) => void }).__electrobunSendToHost
  const canOcr = typeof sendHost === 'function'

  const atFit = zoom.k <= 1 && zoom.tx === 0 && zoom.ty === 0
  const contained = natural === undefined || shape === undefined
    ? undefined
    : containedIn(natural, shape.pane)
  const k = Math.max(zoom.k, 1)
  const percent = contained === undefined ? undefined : Math.round(contained.scale * k * 100)
  const scaled = contained === undefined ? undefined : { width: contained.width * k, height: contained.height * k }
  const pannable = scaled !== undefined && shape !== undefined
    && (scaled.width > shape.pane.width + 1 || scaled.height > shape.pane.height + 1)

  /**
   * Whether this zoom level outgrows a transform-scaled layer: past the
   * raster budget WebKit clamps the layer texture and the image stays
   * blurry no matter how long the gesture rests.
   */
  const exceedsLayerBudget = useCallback((value: ZoomState, box: ContainedShape): boolean => {
    const longest = Math.max(box.width, box.height) * Math.max(value.k, 1)
    return longest * Math.max(window.devicePixelRatio, 1) > CANVAS_LAYER_BUDGET
  }, [])

  /**
   * The deep-zoom draw: the whole bitmap, positioned exactly as the
   * transform would place it, rasterized into a pane-sized canvas. The GPU
   * clips to the canvas and samples only the visible region at display
   * resolution, so the backing store never exceeds the pane while every
   * zoom level renders sharp. Coalesced to one draw per animation frame.
   */
  const drawDeep = useCallback((value: ZoomState): void => {
    const source = image.current
    const canvas = deepCanvas.current
    const viewport = frame.current
    if (source === null || canvas === null || viewport === null || contained === undefined || natural === undefined) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const ratio = Math.max(window.devicePixelRatio, 1)
    const width = viewport.clientWidth
    const height = viewport.clientHeight
    if (width <= 0 || height <= 0) return
    const backingWidth = Math.round(width * ratio)
    const backingHeight = Math.round(height * ratio)
    if (canvas.width !== backingWidth) canvas.width = backingWidth
    if (canvas.height !== backingHeight) canvas.height = backingHeight
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, width, height)
    const kk = Math.max(value.k, 1)
    const drawnWidth = contained.width * kk
    const drawnHeight = contained.height * kk
    context.drawImage(source,
      0, 0, natural.width, natural.height,
      (width - drawnWidth) / 2 + value.tx,
      (height - drawnHeight) / 2 + value.ty,
      drawnWidth, drawnHeight)
  }, [contained, natural])

  const scheduleDeepDraw = useCallback((value: ZoomState): void => {
    deepPending.current = value
    if (deepFrame.current !== undefined) return
    deepFrame.current = requestAnimationFrame(() => {
      deepFrame.current = undefined
      const pending = deepPending.current
      if (pending !== undefined) drawDeep(pending)
    })
  }, [drawDeep])

  /**
   * Write one element's zoom posture: the gesture transform (will-change
   * riding the in-flight gesture only, re-rasterized sharp at rest) shared
   * by the <img> and the annotation overlay so boxes track pixels exactly.
   */
  const applyTransform = (el: HTMLElement, value: ZoomState, promoting: boolean): void => {
    if (value.k <= 1 && value.tx === 0 && value.ty === 0) {
      el.style.removeProperty('will-change')
      el.style.removeProperty('transform')
      return
    }
    if (promoting) el.style.setProperty('will-change', 'transform')
    else el.style.removeProperty('will-change')
    el.style.setProperty('transform', `translate(${value.tx}px, ${value.ty}px) scale(${Math.max(value.k, 1)})`)
  }

  /**
   * Write the gesture posture straight to the presentation — no React
   * render sits between a pointermove and the compositor. Under the layer
   * budget the <img> transform path runs (GPU texture movement, will-change
   * riding the gesture only, re-rasterized sharp at rest); past it the
   * deep-zoom canvas takes over and the img is stashed (it stays the
   * decoded draw source). The annotation overlay carries the same transform
   * on either path, so recognized boxes track the pixels.
   */
  const paint = useCallback((value: ZoomState, badgePercent?: number, promoting = false): void => {
    const el = image.current
    if (el === null) return
    const overlayEl = annotations.current
    if (contained !== undefined && exceedsLayerBudget(value, contained)) {
      const canvas = deepCanvas.current
      if (canvas !== null && canvas.getContext('2d') !== null) {
        el.style.removeProperty('will-change')
        el.style.removeProperty('transform')
        el.style.visibility = 'hidden'
        canvas.hidden = false
        if (overlayEl !== null) applyTransform(overlayEl, value, promoting)
        scheduleDeepDraw(value)
        if (badgePercent !== undefined) {
          const badge = frame.current?.querySelector<HTMLElement>(`.${css.badge}`)
          if (badge !== null && badge !== undefined) badge.textContent = `${badgePercent}%`
        }
        return
      }
    }
    const canvas = deepCanvas.current
    if (canvas !== null && !canvas.hidden) {
      canvas.hidden = true
      el.style.removeProperty('visibility')
    }
    applyTransform(el, value, promoting)
    if (overlayEl !== null) applyTransform(overlayEl, value, promoting)
    if (badgePercent !== undefined) {
      const badge = frame.current?.querySelector<HTMLElement>(`.${css.badge}`)
      if (badge !== null && badge !== undefined) badge.textContent = `${badgePercent}%`
    }
  }, [contained, exceedsLayerBudget, scheduleDeepDraw])

  // Repaint the resting posture from state whenever it settles outside a
  // gesture (commit, reset, decode, or pane shape change).
  useEffect(() => {
    if (live.current === undefined) paint(zoom)
  }, [zoom, contained, shape, ready, paint])

  useEffect(() => () => {
    window.clearTimeout(settle.current)
    window.clearTimeout(ocrTimer.current)
    if (deepFrame.current !== undefined) cancelAnimationFrame(deepFrame.current)
  }, [])

  /** Fold the in-flight gesture into React state and stop the stream. */
  const commitLive = useCallback((): void => {
    window.clearTimeout(settle.current)
    const value = live.current
    if (value === undefined) return
    live.current = undefined
    setZoom(value)
  }, [])

  // The host answers a recognition request with a window event carrying the
  // request id. Recognition is a background nicety: an error, a stale id, or
  // a timeout simply leaves the image without a text layer — never any UI.
  useEffect(() => {
    if (!canOcr) return
    const onImageOcr = (e: Event): void => {
      try {
        const detail = JSON.parse((e as CustomEvent<string>).detail) as {
          requestId?: unknown
          items?: unknown
          error?: unknown
        }
        if (detail.requestId !== ocrRequest.current) return
        window.clearTimeout(ocrTimer.current)
        ocrRequest.current = undefined
        if (typeof detail.error === 'string' || !Array.isArray(detail.items)) return
        const items: OcrItem[] = []
        for (const raw of detail.items) {
          if (raw === null || typeof raw !== 'object') continue
          const item = raw as Record<string, unknown>
          if (typeof item.text !== 'string' || item.text.trim() === '') continue
          const x = Number(item.x), y = Number(item.y), w = Number(item.w), h = Number(item.h)
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
          items.push({ text: item.text, x, y, w, h })
        }
        if (items.length === 0) return
        if (ocrCache.size >= OCR_CACHE_LIMIT) {
          const oldest = ocrCache.keys().next()
          if (oldest.done === false) ocrCache.delete(oldest.value)
        }
        ocrCache.set(path, items)
        setOcrItems(items)
      } catch { /* not ours */ }
    }
    window.addEventListener('dsh:image-ocr', onImageOcr)
    return () => { window.removeEventListener('dsh:image-ocr', onImageOcr) }
  }, [canOcr, path])

  // Recognition runs silently the moment the image is decoded: the operator
  // never asks for it, and a cached path never pays for it twice. Vector and
  // thumbnail-sized images are skipped — there is no text layer worth having.
  useEffect(() => {
    if (!canOcr || !ready || natural === undefined) return
    if (natural.width < 64 && natural.height < 64) return
    if (/\.svg$/i.test(path)) return
    const cached = ocrCache.get(path)
    if (cached !== undefined) {
      setOcrItems(cached)
      return
    }
    const requestId = `image-ocr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    ocrRequest.current = requestId
    window.clearTimeout(ocrTimer.current)
    ocrTimer.current = window.setTimeout(() => {
      ocrRequest.current = undefined
    }, OCR_RESPONSE_TIMEOUT_MS)
    sendHost?.({ id: 'image-ocr', path, sessionId, requestId })
  }, [canOcr, ready, natural, path, sessionId, sendHost])

  /** Refresh the pane shape the contain math divides by; false when the
   * live box is still degenerate, so the resample gate stays open. */
  const applyShape = useCallback((): boolean => {
    const element = frame.current
    if (element === null || element.clientWidth <= 0 || element.clientHeight <= 0) return false
    setShape((current) => {
      if (current !== undefined
        && current.pane.width === element.clientWidth
        && current.pane.height === element.clientHeight) return current
      return { pane: { width: element.clientWidth, height: element.clientHeight } }
    })
    return true
  }, [])

  // The observer never drives the resting posture (the contained inline box
  // owns it); it feeds the contain math a fresh pane and re-clamps an active zoom. The
  // image box follows the shape state, quantized through the resample
  // scheduler, so dragging the sidebar's divider never re-samples a
  // megapixel image per frame.
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const scheduler = createResampleScheduler(applyShape)
    const observer = new ResizeObserver(() => { scheduler.schedule() })
    observer.observe(element)
    scheduler.schedule()
    return () => { scheduler.dispose(); observer.disconnect() }
  }, [applyShape])

  // A pane change re-clamps the translation so a zoomed image never strands
  // blank space after the sidebar resizes.
  useEffect(() => {
    if (atFit || scaled === undefined || shape === undefined) return
    setZoom(current => ({
      ...current,
      tx: clampPan(current.tx, scaled.width, shape.pane.width),
      ty: clampPan(current.ty, scaled.height, shape.pane.height),
    }))
  }, [shape, scaled?.width, scaled?.height, atFit])

  const reset = useCallback((): void => {
    window.clearTimeout(settle.current)
    live.current = undefined
    setZoom({ k: 1, tx: 0, ty: 0 })
  }, [])

  /**
   * Zoom by a multiplicative factor over the containment while holding the
   * pane-space anchor fixed, then clamp the translation so the fitted edges
   * never strand blank space when the image overflows the pane. The result
   * goes to the in-flight gesture accumulator and straight to the DOM; the
   * idle commit folds it into React state.
   */
  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    const element = frame.current
    if (element === null || contained === undefined) return
    const paneWidth = element.clientWidth
    const paneHeight = element.clientHeight
    if (paneWidth <= 0 || paneHeight <= 0) return
    const current = live.current ?? zoom
    const from = Math.max(current.k, 1)
    const next = Math.min(Math.max(from * factor, 1), ZOOM_MAX)
    if (next === from && current.tx === 0 && current.ty === 0 && live.current === undefined) return
    // Anchor in pane space, relative to the pane's center; the contained
    // image is centered, so the anchor's offset scales by the same factor.
    const cx = anchorX - paneWidth / 2
    const cy = anchorY - paneHeight / 2
    const tx = cx - (cx - current.tx) * (next / from)
    const ty = cy - (cy - current.ty) * (next / from)
    const value = {
      k: next,
      tx: clampPan(tx, contained.width * next, paneWidth),
      ty: clampPan(ty, contained.height * next, paneHeight),
    }
    live.current = value
    paint(value, Math.round(contained.scale * Math.max(next, 1) * 100), true)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(commitLive, GESTURE_COMMIT_MS)
  }, [commitLive, contained, paint, zoom])

  /**
   * Pan by wheel deltas (the natural trackpad scroll) while the scaled image
   * extends past the viewport. Same in-flight treatment as the pinch.
   */
  const panBy = useCallback((dx: number, dy: number): void => {
    const element = frame.current
    if (element === null || scaled === undefined) return
    const paneWidth = element.clientWidth
    const paneHeight = element.clientHeight
    const current = live.current ?? zoom
    const value = {
      ...current,
      tx: clampPan(current.tx - dx, scaled.width, paneWidth),
      ty: clampPan(current.ty - dy, scaled.height, paneHeight),
    }
    live.current = value
    paint(value, undefined, true)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(commitLive, GESTURE_COMMIT_MS)
  }, [commitLive, paint, scaled, zoom])

  // Ctrl/⌘+wheel (the trackpad pinch) zooms toward the pointer with a factor
  // that follows the delta's magnitude; a plain wheel pans an overflowing
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
    if (pannable) event.preventDefault()
    panBy(event.deltaX, event.deltaY)
  }, [pannable, panBy, zoomAt])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (zoom.k > 1 + Number.EPSILON) reset()
    else {
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(2, event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }, [reset, zoom.k, zoomAt])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !pannable) return
    // Pointer capture is best-effort: synthetic dispatchers (tests, AT) and
    // inactive pointers reject the request, and the drag works without it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* capture refused; the drag continues on shared handlers */ }
    const current = live.current ?? zoom
    drag.current = { x: event.clientX, y: event.clientY, tx: current.tx, ty: current.ty }
    live.current = current
    setPanning(true)
  }, [pannable, zoom])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const element = frame.current
    if (held === undefined || element === null || scaled === undefined) return
    const paneWidth = element.clientWidth
    const paneHeight = element.clientHeight
    const value = {
      ...(live.current ?? zoom),
      tx: clampPan(held.tx + (event.clientX - held.x), scaled.width, paneWidth),
      ty: clampPan(held.ty + (event.clientY - held.y), scaled.height, paneHeight),
    }
    live.current = value
    paint(value, undefined, true)
  }, [paint, scaled, zoom])

  const onPointerUp = useCallback((): void => {
    drag.current = undefined
    setPanning(false)
    commitLive()
  }, [commitLive])

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
        // The box IS the contained size (layout-sized, never object-fit:
        // WebKit's object-fit drawing path rasterizes large bitmaps at
        // reduced quality on Retina, which reads as badly blurry). The box
        // follows the quantized shape state, so a sidebar drag never
        // re-samples a megapixel image per frame. The gesture transform is
        // written straight to the element (see paint) and never rides the
        // style prop, so React renders stay out of the gesture's hot path.
        style={{
          width: contained === undefined ? undefined : contained.width,
          height: contained === undefined ? undefined : contained.height,
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
      {/* The deep-zoom surface: takes over past the layer budget (see
          paint/drawDeep) so every zoom level renders at display
          resolution; hidden while the transform path is in force. */}
      <canvas ref={deepCanvas} className={css.deepCanvas} aria-hidden="true" hidden />
      {ocrItems !== undefined && contained !== undefined && shape !== undefined && (
        // The overlay rides the img's exact box (contained size, pane
        // centered) and receives the same gesture transform (see paint), so
        // recognized boxes track the pixels at every zoom level.
        // The invisible text layer rides the img's exact box (contained size,
        // pane centered) and receives the same gesture transform (see paint),
        // so selection geometry tracks the pixels at every zoom level. Each
        // line is transparent but selectable: the operator selects and copies
        // image text like a document, WeChat-style, with no visible chrome.
        <div
          ref={annotations}
          className={css.annotations}
          data-image-annotations=""
          // The layer is the image's real text: it stays in the
          // accessibility tree (unlike the pixels), so assistive tech can
          // read what the operator can now select and copy.
          role="presentation"
          style={{
            left: (shape.pane.width - contained.width) / 2,
            top: (shape.pane.height - contained.height) / 2,
            width: contained.width,
            height: contained.height,
          }}
          // Selection owns the gesture here: a drag that starts on text must
          // select, not pan (panning stays available everywhere else).
          onPointerDown={(event) => { event.stopPropagation() }}
        >
          {ocrItems.map((item, index) => (
            <span
              key={index}
              className={css.textLayerLine}
              style={{
                left: `${item.x * 100}%`,
                top: `${item.y * 100}%`,
                width: `${item.w * 100}%`,
                height: `${item.h * 100}%`,
                fontSize: Math.max(4, item.h * contained.height),
              }}
            >
              {item.text}
            </span>
          ))}
        </div>
      )}
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
