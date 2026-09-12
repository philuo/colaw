/**
 * Office file presentation (Word / PowerPoint / Excel): binary content and tab
 * information come from the document owner, and the format's viewer owns the
 * canvas (docx/pptx) or the whole grid surface with its sheet tabs (xlsx).
 * The component drives only the lifecycle — load, progress, failure, dispose —
 * plus the page/slide chrome the bare docx/pptx viewers leave to the caller.
 * The canvas is created imperatively per session: the viewer re-parents and
 * releases the node itself, which must not fight React's ownership of the
 * surrounding surface.
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
  const [progress, setProgress] = useState<{ readonly index: number; readonly total: number }>()
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (data === undefined || tab.signal.aborted) return
    const signal = tab.signal
    setHandle(undefined)
    setFailure(undefined)
    setProgress(undefined)
    // The parsers take ownership of their buffer: hand over a copy so a tab
    // reload of the same bytes keeps the source usable.
    const buffer = data.slice().buffer
    const onError = (error: Error): void => { if (!signal.aborted) setFailure({ data, error }) }
    const onProgress = (index: number, total: number): void => { if (!signal.aborted) setProgress({ index, total }) }
    const surface = surfaceRef.current as HTMLDivElement
    const canvas = format === 'xlsx' ? undefined : document.createElement('canvas')
    if (canvas !== undefined) {
      canvas.className = css.canvas ?? ''
      canvas.ariaLabel = props.t(format === 'docx' ? 'docxTitle' : 'pptxTitle')
      surface.replaceChildren(canvas)
    }
    const loading = format === 'docx'
      ? openDocx(canvas as HTMLCanvasElement, buffer, { onProgress, onError })
      : format === 'pptx'
        ? openPptx(canvas as HTMLCanvasElement, buffer, { onProgress, onError })
        : openXlsx(surface, buffer, { onProgress, onError })
    void loading.then(
      (loaded) => { if (!signal.aborted) setHandle(loaded) },
      (error: unknown) => { if (!signal.aborted) setFailure({ data, error }) },
    )
    return () => {
      surface.replaceChildren()
      void loading.then((loaded) => { loaded.dispose() }, () => { /* never resolved */ })
    }
  }, [data, format, tab.signal, attempt, props.t])

  if (data === undefined) return <p className={css.status} role="alert">{props.t('unsupported')}</p>
  const navigate = handle?.navigate
  return (
    <section className={css.body} data-office-preview={format}>
      <div ref={surfaceRef} className={css.surface} />
      {handle === undefined && failure === undefined && <LoadingIndicator className={css.status} label={props.t('loading')} />}
      {failure !== undefined && <div className={css.status} role="alert">
        <span>{props.t('failed', { message: failure.error instanceof Error ? failure.error.message : String(failure.error) })}</span>
        <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{props.t('retry')}</Button>
      </div>}
      {navigate !== undefined && progress !== undefined && <div className={css.navigationBar}>
        <Button size="sm" variant="ghost" disabled={progress.index <= 0}
          aria-label={props.t(format === 'docx' ? 'previousPage' : 'previousSlide')}
          onClick={() => { navigate.previous() }}>
          {props.t(format === 'docx' ? 'previousPage' : 'previousSlide')}
        </Button>
        <span className={css.pageIndicator}>{props.t('pageOf', { index: progress.index + 1, total: progress.total })}</span>
        <Button size="sm" variant="ghost" disabled={progress.index >= progress.total - 1}
          aria-label={props.t(format === 'docx' ? 'nextPage' : 'nextSlide')}
          onClick={() => { navigate.next() }}>
          {props.t(format === 'docx' ? 'nextPage' : 'nextSlide')}
        </Button>
      </div>}
    </section>
  )
}
