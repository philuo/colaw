/**
 * Office file presentation (Word / PowerPoint / Excel): binary content and tab
 * information come from the document owner, and the format's viewer owns its
 * whole surface inside the container — a continuous multi-page scroll with
 * text selection and hyperlinks for Word/PowerPoint, the grid plus sheet tab
 * bar for Excel. Reading is scrolling, PDF-style; the body contributes the
 * lifecycle (load, failure, dispose) and the zoom gesture: ⌘/Ctrl+wheel runs
 * the image preview's continuous exponential curve with a cursor anchor,
 * replacing the library's discrete 1.1x step.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import {
  OFFICE_ZOOM_MAX, OFFICE_ZOOM_MIN, openDocx, openPptx, openXlsx, type OfficeHandle,
} from './runtime.ts'
import type {} from './locales.ts'
import css from './OfficeBody.module.css'

/** Standard document props plus this entry's locale — what the keyed slot delivers. */
export type OfficeBodyProps = DocumentPreviewProps & PropsLocale<'sidebarOffice'>

/** The body's full props: the slot props plus the registration-bound format. */
export type OfficeFormatBodyProps = OfficeBodyProps & {
  /** Which Office surface this keyed registration presents. */
  readonly format: 'docx' | 'pptx' | 'xlsx'
}

/** Wheel zoom grows with the gesture's pixel magnitude, identical to the image preview. */
const WHEEL_ZOOM_SENSITIVITY = 0.007
/** Per-event factor bounds, so one malformed delta cannot leap the view. */
const GESTURE_FACTOR_MIN = 0.5
const GESTURE_FACTOR_MAX = 2

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
      (loaded) => { if (!signal.aborted) setHandle(loaded) },
      (error: unknown) => { if (!signal.aborted) setFailure({ data, error }) },
    )
    return () => {
      surface.replaceChildren()
      void loading.then((loaded) => { loaded.dispose() }, () => { /* never resolved */ })
    }
  }, [data, format, tab.signal, attempt, props.t])

  // The zoom gesture rides the loaded viewer: capture-phase wheel so it lands
  // before anything the viewer bound, imperative scale and scroll writes so no
  // render sits between the gesture and the compositor.
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null || handle === undefined) return
    const listener = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const before = handle.zoom.getScale()
      const factor = Math.min(GESTURE_FACTOR_MAX, Math.max(
        GESTURE_FACTOR_MIN,
        Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
      ))
      const after = Math.min(OFFICE_ZOOM_MAX, Math.max(OFFICE_ZOOM_MIN, before * factor))
      if (after === before) return
      handle.zoom.setScale(after)
      const host = handle.scrollHost
      if (host !== undefined) {
        // Keep the content point under the cursor under the cursor: the
        // scrollable offsets scale with the content around the anchor.
        const rect = host.getBoundingClientRect()
        const ratio = after / before
        host.scrollTop = (host.scrollTop + (event.clientY - rect.top)) * ratio - (event.clientY - rect.top)
        host.scrollLeft = (host.scrollLeft + (event.clientX - rect.left)) * ratio - (event.clientX - rect.left)
      }
    }
    surface.addEventListener('wheel', listener, { capture: true, passive: false })
    return () => { surface.removeEventListener('wheel', listener, { capture: true }) }
  }, [handle])

  if (data === undefined) return <p className={css.status} role="alert">{props.t('unsupported')}</p>
  return (
    <section className={css.body} data-office-preview={format}>
      <div ref={surfaceRef} className={css.surface} />
      {handle === undefined && failure === undefined && <LoadingIndicator className={css.status} label={props.t('loading')} />}
      {failure !== undefined && <div className={css.status} role="alert">
        <span>{props.t('failed', { message: failure.error instanceof Error ? failure.error.message : String(failure.error) })}</span>
        <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{props.t('retry')}</Button>
      </div>}
    </section>
  )
}
