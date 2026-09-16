/**
 * OFD 高保真预览（版式）：毫米坐标以页面百分比定位；文本/路径片段用
 * SVG viewBox（毫米局部坐标系）随宽度等比缩放——文本按基线渲染
 * （DeltaX/DeltaY 已在解析期分组），矢量与图片按图层顺序叠加。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdLayout } from './ofd-layout.ts'
import type { OfdLayoutPage, OfdImageFragment, OfdTextFragment, OfdPathFragment } from './ofd-layout.ts'
import css from './OfdHifiBody.module.css'

type Fragment = OfdTextFragment | OfdImageFragment | OfdPathFragment

/** 毫米坐标换算为页面宽/高的百分比样式。 */
function percent(valueMm: number, totalMm: number): string {
  return `${(valueMm / totalMm * 100).toFixed(3)}%`
}

/** SVG 的 CTM 变换属性（平移量在 viewBox 毫米坐标系内）。 */
function matrixOf(ctm: readonly number[] | undefined): string | undefined {
  return ctm === undefined ? undefined : `matrix(${ctm.join(' ')})`
}

/** 片段的公共定位框：页面百分比位置与尺寸。 */
function boxStyle(fragment: Fragment, page: OfdLayoutPage): React.CSSProperties {
  return {
    left: percent(fragment.xMm, page.widthMm),
    top: percent(fragment.yMm, page.heightMm),
    width: percent(fragment.wMm, page.widthMm),
    height: percent(fragment.hMm, page.heightMm),
  }
}

/** 文本对象：SVG 视口即 TextObject 边界框（毫米），基线文本随视口缩放。 */
function TextView({ fragment, page }: { fragment: OfdTextFragment; page: OfdLayoutPage }): ReactNode {
  const matrix = matrixOf(fragment.ctm)
  const hScale = fragment.hScale
  return (
    <svg className={css.object} style={boxStyle(fragment, page)} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`}>
      {fragment.runs.map((run, at) => (
        <text
          key={at}
          x={run.xMm}
          y={run.yMm}
          fontSize={fragment.sizeMm}
          fill={fragment.fill ?? '#111'}
          transform={matrix ?? (hScale !== undefined ? `matrix(${hScale}, 0, 0, 1, ${(1 - hScale) * run.xMm}, 0)` : undefined)}
        >{run.text}</text>
      ))}
    </svg>
  )
}

/** 矢量路径对象：AbbreviatedData 即局部毫米坐标的 path。 */
function PathView({ fragment, page }: { fragment: OfdPathFragment; page: OfdLayoutPage }): ReactNode {
  const stroke = fragment.stroke ?? (fragment.fill !== undefined ? undefined : '#000')
  return (
    <svg className={css.object} style={boxStyle(fragment, page)} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`}>
      <path
        d={fragment.d}
        fill={fragment.fill ?? 'none'}
        {...stroke !== undefined ? { stroke, strokeWidth: fragment.lineWidthMm ?? 0.35 } : {}}
        transform={matrixOf(fragment.ctm)}
      />
    </svg>
  )
}

/** 图片对象：资源解析失败的以虚线占位框标注。 */
function ImageView({ fragment, page }: { fragment: OfdImageFragment; page: OfdLayoutPage }): ReactNode {
  return fragment.url !== undefined
    ? <img className={css.image} style={boxStyle(fragment, page)} src={fragment.url} alt="" />
    : <span className={css.unresolvedImage} style={boxStyle(fragment, page)} />
}

/** 一页的渲染：白底页框内按文档顺序叠加的片段。 */
function PageView({ page, index }: { page: OfdLayoutPage; index: number }): ReactNode {
  return (
    <section
      className={css.hifiPage}
      style={{ aspectRatio: `${page.widthMm} / ${page.heightMm}` }}
      aria-label={`P${index + 1}`}
    >
      {page.fragments.map((fragment, at) => fragment.kind === 'text'
        ? <TextView key={at} fragment={fragment} page={page} />
        : fragment.kind === 'path'
          ? <PathView key={at} fragment={fragment} page={page} />
          : <ImageView key={at} fragment={fragment} page={page} />)}
    </section>
  )
}

/**
 * Present complete OFD bytes as a paged layout.
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
