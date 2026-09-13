/**
 * Office file presentation (Word / PowerPoint / Excel): binary content and tab
 * information come from the document owner, and the format's viewer owns its
 * whole surface inside the container — a continuous multi-page scroll with
 * text selection and hyperlinks for Word/PowerPoint, the grid plus sheet tab
 * bar for Excel. Reading is scrolling, PDF-style.
 *
 * The zoom gesture (⌘/Ctrl+wheel) runs the image preview's continuous
 * exponential curve. The viewer's own per-event relayout is too costly to run
 * at trackpad event rate, so the gesture previews on a GPU transform — origin
 * at the cursor, zero layout work — and commits one real `setScale` 160ms
 * after the last event, restoring the cursor anchor. Word/PowerPoint also
 * register their scroll host as the pane's scrollport, so the reader's
 * position survives body unmounts (tab switches, sidebar hides) and is
 * restored when the content returns. Excel's merged cells read as one: a
 * single-cell selection inside a merge range expands to the whole range.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import {
  OFFICE_ZOOM_MAX, OFFICE_ZOOM_MIN, openDocx, openPptx, openXlsx, type OfficeHandle,
} from './runtime.ts'
import { createWheelZoom } from './zoom.ts'
import type {} from './locales.ts'
import css from './OfficeBody.module.css'

/** Standard document props plus this entry's locale — what the keyed slot delivers. */
export type OfficeBodyProps = DocumentPreviewProps & PropsLocale<'sidebarOffice'>

/** The body's full props: the slot props plus the registration-bound format. */
export type OfficeFormatBodyProps = OfficeBodyProps & {
  /** Which Office surface this keyed registration presents. */
  readonly format: 'docx' | 'pptx' | 'xlsx'
}

type Failure = { readonly data: Uint8Array<ArrayBuffer>; readonly error: unknown }

/**
 * Present an Office file with its format's viewer.
 * @param props - complete bytes, the framework seats, and the bound format.
 * @returns the Office reader.
 */
