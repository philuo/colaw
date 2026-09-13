/**
 * PDF page presentation; binary content and tab information come from the
 * document owner.
 *
 * Pages render lazily (IntersectionObserver) into canvases sized by the pane,
 * each carrying a pdfjs text layer so the reader selects real text. Zoom
 * (⌘/Ctrl+wheel) runs the image preview's continuous curve: the live zoom
 * scales pages through a CSS variable — layout-only, instant — and the settle
 * re-renders the requested pages at the zoomed pixel ratio so the detail is
 * crisp where the reader stopped. The cursor anchor is preserved by scaling
 * the pane's scroll offset around it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
  const body = useRef<HTMLElement>(null)
  // The crisp re-render trails the gesture: pages take the live zoom for their
  // CSS sizing, and this settled value only changes once the wheel stops.
  const [settledZoom, setSettledZoom] = useState(view.zoom)
  const settleRef = useRef(0)

  // Every zoom change lands the new value on the section as a CSS variable —
  // layout-only, instant — and schedules the settle that re-renders crisp.
  useEffect(() => {
    const section = body.current
    if (section === null) return
    section.style.setProperty('--pdf-zoom', String(view.zoom))
    clearTimeout(settleRef.current)
    settleRef.current = setTimeout(() => { setSettledZoom(view.zoom) }, GESTURE_SETTLE_MS)
  }, [view.zoom])

  // The pages' display width rides a quantized CSS variable instead of the
  // pane's live width, so dragging the sidebar's divider never re-composites
  // large canvases per frame; the trailing settle lands the exact size.
  useEffect(() => {
    const section = body.current
    if (section === null) return
    const scheduler = createResampleScheduler(() => {
      section.style.setProperty('--pdf-pane-width', `${Math.max(1, section.clientWidth - PDF_BODY_CHROME)}px`)
    })
    const observer = new ResizeObserver(() => { scheduler.schedule() })
    observer.observe(section)
    scheduler.schedule()
    return () => { scheduler.dispose(); observer.disconnect() }
  }, [])

  // The pinch gesture: capture-phase wheel (⌘/Ctrl), coalesced to one store
  // write per animation frame, with the pane's scroll offset scaled around the
  // cursor so the point under it stays there while the pages grow.
  useEffect(() => {
    const section = body.current
    if (section === null) return
    // The pane that scrolls the pages is the owner's body element (pages flow
    // in the shared document scrollport), found by its stable marker.
    const pane = section.closest<HTMLElement>('[data-textpreview-body]')
    let frame = 0
    let target = 0
    let lastEvent: WheelEvent | undefined
    const apply = (): void => {
      frame = 0
      const at = lastEvent
      lastEvent = undefined
      if (at === undefined) return
      const before = view.zoom
      const ratio = target / before
      actions.zoomed(tab.id, target)
      if (pane !== null && ratio !== 1) {
        const rect = pane.getBoundingClientRect()
        const top = at.clientY - rect.top
        const left = at.clientX - rect.left
        pane.scrollTop = (pane.scrollTop + top) * ratio - top
        pane.scrollLeft = (pane.scrollLeft + left) * ratio - left
      }
    }
    const listener = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const factor = Math.min(GESTURE_FACTOR_MAX, Math.max(
        GESTURE_FACTOR_MIN,
        Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
      ))
      const from = target === 0 ? view.zoom : target
      target = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, from * factor))
      lastEvent = event
      if (frame === 0) frame = requestAnimationFrame(apply)
    }
    section.addEventListener('wheel', listener, { capture: true, passive: false })
    return () => {
      section.removeEventListener('wheel', listener, { capture: true })
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [actions, tab.id, view.zoom])

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
  return <section ref={body} className={css.body} data-pdf-preview data-dsh-selectable="">
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
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState(initiallyRequested)
  const [state, setState] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<{ readonly error: unknown }>()
  const [attempt, setAttempt] = useState(0)
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
    // The canvas is unconditional; this effect runs after its ref is committed.
    const node = canvas.current as HTMLCanvasElement
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    setState('loading')
    setFailure(undefined)
    void renderPdfPage(document, page, node, renderSignal, window.devicePixelRatio * settledZoom).then(
      () => { if (!renderSignal.aborted) setState('ready') },
      (error: unknown) => { if (!renderSignal.aborted) setFailure({ error }) },
    )
    return () => { lifetime.abort() }
  }, [document, page, requested, signal, attempt, settledZoom])
  // The text layer rides the canvas render: selection must exist whenever the
  // page is visible, at any zoom (the layer scales with the page box).
  useEffect(() => {
    if (!requested || state !== 'ready') return
    const node = textLayer.current as HTMLDivElement
    const lifetime = new AbortController()
    const layerSignal = AbortSignal.any([lifetime.signal, signal])
    void renderPdfTextLayer(document, page, node, layerSignal).catch(() => { /* a page without extractable text */ })
    return () => { lifetime.abort() }
  }, [document, page, requested, signal, state])
  return <div ref={host} className={css.page} data-pdf-page={page}>
    {failure === undefined && state !== 'ready' && <div className={css.placeholder}>
      {requested && <LoadingIndicator className={css.status} label={t('rendering')} />}
    </div>}
    {failure !== undefined && <div className={css.status} role="alert">
      <span>{failureText(failure.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>}
    <div className={css.pageBox}>
      <canvas ref={canvas} className={css.canvas} role="img" aria-label={t('pageImage', { page })}
        hidden={state !== 'ready' || failure !== undefined} />
      <div ref={textLayer} className={css.textLayer} />
    </div>
  </div>
}

function failureText(error: unknown, t: PropsLocale<'sidebarPdf'>['t']): string {
  if (error instanceof PdfWorkerFailure) return t('workerFailed')
  if (error instanceof Error && error.name === 'PasswordException') return t('password')
  return t('failed', { message: error instanceof Error ? error.message : String(error) })
}
