/**
 * Office file presentation (Word / PowerPoint / Excel): binary content and tab
 * information come from the document owner, and the format's viewer owns its
 * whole surface inside the container — a continuous multi-page scroll with
 * text selection and hyperlinks for Word/PowerPoint, the grid plus sheet tab
 * bar for Excel. Reading is scrolling, PDF-style.
 *
 * Zoom is the library's own: `⌘`/Ctrl+wheel and trackpad pinch are handled
 * inside the viewer, which previews the gesture with a CSS transform and
 * settles into a crisp re-render when it pauses (its documented behaviour, and
 * the only implementation that can be — it knows its own virtualized scroll
 * host). An earlier revision re-implemented that here and it went wrong in
 * exactly the ways a second copy would: the transform landed on the scroll
 * container, so the scrollbar scaled and snapped back on release, and the
 * gesture drifted off the pane. Word/PowerPoint register their scroll host as
 * the pane's scrollport, so the reader's position survives body unmounts (tab
 * switches, sidebar hides) and is restored when the content returns. Excel's
 * merged cells read as one: a single-cell selection inside a merge range
 * expands to the whole range.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { openDocx, openPptx, openXlsx, type OfficeHandle } from './runtime.ts'
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

  // Zoom is the viewer's own (see the module comment). Nothing is bound here,
  // and deliberately so: a second implementation sitting on top of the
  // virtualized scroll host could only fight it — it did, and that is exactly
  // the reported "the scrollbar scales with the page and snaps back on release,
  // and the view jumps when the gesture ends".

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

  // Copy is the document's text, not the selection layer's geometry. The paged
  // viewers place their selectable runs as absolutely positioned, transparent
  // spans with the font written inline, and the engine copies that computed
  // styling into the clipboard's HTML flavour. The reader gets plain text.
  //
  // The xlsx grid copies through its own `copySelection`, which never fires this
  // event — and a canvas selection is collapsed anyway, so the guard below
  // leaves that path alone.
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    const onCopy = (event: ClipboardEvent): void => {
      const selection = document.getSelection()
      if (selection === null || selection.isCollapsed) return
      const text = selection.toString()
      if (text === '') return
      event.clipboardData?.setData('text/plain', text)
      event.preventDefault()
    }
    surface.addEventListener('copy', onCopy)
    return () => { surface.removeEventListener('copy', onCopy) }
  }, [])

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