export function OfficeBody(props: OfficeFormatBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const { format } = props
  const data = props.content.kind === 'bytes' ? props.content.data : undefined
  const [handle, setHandle] = useState<OfficeHandle>()
  const [failure, setFailure] = useState<Failure>()
  const [attempt, setAttempt] = useState(0)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (data === undefined || tab.signal.aborted) return
    const signal = tab.signal
    setHandle(undefined)
    setFailure(undefined)
    // The parsers take ownership of their buffer: hand over a copy so a tab
    // reload of the same bytes keeps the source usable.
    const buffer = data.slice().buffer
    const onError = (error: Error): void => { if (!signal.aborted) setFailure({ data, error }) }
    const surface = surfaceRef.current as HTMLDivElement
    const loading = format === 'docx'
      ? openDocx(surface, buffer, { onError })
      : format === 'pptx'
        ? openPptx(surface, buffer, { onError })
        : openXlsx(surface, buffer, { onError })
    void loading.then(
      (loaded) => {
        if (signal.aborted) return
        setHandle(loaded)
        // The viewer's own scroll surface becomes the pane's scrollport: the
        // owner's scroll tracking and position restore then cover the reader
        // exactly where it was.
        const host = loaded.scrollHost
        if (host !== undefined) props.scrollportRef?.(host)
      },
      (error: unknown) => { if (!signal.aborted) setFailure({ data, error }) },
    )
    return () => {
      surface.replaceChildren()
      void loading.then((loaded) => { loaded.dispose() }, () => { /* never resolved */ })
    }
  }, [data, format, tab.signal, attempt, props.t, props.scrollportRef])

  // The zoom gesture rides the loaded PAGED viewer: capture-phase wheel lands
  // before anything the viewer bound; during the gesture a transform preview
  // scales the painted surface with zero layout work, and the settle commits
  // one real scale with the cursor anchor restored. The xlsx grid is exempt —
  // its viewer's built-in ⌘/Ctrl+wheel zoom scales the grid itself (anchored,
  // re-laid-out), and hijacking the wheel here would scale the whole surface
  // (tab bar included) instead.
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null || handle === undefined || format === 'xlsx') return
    const host = handle.scrollHost
    const binding = createWheelZoom(surface, {
      min: OFFICE_ZOOM_MIN,
      max: OFFICE_ZOOM_MAX,
      getScale: () => handle.zoom.getScale(),
      apply: (scale, origin) => {
        const before = handle.zoom.getScale()
        handle.zoom.setScale(scale)
        const host = handle.scrollHost
        if (host !== undefined) {
          // Keep the content point under the cursor under the cursor: the
          // scrollable offsets scale with the content around the anchor.
          const rect = host.getBoundingClientRect()
          const ratio = scale / before
          const top = origin.y - rect.top
          const left = origin.x - rect.left
          host.scrollTop = (host.scrollTop + top) * ratio - top
          host.scrollLeft = (host.scrollLeft + left) * ratio - left
        }
      },
      preview: (base, target, origin) => {
        const el = host ?? surface
        el.style.transformOrigin = `${origin.x}px ${origin.y}px`
        el.style.transform = `scale(${target / base})`
      },
      endPreview: () => {
        const el = host ?? surface
        el.style.transform = ''
      },
    })
    return () => { binding.dispose() }
  }, [handle, format])

  // Excel reads one merged cell as one, on click and keyboard navigation.
  //
  // The viewer's hit-testing is grid-cell granular, so a committed lone-cell
  // selection inside a merge is widened to the whole merge — but never
  // mid-press: while a pointer is down the viewer is dragging its own
  // selection, and rewriting it would fight the drag. A tap commits its
  // selection after release, so the button-aware check catches it (and
  // keyboard navigation, where no button is involved). Hover deliberately
  // stays untouched: the viewer draws no hover highlight, and an overlay of
  // our own misaligns as soon as the grid pans or zooms.
  //
  // Copy: ⌘C/Ctrl+C forwards to the viewer's clipboard path. Its own handler
  // lives on an internal surface that only fires when that surface holds
  // focus, which a canvas never earns; this binding works from the pane.
  useEffect(() => {
    if (format !== 'xlsx' || handle?.xlsx === undefined) return
    const surface = surfaceRef.current
    const xlsx = handle.xlsx
    if (surface === null) return
    let pressed = false
    const onPointerDown = (): void => { pressed = true }
    const onPointerUp = (): void => { pressed = false }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'c' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      // The viewer's internal copy handler (when its surface holds focus)
      // yields to prevented events, so this pane-level binding is the one
      // path regardless of focus.
      event.preventDefault()
      void xlsx.copySelection()
    }
    xlsx.onSelectionChange(() => { if (!pressed) void xlsx.expandMergedSelection() })
    surface.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    surface.addEventListener('pointerup', onPointerUp, { capture: true, passive: true })
    surface.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true })
    surface.addEventListener('keydown', onKey, { capture: true })
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown, { capture: true })
      surface.removeEventListener('pointerup', onPointerUp, { capture: true })
      surface.removeEventListener('pointercancel', onPointerUp, { capture: true })
      surface.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [format, handle, props.t])

  if (data === undefined) return <p className={css.status} role="alert">{props.t('unsupported')}</p>
  return (
    <section className={css.body} data-office-preview={format} data-dsh-selectable="">
      <div ref={surfaceRef} className={css.surface} />
      {handle === undefined && failure === undefined && <LoadingIndicator className={css.status} label={props.t('loading')} />}
      {failure !== undefined && <div className={css.status} role="alert">
        <span>{props.t('failed', { message: failure.error instanceof Error ? failure.error.message : String(failure.error) })}</span>
        <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{props.t('retry')}</Button>
      </div>}
    </section>
  )
}
