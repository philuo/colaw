/**
 * OFD 高保真预览（版式）：毫米坐标以页面百分比定位；文本/路径片段用
 * SVG viewBox（毫米局部坐标系）随宽度等比缩放——文本按基线渲染
 * （DeltaX/DeltaY 已在解析期分组），矢量与图片按图层顺序叠加。
 * 缩放：⌘/Ctrl+滚轮或触控板捏合，页宽按倍数伸缩，徽标点击复位。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdLayout } from './ofd-layout.ts'
import type { OfdLayoutPage, OfdImageFragment, OfdTextFragment, OfdPathFragment } from './ofd-layout.ts'
import css from './OfdHifiBody.module.css'

type Fragment = OfdTextFragment | OfdImageFragment | OfdPathFragment

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4

/** 毫米坐标换算为页面宽/高的百分比样式。 */
function percent(valueMm: number, totalMm: number): string {
  return `${(valueMm / totalMm * 100).toFixed(3)}%`
}

/** SVG 的 CTM 变换属性（平移量在 viewBox 毫米坐标系内）。 */
function matrixOf(ctm: readonly number[] | undefined): string | undefined {
  return ctm === undefined ? undefined : `matrix(${ctm.join(' ')})`
}

/** 片段的公共定位框：页面百分比位置与尺寸。 */
function boxStyle(fragment: Fragment, page: OfdLayoutPage): CSSProperties {
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
          fontFamily={fragment.family}
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

/** 图片对象：资源解析失败的以虚线占位框标注；印章类图片用正片叠底。 */
function ImageView({ fragment, page }: { fragment: OfdImageFragment; page: OfdLayoutPage }): ReactNode {
  const style = { ...boxStyle(fragment, page), ...(fragment.blend !== undefined ? { mixBlendMode: fragment.blend } : {}) }
  return fragment.url !== undefined
    ? <img className={css.image} style={style} src={fragment.url} alt="" />
    : <span className={css.unresolvedImage} style={boxStyle(fragment, page)} />
}

/** 一页的渲染：白底页框内按文档顺序叠加的片段，内容裁剪在页框内。 */
function PageView({ page, index, zoom }: { page: OfdLayoutPage; index: number; zoom: number }): ReactNode {
  return (
    <section
      className={css.hifiPage}
      style={{ width: `${(zoom * 100).toFixed(1)}%`, aspectRatio: `${page.widthMm} / ${page.heightMm}` }}
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
  t: (key: 'loading' | 'failed') => string
}): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [pages, setPages] = useState<readonly OfdLayoutPage[]>()
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(1)
  const hostRef = useRef<HTMLDivElement | null>(null)

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

  useEffect(() => {
    const host = hostRef.current
    if (host === null || pages === undefined) return
    const onWheel = (event: WheelEvent): void => {
      // 触控板捏合与 Ctrl+滚轮都带 ctrlKey；普通滚轮保持原生滚动。
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(at => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, at * (event.deltaY < 0 ? 1.1 : 1 / 1.1))))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => { host.removeEventListener('wheel', onWheel) }
  }, [pages])

  const body = useMemo(() => {
    if (failed) return <p className={css.status} role="alert">{t('failed')}</p>
    if (pages === undefined) return <LoadingIndicator className={css.status} label={t('loading')} />
    return pages.map((page, index) => <PageView key={index} page={page} index={index} zoom={zoom} />)
  }, [pages, failed, t, zoom])

  return (
    <div className={css.hifi} ref={hostRef}>
      {zoom !== 1 && (
        <button
          type="button"
          className={css.zoomBadge}
          onClick={() => setZoom(1)}
          aria-label="Reset zoom"
        >
          {`${Math.round(zoom * 100)}%`}
        </button>
      )}
      {body}
    </div>
  )
}
