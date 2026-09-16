/**
 * OFD 高保真预览（版式）：毫米坐标以页面百分比定位；文本/路径片段用
 * SVG viewBox（毫米局部坐标系）随宽度等比缩放。交互与图片预览同款：
 * ⌘/Ctrl+滚轮锚点缩放、捏合、拖拽平移（带边缘回弹夹取）、双击 fit↔2×，
 * 右下角百分比徽标点击复位；文本经透明选择层可选中复制（PDF.js 模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { readOfdLayout } from './ofd-layout.ts'
import type { OfdLayoutPage, OfdImageFragment, OfdTextFragment, OfdPathFragment } from './ofd-layout.ts'
import css from './OfdHifiBody.module.css'

type Fragment = OfdTextFragment | OfdImageFragment | OfdPathFragment

interface ZoomState {
  readonly k: number
  readonly tx: number
  readonly ty: number
}

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

/** 平移夹取：缩放后不露白边。 */
function clampPan(translate: number, scaled: number, pane: number): number {
  const slack = pane < scaled ? (scaled - pane) / 2 : 0
  return Math.min(Math.max(translate, -slack), slack)
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
    <svg className={css.object} style={boxStyle(fragment, page)} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`} aria-hidden="true">
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
 * Present complete OFD bytes as a paged layout with image-style zoom,
 * drag pan, and a selectable text layer.
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
  const [zoom, setZoom] = useState<ZoomState>({ k: 1, tx: 0, ty: 0 })
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const columnHeight = useRef(0)
  const drag = useRef<{ readonly x: number; readonly y: number; readonly tx: number; readonly ty: number } | undefined>()
  const live = useRef<ZoomState | undefined>(undefined)
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

  // 列高（未缩放布局高）随页数与栏宽变化。
  useEffect(() => {
    const column = columnRef.current
    if (column === undefined || column === null) return
    const measure = (): void => { columnHeight.current = column.offsetHeight }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => { observer.disconnect() }
  }, [pages])

  const atFit = zoom.k <= 1 && zoom.tx === 0 && zoom.ty === 0
  const pannable = zoom.k > 1

  /** 手势期间直写 DOM；提交后由 React 状态接管。 */
  const paint = useCallback((value: ZoomState): void => {
    const column = columnRef.current
    if (column === null) return
    if (value.k <= 1 && value.tx === 0 && value.ty === 0) {
      column.style.removeProperty('will-change')
      column.style.removeProperty('transform')
    } else {
      column.style.setProperty('will-change', 'transform')
      column.style.setProperty('transform', `translate(${value.tx}px, ${value.ty}px) scale(${value.k})`)
    }
    const viewport = viewportRef.current
    const badge = viewport?.querySelector<HTMLElement>(`.${css.zoomBadge}`)
    if (badge !== null && badge !== undefined) badge.textContent = `${Math.round(value.k * 100)}%`
  }, [])

  const commitLive = useCallback((): void => {
    const value = live.current
    if (value !== undefined) {
      live.current = undefined
      setZoom(value)
    }
  }, [])

  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    const viewport = viewportRef.current
    if (viewport === null || columnHeight.current <= 0) return
    const paneWidth = viewport.clientWidth
    const paneHeight = viewport.clientHeight
    const current = live.current ?? zoom
    const from = Math.max(current.k, 1)
    const next = Math.min(Math.max(from * factor, 1), ZOOM_MAX)
    if (next === from && current.tx === 0 && current.ty === 0 && live.current === undefined) return
    // 列按左上对齐（transform-origin 0 0）：锚点保持指针下的内容不动。
    const tx = anchorX - (anchorX - current.tx) * (next / from)
    const ty = anchorY - (anchorY - current.ty) * (next / from)
    const value = {
      k: next,
      tx: clampPan(tx, paneWidth * next, paneWidth),
      ty: clampPan(ty, columnHeight.current * next, paneHeight),
    }
    live.current = value
    paint(value)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(commitLive, GESTURE_COMMIT_MS)
  }, [commitLive, paint, zoom])

  const panBy = useCallback((dx: number, dy: number): void => {
    const viewport = viewportRef.current
    if (viewport === null || columnHeight.current <= 0) return
    const current = live.current ?? zoom
    const value = {
      ...current,
      tx: clampPan(current.tx - dx, viewport.clientWidth * current.k, viewport.clientWidth),
      ty: clampPan(current.ty - dy, columnHeight.current * current.k, viewport.clientHeight),
    }
    live.current = value
    paint(value)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(commitLive, GESTURE_COMMIT_MS)
  }, [commitLive, paint, zoom])

  // 提交后的静止姿态由状态重绘（复位、栏宽变化等）。
  useEffect(() => {
    if (live.current === undefined) paint(zoom)
  }, [zoom, paint])

  useEffect(() => () => { window.clearTimeout(settle.current) }, [])

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const factor = Math.min(
        Math.max(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), GESTURE_FACTOR_MIN),
        GESTURE_FACTOR_MAX,
      )
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
      return
    }
    if (pannable) {
      event.preventDefault()
      panBy(event.deltaX, event.deltaY)
    }
  }, [panBy, pannable, zoomAt])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    // 文本上的双击保留原生选词。
    if ((event.target as Element).closest('[data-selection-layer]') !== null) return
    if (zoom.k > 1 + Number.EPSILON) {
      live.current = undefined
      setZoom({ k: 1, tx: 0, ty: 0 })
    } else {
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomAt(2, event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }, [zoom.k, zoomAt])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !pannable) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* capture refused; the drag continues on shared handlers */ }
    const current = live.current ?? zoom
    drag.current = { x: event.clientX, y: event.clientY, tx: current.tx, ty: current.ty }
    live.current = current
    setPanning(true)
  }, [pannable, zoom])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const viewport = viewportRef.current
    if (held === undefined || viewport === null || columnHeight.current <= 0) return
    const current = live.current ?? zoom
    const value = {
      ...current,
      tx: clampPan(held.tx + (event.clientX - held.x), viewport.clientWidth * current.k, viewport.clientWidth),
      ty: clampPan(held.ty + (event.clientY - held.y), columnHeight.current * current.k, viewport.clientHeight),
    }
    live.current = value
    paint(value)
  }, [paint, zoom])

  const onPointerUp = useCallback((): void => {
    drag.current = undefined
    setPanning(false)
    commitLive()
  }, [commitLive])

  const body = useMemo(() => {
    if (failed) return <p className={css.status} role="alert">{t('failed')}</p>
    if (pages === undefined) return <LoadingIndicator className={css.status} label={t('loading')} />
    return pages.map((page, index) => <PageView key={index} page={page} index={index} />)
  }, [pages, failed, t])

  return (
    <div
      ref={viewportRef}
      className={css.hifi}
      data-panning={panning || undefined}
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
      {!atFit && (
        <button
          type="button"
          className={css.zoomBadge}
          onClick={() => {
            live.current = undefined
            setZoom({ k: 1, tx: 0, ty: 0 })
          }}
        >
          {`${Math.round(zoom.k * 100)}%`}
        </button>
      )}
    </div>
  )
}
