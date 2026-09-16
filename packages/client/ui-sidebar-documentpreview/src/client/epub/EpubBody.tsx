/** EPUB 预览：foliate 视图组件挂载滚动阅读器。 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { openEpubBook } from './epub-book.ts'
import type { FoliateView } from './foliate/view.js'
import './foliate/view.js'
import css from './EpubBody.module.css'

/**
 * Present complete EPUB bytes as a scrolled foliate reader.
 * @param props - document bytes and locale.
 * @returns the reading surface.
 */
export function EpubBody({ content, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  t: (key: 'loading' | 'failed' | 'unsupported') => string
}): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'unsupported'>('loading')
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (data === undefined) {
      setState('unsupported')
      return
    }
    let disposed = false
    // 经函数读取，避免 TS 把 await 后的 disposed 收窄成恒定值。
    const isDisposed = () => disposed
    let view: FoliateView | undefined
    setState('loading')
    openEpubBook(data).then(async (book) => {
      if (isDisposed()) return
      view = document.createElement('foliate-view') as FoliateView
      await view.open(book)
      // disposed 在 open 的 await 期间翻转会错过清理：这里补一次。
      if (isDisposed()) {
        view.close()
        view.remove()
        return
      }
      // 滚动模式适合侧栏窄幅：连续排版，靠原生滚动翻页。
      view.renderer.setAttribute('flow', 'scrolled')
      hostRef.current?.append(view)
      setState('ready')
    }).catch(() => {
      if (!isDisposed()) setState('failed')
    })
    return () => {
      disposed = true
      view?.close()
      view?.remove()
    }
  }, [data])

  if (state === 'unsupported') return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (state === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  return (
    <div className={css.host}>
      {state === 'ready' ? null : <LoadingIndicator className={css.status} label={t('loading')} />}
      <div ref={hostRef} className={state === 'ready' ? css.reader : css.readerBehind} />
    </div>
  )
}
