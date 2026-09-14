/**
 * PDF page presentation; binary content and tab information come from the
 * document owner.
 *
 * Pages render lazily (IntersectionObserver) into canvases sized by the pane,
 * each carrying a pdfjs text layer so the reader selects real text. Zoom — the
 * trackpad pinch, or ⌘/Ctrl+wheel — runs the image preview's continuous curve:
 * the live zoom scales pages through a CSS variable (layout-only, instant) and
 * the settle re-renders the requested pages at the zoomed pixel ratio, so the
 * detail is crisp where the reader stopped. The cursor anchor is preserved by
 * scaling the pane's scroll offset around it.
 *
 * Three rules keep the gesture smooth and the reader's text intact:
 *
 * - The pinch writes the CSS variable straight to the section and touches
 *   React only once it stops; a store write (and the render behind it) would
 *   otherwise land on every frame of the gesture, re-rendering every page in
 *   the document.
 * - A page's canvas is never hidden once it holds a bitmap. The page box is
 *   sized by that canvas, so hiding it collapses the box to zero and takes the
 *   text layer — and the reader's selection — with it.
 * - A crisp re-render happens only when the new pixel ratio actually exceeds
 *   the bitmap on screen. A bigger bitmap drawn smaller is still sharp, so
 *   zooming out never pays for one.
 *
 * The pages section does not exist while the document is still loading, so
 * everything bound to it is keyed on the node itself (state, not a ref). A
 * mount-time effect that ran behind the loader would never see the node, and
 * the reader would be left with no zoom variable, no pane width, and no
 * listener at all.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { createResampleScheduler } from '../resample.ts'
import { DEFAULT_PDF_VIEW, PDF_ZOOM_MAX, PDF_ZOOM_MIN, type PdfStore } from './store.ts'
import { renderPdfPage, renderPdfTextLayer, type PdfDocument } from './document.ts'
import { openPdf } from './runtime.ts'
import { PdfWorkerFailure } from './errors.ts'
import type {} from './locales.ts'
import css from './PdfBody.module.css'

/** A record's viewing preferences survive body unmounts and leave with the tab. */
export interface PdfBodyInjected {
  /**
   * Retain viewing preferences until the tab record ends.
   * @param tabId - owning tab.
   * @param signal - tab-record lifetime, not body visibility.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal) => void
}

/** Standard document props plus the PDF entry's locale, viewing store, and lifetime callback. */
export type PdfBodyProps = DocumentPreviewProps & PropsLocale<'sidebarPdf'> & PropsStore<PdfStore> & PdfBodyInjected

type LoadState =
  | { readonly kind: 'loaded'; readonly data: Uint8Array<ArrayBuffer>; readonly document: PdfDocument }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly error: unknown }

/** Horizontal chrome around a page's canvas: section padding (8×2) + page padding (12×2). */
const PDF_BODY_CHROME = 40
/** Wheel zoom grows with the gesture's pixel magnitude, identical to the image preview. */
const WHEEL_ZOOM_SENSITIVITY = 0.007
/** Per-event factor bounds, so one malformed delta cannot leap the view. */
const GESTURE_FACTOR_MIN = 0.5
const GESTURE_FACTOR_MAX = 2
/** A gesture settles this long after its last event; the crisp re-render follows. */
const GESTURE_SETTLE_MS = 160
/**
 * How much crisper a bitmap must get before re-rendering is worth it. Below
 * this the bitmap on screen is reused: drawn a hair larger it reads the same,
 * and the reader pays no render stall for it.
 */
const CRISP_RATIO_THRESHOLD = 1.02

/** The pointer-space point a zoom gesture holds fixed while the pages grow. */
interface ZoomAnchor {
  readonly clientX: number
  readonly clientY: number
}

/**
 * WebKit's non-standard pinch event. `scale` accumulates from the gesture's
 * start; an Electrobun WKWebView reports this pair instead of synthesizing a
 * ctrl+wheel the way a Chromium shell would.
 */
interface GestureScaleEvent extends Event {
  readonly scale: number
}

/**
 * Present a PDF with tab-local viewing preferences and component-owned rendering resources.
 * @param props - complete bytes and framework-owned tab/store/locale seats.
 * @returns the PDF reader.
 */
