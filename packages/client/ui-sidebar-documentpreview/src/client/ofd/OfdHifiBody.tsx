/**
 * OFD 高保真预览（版式）：毫米坐标以页面百分比定位；文本/路径片段用
 * SVG viewBox（毫米局部坐标系）随宽度等比缩放。缩放是布局式的——手势
 * 只改列宽（百分比），内容按新尺寸原生重绘，任意倍率都保持清晰且无
 * 闪烁；平移走原生滚动（隐藏滚动条）与拖拽。文本经透明选择层可选中
 * 复制（PDF.js 模式），右下角百分比徽标点击复位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdLayout } from './ofd-layout.ts'
import type { OfdLayoutPage, OfdImageFragment, OfdTextFragment, OfdPathFragment } from './ofd-layout.ts'
import css from './OfdHifiBody.module.css'

const WHEEL_ZOOM_SENSITIVITY = 0.007
const GESTURE_FACTOR_MIN = 0.5
const GESTURE_FACTOR_MAX = 2
const GESTURE_COMMIT_MS = 160
const ZOOM_MAX = 8
/** 字形基线到 em 框顶部的近似比例（中文字体 ascent）。 */
const BASELINE_ASCENT = 0.86

/** 毫米坐标换算为页面宽/高的百分比样式。 */
function percent(valueMm: number, totalMm: number): string {
  return `${(valueMm / totalMm * 100).toFixed(3)}%`
}

/** SVG 的 CTM 变换属性（平移量在 viewBox 毫米坐标系内）。 */
function matrixOf(ctm: readonly number[] | undefined): string | undefined {
  return ctm === undefined ? undefined : `matrix(${ctm.join(' ')})`
}

/** 文本对象：SVG 视口即 TextObject 边界框（毫米），基线文本随视口缩放。 */
function TextView({ fragment, page }: { fragment: OfdTextFragment; page: OfdLayoutPage }): ReactNode {
  const matrix = matrixOf(fragment.ctm)
  const hScale = fragment.hScale
  return (
    <svg className={css.object} style={{ left: percent(fragment.xMm, page.widthMm), top: percent(fragment.yMm, page.heightMm), width: percent(fragment.wMm, page.widthMm), height: percent(fragment.hMm, page.heightMm) }} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`} aria-hidden="true">
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

/**
 * 透明选择层：与 SVG 字形重合的 HTML 文本（PDF.js 文本层模式），
 * 供鼠标选中复制；命中高亮交给 ::selection。带 CTM/HScale 的文本
 * 不参与（变换后选择框会错位）。
 */
function SelectionLayer({ fragment, page }: { fragment: OfdTextFragment; page: OfdLayoutPage }): ReactNode {
  if (fragment.ctm !== undefined || fragment.hScale !== undefined) return null
  return (
    <span className={css.selectionLayer} data-selection-layer="">
      {fragment.runs.map((run, at) => (
        <span
          key={at}
          className={css.selectionRun}
          style={{
            left: percent(run.xMm, page.widthMm),
            top: percent(run.yMm - fragment.sizeMm * BASELINE_ASCENT, page.heightMm),
            fontSize: `${(fragment.sizeMm / page.widthMm * 100).toFixed(3)}cqw`,
            fontFamily: fragment.family,
          }}
        >{run.text}</span>
      ))}
    </span>
  )
}

/** 矢量路径对象：AbbreviatedData 即局部毫米坐标的 path。 */
function PathView({ fragment, page }: { fragment: OfdPathFragment; page: OfdLayoutPage }): ReactNode {
  const stroke = fragment.stroke ?? (fragment.fill !== undefined ? undefined : '#000')
  return (
    <svg className={css.object} style={{ left: percent(fragment.xMm, page.widthMm), top: percent(fragment.yMm, page.heightMm), width: percent(fragment.wMm, page.widthMm), height: percent(fragment.hMm, page.heightMm) }} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`}>
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
  const style: CSSProperties = {
    left: percent(fragment.xMm, page.widthMm),
    top: percent(fragment.yMm, page.heightMm),
    width: percent(fragment.wMm, page.widthMm),
    height: percent(fragment.hMm, page.heightMm),
    ...(fragment.blend !== undefined ? { mixBlendMode: fragment.blend } : {}),
  }
  return fragment.url !== undefined
    ? <img className={css.image} style={style} src={fragment.url} alt="" />
    : (
      <span
        className={css.unresolvedImage}
        style={{
          left: percent(fragment.xMm, page.widthMm),
          top: percent(fragment.yMm, page.heightMm),
          width: percent(fragment.wMm, page.widthMm),
          height: percent(fragment.hMm, page.heightMm),
        }}
      />
    )
}

