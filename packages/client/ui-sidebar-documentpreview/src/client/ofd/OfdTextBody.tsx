/** OFD 结构化文本预览：分页呈现从 OFD XML 直接读取的文本（编码无损）。 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdPages } from './ofd-document.ts'
import css from './OfdTextBody.module.css'

export function OfdTextBody({ content, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  t: (key: 'textLoading' | 'textFailed') => string
}): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [pages, setPages] = useState<readonly { page: number; lines: readonly string[] }[]>()

  useEffect(() => {
    if (data === undefined) {
      setPages([])
      return
    }
    let disposed = false
    readOfdPages(data).then((texts) => {
      if (!disposed) setPages(texts)
    }).catch(() => {
      if (!disposed) setPages([])
    })
    return () => { disposed = true }
  }, [data])

  if (pages === undefined) {
    return <LoadingIndicator className={css.status} label={t('textLoading')} />
  }
  return (
    <div className={css.body}>
      {pages.map(page => (
        <section key={page.page} className={css.page}>
          <span className={css.pageLabel}>{`P${String(page.page)}`}</span>
          {page.lines.map((line, at) => <p key={at} className={css.line}>{line}</p>)}
        </section>
      ))}
    </div>
  )
}
