/**
 * OFD 高保真预览（版式骨架）：毫米坐标以页面百分比定位，字号用容器查询单位
 * 随宽度缩放；图片经资源清单回填为数据 URL，解析不到时以虚线占位框标注。
 * 矢量路径与字体内嵌的完整还原按页逐步增强。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdLayout } from './ofd-layout.ts'
import type { OfdLayoutPage, OfdImageFragment, OfdTextFragment } from './ofd-layout.ts'
import css from './OfdHifiBody.module.css'

type Fragment = OfdTextFragment | OfdImageFragment

/** 毫米坐标换算为页面宽高的百分比样式。 */
function percent(valueMm: number, totalMm: number): string {
  return `${(valueMm / totalMm * 100).toFixed(3)}%`
}

/** 一页的渲染：白底页框内绝对定位的片段。 */
function PageView({ page, index }: { page: OfdLayoutPage; index: number }): ReactNode {
  return (
    <section
      className={css.hifiPage}
      style={{ aspectRatio: `${page.widthMm} / ${page.heightMm}` }}
      aria-label={`P${index + 1}`}
    >
      {page.fragments.map((fragment, at) => <FragmentView key={at} fragment={fragment} page={page} />)}
    </section>
  )
}

function FragmentView({ fragment, page }: { fragment: Fragment; page: OfdLayoutPage }): ReactNode {
  const left = percent(fragment.xMm, page.widthMm)
  const top = percent(fragment.yMm, page.heightMm)
  if (fragment.kind === 'image') {
    return fragment.url !== undefined
      ? (
        <img
          className={css.image}
          style={{ left, top, width: percent(fragment.wMm, page.widthMm), height: percent(fragment.hMm, page.heightMm) }}
          src={fragment.url}
          alt=""
        />
      )
      : (
        <span
          className={css.unresolvedImage}
          style={{ left, top, width: percent(fragment.wMm, page.widthMm), height: percent(fragment.hMm, page.heightMm) }}
        />
      )
  }
  return (
    <span
      className={css.text}
      style={{
        left,
        top,
        // 字号按页面宽度的百分比表达，随侧栏宽度等比缩放（1cqw = 页宽的 1%）。
        fontSize: `${(fragment.sizeMm / page.widthMm * 100).toFixed(3)}cqw`,
      }}
    >{fragment.text}</span>
  )
}

/**
 * Present complete OFD bytes as a paged layout skeleton.
 * @param props - document bytes and locale.
 * @returns the paged layout surface.
 */
export function OfdHifiBody({ content, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  t: (key: 'hifiLoading' | 'hifiFailed') => string
}): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [pages, setPages] = useState<readonly OfdLayoutPage[]>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (data === undefined) {
      setFailed(true)
      return
    }
    let disposed = false
    readOfdLayout(data).then((built) => {
      if (!disposed) setPages(built)
    }).catch(() => {
      if (!disposed) setFailed(true)
    })
    return () => { disposed = true }
  }, [data])

  const body = useMemo(() => {
    if (failed) return <p className={css.status} role="alert">{t('hifiFailed')}</p>
    if (pages === undefined) return <LoadingIndicator className={css.status} label={t('hifiLoading')} />
    return pages.map((page, index) => <PageView key={index} page={page} index={index} />)
  }, [pages, failed, t])

  return <div className={css.hifi}>{body}</div>
}