export function PdfBody(props: PdfBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const view = props.useStore(state => state.byTab[tab.id] ?? DEFAULT_PDF_VIEW)
  const data = props.content.kind === 'bytes' ? props.content.data : undefined
  const [load, setLoad] = useState<LoadState>()
  const [attempt, setAttempt] = useState(0)
  const { retainTab, actions, t } = props
  const pageVisible = useCallback((page: number): void => {
    actions.page(tab.id, page)
  }, [actions, tab.id])
  // The pages section is mounted only after the document loads, so its
  // identity lives in state: every effect below re-runs when it appears.
  const [body, setBody] = useState<HTMLElement | null>(null)
  // The crisp re-render trails the gesture: pages take the live zoom for their
  // CSS sizing, and this settled value only changes once the wheel stops.
  const [settledZoom, setSettledZoom] = useState(view.zoom)
  const settleRef = useRef(0)
  // The zoom currently on screen. A gesture advances it and writes it straight
  // to the CSS variable; the store catches up once the gesture stops.
  const liveZoom = useRef(view.zoom)
  useLayoutEffect(() => { liveZoom.current = view.zoom }, [view.zoom])

  // Every zoom change lands the new value on the section as a CSS variable —
  // layout-only, instant — and schedules the settle that re-renders crisp.
  useLayoutEffect(() => {
    if (body === null) return
    body.style.setProperty('--pdf-zoom', String(view.zoom))
    window.clearTimeout(settleRef.current)
    settleRef.current = window.setTimeout(() => { setSettledZoom(view.zoom) }, GESTURE_SETTLE_MS)
    return () => { window.clearTimeout(settleRef.current) }
  }, [body, view.zoom])

  // The pages' display width rides a quantized CSS variable instead of the
  // pane's live width, so dragging the sidebar's divider never re-composites
  // large canvases per frame; the trailing settle lands the exact size.
  useLayoutEffect(() => {
    if (body === null) return
    const scheduler = createResampleScheduler(() => {
      body.style.setProperty('--pdf-pane-width', `${Math.max(1, body.clientWidth - PDF_BODY_CHROME)}px`)
    })
    const observer = new ResizeObserver(() => { scheduler.schedule() })
    observer.observe(body)
    scheduler.schedule()
    return () => { scheduler.dispose(); observer.disconnect() }
  }, [body])

  // The pinch, bound once to the section: both routes (a WebKit gesture, or a
  // ctrl/⌘+wheel) feed one accumulator, coalesced to a single DOM write per
  // animation frame. Nothing here goes through React while the gesture runs —
  // the store write, and the crisp re-render behind it, wait for the settle.
  useEffect(() => {
    if (body === null) return
    // The pane that scrolls the pages is the owner's body element (pages flow
    // in the shared document scrollport), found by its stable marker.
    const pane = body.closest<HTMLElement>('[data-textpreview-body]')
    let frame = 0
    let settle = 0
    // Queued but not yet applied, kept across frames so a fast wheel stream
    // accumulates instead of restarting from the last committed zoom.
    let pending: number | undefined
    let anchor: ZoomAnchor | undefined
    // A WebKit pinch reports a cumulative scale, measured from its own start.
    let gestureBase = liveZoom.current
    const clampZoom = (zoom: number): number => Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom))
    const apply = (): void => {
      frame = 0
      const at = anchor
      const target = pending
      anchor = undefined
      pending = undefined
      if (at === undefined || target === undefined) return
      // Measured before the variable write so this frame pays for one layout,
      // not two: the pane's own box does not follow the pages' size.
      const rect = pane?.getBoundingClientRect()
      const before = liveZoom.current
      liveZoom.current = target
      body.style.setProperty('--pdf-zoom', String(target))
      if (pane !== null && rect !== undefined && before !== target) {
        const ratio = target / before
        const top = at.clientY - rect.top
        const left = at.clientX - rect.left
        pane.scrollTop = (pane.scrollTop + top) * ratio - top
        pane.scrollLeft = (pane.scrollLeft + left) * ratio - left
      }
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        actions.zoomed(tab.id, target)
        setSettledZoom(target)
      }, GESTURE_SETTLE_MS)
    }
    const request = (zoom: number, at: ZoomAnchor): void => {
      pending = zoom
      anchor = at
      if (frame === 0) frame = requestAnimationFrame(apply)
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const factor = Math.min(GESTURE_FACTOR_MAX, Math.max(
        GESTURE_FACTOR_MIN,
        Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
      ))
      request(clampZoom((pending ?? liveZoom.current) * factor), event)
    }
    // The trackpad pinch: WebKit reports the gesture itself, and consuming its
    // default keeps the shell from magnifying the whole page instead of the
    // document.
    const onGestureStart = (event: Event): void => {
      event.preventDefault()
      gestureBase = pending ?? liveZoom.current
    }
    const onGestureChange = (event: Event): void => {
      event.preventDefault()
      const { scale } = event as GestureScaleEvent
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return
      // The pinch's own centre when WebKit reports one; page 1's corner otherwise.
      const at = event as unknown as Partial<ZoomAnchor>
      request(clampZoom(gestureBase * scale), { clientX: at.clientX ?? 0, clientY: at.clientY ?? 0 })
    }
    const options: AddEventListenerOptions = { capture: true, passive: false }
    body.addEventListener('wheel', onWheel, options)
    body.addEventListener('gesturestart', onGestureStart, options)
    body.addEventListener('gesturechange', onGestureChange, options)
    return () => {
      body.removeEventListener('wheel', onWheel, options)
      body.removeEventListener('gesturestart', onGestureStart, options)
      body.removeEventListener('gesturechange', onGestureChange, options)
      window.clearTimeout(settle)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [actions, body, tab.id])

  // Copy is prose, not the layer's typography. pdfjs places every span
  // absolutely, draws it transparent, and the engine inlines that computed
  // styling into the clipboard's HTML flavour — pasted anywhere else the text
  // arrives with page offsets, a pane-measured font size and no visible colour.
  // The reader gets the selection's plain text instead.
  useEffect(() => {
    if (body === null) return
    const onCopy = (event: ClipboardEvent): void => {
      const selection = document.getSelection()
      if (selection === null || selection.isCollapsed) return
      const text = selection.toString()
      if (text === '') return
      event.clipboardData?.setData('text/plain', text)
      event.preventDefault()
    }
    body.addEventListener('copy', onCopy)
    return () => { body.removeEventListener('copy', onCopy) }
  }, [body])

  useEffect(() => { retainTab(tab.id, tab.signal) }, [retainTab, tab.id, tab.signal])
  useEffect(() => {
    if (data === undefined || tab.signal.aborted) return
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, tab.signal])
    setLoad(undefined)
    const session = openPdf(data, signal, (error) => {
      if (!signal.aborted) setLoad({ kind: 'failed', data, error })
    })
    void session.document.then(
      (document) => { if (!signal.aborted) setLoad({ kind: 'loaded', data, document }) },
      (error: unknown) => { if (!signal.aborted) setLoad({ kind: 'failed', data, error }) },
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [data, tab.signal, attempt])
  if (data === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (load?.data !== data) return <LoadingIndicator className={css.status} label={t('loading')} />
  if (load.kind === 'failed') {
    return <div className={css.status} role="alert">
      <span>{failureText(load.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>
  }
  return <section ref={setBody} className={css.body} data-pdf-preview data-dsh-selectable="">
    {Array.from({ length: load.document.numPages }, (_, index) => (
      <PdfPage key={index} document={load.document} page={index + 1}
        requested={index === 0 || view.page === index + 1} onVisible={pageVisible} signal={tab.signal} t={t}
        settledZoom={settledZoom} />
    ))}
  </section>
}

function PdfPage({ document, page, requested: initiallyRequested, onVisible, signal, t, settledZoom }: {
  readonly document: PdfDocument
  readonly page: number
  readonly requested: boolean
  readonly onVisible: (page: number) => void
  readonly signal: AbortSignal
  /** The settled zoom: pages re-render at this pixel ratio once the wheel stops. */
  readonly settledZoom: number
} & PropsLocale<'sidebarPdf'>): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState(initiallyRequested)
  // The page's own CSS width, known once it has rendered. The text layer's font
  // size is pdfjs's `--font-height` (page pixels) times the fit ratio, and the
  // ratio is this number's denominator.
  const renderedWidth = useRef(0)
  // Whether a bitmap has ever reached the canvas. From then on the canvas
  // stays mounted and visible: the page box is sized by it, so hiding it for a
  // re-render would collapse the box, empty the text layer's `100%` height,
  // and drop the reader's selection — on every zoom.
  const [painted, setPainted] = useState(false)
  // The pixel ratio of the bitmap on screen. A zoom that does not beat it
  // reuses that bitmap, so zooming out costs nothing at all.
  const renderedRatio = useRef(0)
  const [failure, setFailure] = useState<{ readonly error: unknown }>()
  const [attempt, setAttempt] = useState(0)
  /**
   * Publish the fit ratio — pane width over page width — for the text layer's
   * font size. CSS cannot divide a length by a length in any shipping engine,
   * so the one number pdfjs's percentages can't supply is computed here, and
   * only when the pane or the page changes: the zoom gesture never touches it,
   * because the layer is laid out at the fitted size and merely scaled.
   */
  const applyFit = useCallback((): void => {
    const slot = box.current
    const section = slot?.closest<HTMLElement>('[data-pdf-preview]')
    if (slot === null || section === null || section === undefined) return
    if (renderedWidth.current <= 0) return
    const pane = Math.max(1, section.clientWidth - PDF_BODY_CHROME)
    slot.style.setProperty('--pdf-fit', String(Math.min(1, pane / renderedWidth.current)))
  }, [])
  useEffect(() => {
    const slot = box.current
    const section = slot?.closest<HTMLElement>('[data-pdf-preview]')
    if (slot === null || section === null || section === undefined) return
    // The pane's width is what the ratio follows; quantized like the canvas
    // width so dragging the sidebar's divider does not reflow per frame.
    const scheduler = createResampleScheduler(applyFit)
    const observer = new ResizeObserver(() => { scheduler.schedule() })
    observer.observe(section)
    scheduler.schedule()
    return () => { scheduler.dispose(); observer.disconnect() }
  }, [applyFit])
  // A replacement document starts from nothing.
  useEffect(() => {
    setPainted(false)
    renderedRatio.current = 0
    renderedWidth.current = 0
  }, [document])
  useEffect(() => {
    const node = host.current as HTMLDivElement
    if (typeof IntersectionObserver === 'undefined') {
      setRequested(true)
      return
    }
    let disposed = false
    const observer = new IntersectionObserver((entries) => {
      if (disposed || !entries.some(entry => entry.isIntersecting)) return
      setRequested(true)
      onVisible(page)
      observer.disconnect()
    }, { rootMargin: '100% 0px' })
    observer.observe(node)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [page, onVisible])
  useEffect(() => {
    if (!requested) return
    const ratio = window.devicePixelRatio * settledZoom
    if (painted && ratio <= renderedRatio.current * CRISP_RATIO_THRESHOLD) return
    // The shown canvas is unconditional; this effect runs after its ref is
    // committed and only ever hands it a finished bitmap (see below).
    const shown = canvas.current as HTMLCanvasElement
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    // Staged, then swapped in whole: pdfjs clears the canvas it draws into, so
    // rendering straight to the visible one would blank the page for the whole
    // render. The reader keeps the previous bitmap until the new one is done.
    // (The document to render is a prop here, so the global is spelled out.)
    const staged = globalThis.document.createElement('canvas')
    setFailure(undefined)
    renderedRatio.current = ratio
    void renderPdfPage(document, page, staged, renderSignal, ratio).then(
      (size) => {
        if (renderSignal.aborted) return
        // The page's own geometry drives the display box's fit math and the
        // text layer's scale, so it lands on the visible canvas.
        shown.style.setProperty('--pdf-page-width', `${size.width}px`)
        shown.style.setProperty('--pdf-page-height', `${size.height}px`)
        renderedWidth.current = size.width
        applyFit()
        if (staged.width > 0 && staged.height > 0) {
          // Setting the size clears the canvas, so the copy follows in the same
          // task: the swap is one paint, never a blank one.
          shown.width = staged.width
          shown.height = staged.height
          shown.getContext('2d')?.drawImage(staged, 0, 0)
        }
        setPainted(true)
      },
      (error: unknown) => {
        if (renderSignal.aborted) return
        renderedRatio.current = 0
        setFailure({ error })
      },
    )
    return () => { lifetime.abort() }
  }, [document, page, requested, signal, attempt, settledZoom, painted])
  // The text layer rides the page, not the canvas renders: pdfjs lays it out
  // at the base scale and the CSS zoom scales it with the page box, so the
  // crisp bitmap re-render at a settled zoom must never rebuild it — that
  // would flicker the layer and wipe the reader's selection on every zoom.
  const textLayerRendered = useRef(false)
  useEffect(() => {
    if (!requested) return
    const node = textLayer.current as HTMLDivElement
    if (textLayerRendered.current) return
    const lifetime = new AbortController()
    const layerSignal = AbortSignal.any([lifetime.signal, signal])
    textLayerRendered.current = true
    void renderPdfTextLayer(document, page, node, layerSignal).catch(() => { /* a page without extractable text */ })
    return () => {
      lifetime.abort()
      textLayerRendered.current = false
    }
  }, [document, page, requested, signal])
  return <div ref={host} className={css.page} data-pdf-page={page}>
    {failure === undefined && !painted && <div className={css.placeholder}>
      {requested && <LoadingIndicator className={css.status} label={t('rendering')} />}
    </div>}
    {failure !== undefined && <div className={css.status} role="alert">
      <span>{failureText(failure.error, t)}</span>
      <Button size="sm" onClick={() => { renderedRatio.current = 0; setAttempt(value => value + 1) }}>
        {t('retry')}
      </Button>
    </div>}
    <div ref={box} className={css.pageBox}>
      <canvas ref={canvas} className={css.canvas} role="img" aria-label={t('pageImage', { page })}
        hidden={!painted || failure !== undefined} />
      <div ref={textLayer} className={css.textLayer} data-pdf-text-layer="" />
    </div>
  </div>
}

function failureText(error: unknown, t: PropsLocale<'sidebarPdf'>['t']): string {
  if (error instanceof PdfWorkerFailure) return t('workerFailed')
  if (error instanceof Error && error.name === 'PasswordException') return t('password')
  return t('failed', { message: error instanceof Error ? error.message : String(error) })
}