/** 一页的渲染：白底页框内按文档顺序叠加的片段 + 选择层。 */
function PageView({ page, index }: { page: OfdLayoutPage; index: number }): ReactNode {
  return (
    <section
      className={css.hifiPage}
      style={{ aspectRatio: `${page.widthMm} / ${page.heightMm}` }}
      aria-label={`P${index + 1}`}
    >
      {page.fragments.map((fragment, at) => fragment.kind === 'text'
        ? (
          <span key={at} className={css.fragment}>
            <TextView fragment={fragment} page={page} />
            <SelectionLayer fragment={fragment} page={page} />
          </span>
        )
        : fragment.kind === 'path'
          ? <PathView key={at} fragment={fragment} page={page} />
          : <ImageView key={at} fragment={fragment} page={page} />)}
    </section>
  )
}

/**
 * Present complete OFD bytes as a paged layout with layout-based zoom
 * (crisp at every scale), drag panning, and a selectable text layer.
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
  const zoomRef = useRef(1)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ readonly x: number; readonly y: number } | undefined>()
  const settle = useRef<number | undefined>(undefined)

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

  useEffect(() => () => { window.clearTimeout(settle.current) }, [])

  /**
   * 布局式缩放：只改列宽，内容（百分比定位 + SVG viewBox + cqw 字号）
   * 按新尺寸原生重绘——全程清晰。锚点：缩放后调整原生滚动，保持指针
   * 下的内容不动。手势期间徽标文字直写 DOM，空闲后提交 React 状态。
   */
  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    const viewport = viewportRef.current
    const column = columnRef.current
    if (viewport === null || column === null) return
    const previous = zoomRef.current
    const next = Math.min(Math.max(previous * factor, 1), ZOOM_MAX)
    if (next === previous) return
    const fitX = (viewport.scrollLeft + anchorX) / previous
    const fitY = (viewport.scrollTop + anchorY) / previous
    zoomRef.current = next
    column.style.width = `${(next * 100).toFixed(2)}%`
    viewport.scrollLeft = fitX * next - anchorX
    viewport.scrollTop = fitY * next - anchorY
    const badge = hostRef.current?.querySelector<HTMLElement>(`.${css.zoomBadge}`)
    if (badge !== null && badge !== undefined) badge.textContent = `${Math.round(next * 100)}%`
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => { setZoom(zoomRef.current) }, GESTURE_COMMIT_MS)
  }, [])

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    // 触控板捏合与 Ctrl/⌘+滚轮缩放；普通滚轮交给原生滚动。
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const factor = Math.min(
      Math.max(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), GESTURE_FACTOR_MIN),
      GESTURE_FACTOR_MAX,
    )
    const bounds = event.currentTarget.getBoundingClientRect()
    zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
  }, [zoomAt])

  // 放大后拖拽平移（原生滚动）；fit 态不拦截，让文本可正常选中。
  const scrollable = (): boolean => {
    const viewport = viewportRef.current
    return viewport !== null && zoomRef.current > 1
      && (viewport.scrollWidth > viewport.clientWidth + 1 || viewport.scrollHeight > viewport.clientHeight + 1)
  }

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !scrollable()) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* capture refused; the drag continues on shared handlers */ }
    drag.current = { x: event.clientX, y: event.clientY }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const viewport = viewportRef.current
    if (held === undefined || viewport === null) return
    viewport.scrollLeft -= event.clientX - held.x
    viewport.scrollTop -= event.clientY - held.y
    drag.current = { x: event.clientX, y: event.clientY }
  }, [])

  const onPointerUp = useCallback((): void => {
    drag.current = undefined
  }, [])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    // 文本上的双击保留原生选词。
    if ((event.target as Element).closest('[data-selection-layer]') !== null) return
    if (zoomRef.current > 1 + Number.EPSILON) {
      zoomAt(1 / zoomRef.current, 0, 0)
    } else {
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(2, event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }, [zoomAt])

  const body = useMemo(() => {
    if (failed) return <p className={css.status} role="alert">{t('failed')}</p>
    if (pages === undefined) return <LoadingIndicator className={css.status} label={t('loading')} />
    return pages.map((page, index) => <PageView key={index} page={page} index={index} />)
  }, [pages, failed, t])

  return (
    <div ref={hostRef} className={css.host} data-ofd-preview="">
      {/* 滚动容器只包内容；徽标是它的兄弟，钉在窗格右下角不随滚动/缩放移动。 */}
      <div
        ref={viewportRef}
        className={css.hifi}
        data-pannable={zoom > 1 || undefined}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={columnRef} className={css.column}>
          {body}
        </div>
      </div>
      {zoom > 1 && (
        <button
          type="button"
          className={css.zoomBadge}
          onClick={() => { zoomAt(1 / zoomRef.current, 0, 0) }}
        >
          {`${Math.round(zoom * 100)}%`}
        </button>
      )}
    </div>
  )
}
