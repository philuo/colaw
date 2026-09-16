/**
 * OFD 高保真预览（版式）：毫米坐标以页面百分比定位；文本/路径片段用
 * SVG viewBox（毫米局部坐标系）随宽度等比缩放。缩放采用两段式：手势
 * 期间走 GPU transform（不重排、不卡顿），空闲后一次性落到真实布局
 * （列宽按倍率变化，矢量按新尺寸重绘，结果清晰）。文本选中交给
 * WebKit 对 SVG <text> 的原生支持，无需自建文本层。平移为原生滚动
 * （隐藏滚动条）+ 放大后拖拽；右下角百分比徽标点击复位。
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
/** 与 .hifi 的 padding 保持一致（锚点换算要扣掉它）。 */
const COLUMN_PADDING = 16

/** 手势锚点：fit 空间内容点 + 指针的视口位置。 */
interface GestureAnchor {
  readonly anchorFitX: number
  readonly anchorFitY: number
  readonly anchorX: number
  readonly anchorY: number
}

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
  const box = {
    left: percent(fragment.xMm, page.widthMm),
    top: percent(fragment.yMm, page.heightMm),
    width: percent(fragment.wMm, page.widthMm),
    height: percent(fragment.hMm, page.heightMm),
  }
  return (
    <svg className={css.object} style={box} viewBox={`0 0 ${fragment.wMm} ${fragment.hMm}`}>
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
 * Present complete OFD bytes as a paged layout: hybrid zoom (transform
 * during the gesture, real layout at rest), native-scroll panning, and
 * natively selectable SVG text.
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
  const [panning, setPanning] = useState(false)
  const zoomRef = useRef(1)
  // 手势期间的实时倍率（相对已提交布局）；存在即表示手势未落地。
  const live = useRef<number | undefined>()
  // 手势锚点：第一跳捕获指针下的内容点（fit 空间 = k=1 像素），
  // 之后每一跳与落地提交都让这个点保持在指针下/原位置，全程无跳变。
  const gesture = useRef<GestureAnchor | undefined>()
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

  /** 手势帧：transform 直写（GPU，无重排），徽标直更。 */
  const applyGesture = useCallback((target: number): void => {
    const column = columnRef.current
    if (column === null) return
    const scale = target / zoomRef.current
    if (scale === 1) {
      column.style.removeProperty('will-change')
      column.style.removeProperty('transform')
    } else {
      column.style.setProperty('will-change', 'transform')
      column.style.setProperty('transform', `scale(${scale})`)
    }
    const badge = hostRef.current?.querySelector<HTMLElement>(`.${css.zoomBadge}`)
    if (badge !== null && badge !== undefined) {
      badge.hidden = false
      badge.textContent = `${Math.round(target * 100)}%`
    }
  }, [])

  /** 空闲落地：列宽改到目标倍率（真实布局，清晰）；锚点内容保持在原位置。 */
  const commitTo = useCallback((target: number): void => {
    const viewport = viewportRef.current
    const column = columnRef.current
    if (viewport === null || column === null) return
    const g = gesture.current
    live.current = undefined
    window.clearTimeout(settle.current)
    zoomRef.current = target
    column.style.width = `${(target * 100).toFixed(2)}%`
    column.style.removeProperty('will-change')
    column.style.removeProperty('transform')
    if (g !== undefined) {
      viewport.scrollLeft = COLUMN_PADDING + g.anchorFitX * target - g.anchorX
      viewport.scrollTop = COLUMN_PADDING + g.anchorFitY * target - g.anchorY
      gesture.current = undefined
    }
    setZoom(target)
  }, [])

  const zoomBy = useCallback((factor: number, anchorX: number, anchorY: number): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const k0 = zoomRef.current
    const previous = k0 * (live.current ?? 1)
    const next = Math.min(Math.max(previous * factor, 1), ZOOM_MAX)
    if (next === previous) return
    if (gesture.current === undefined) {
      // 手势第一跳：记录指针下的内容点（fit 空间，扣除列内边距）。
      gesture.current = {
        anchorFitX: (viewport.scrollLeft + anchorX - COLUMN_PADDING) / k0,
        anchorFitY: (viewport.scrollTop + anchorY - COLUMN_PADDING) / k0,
        anchorX,
        anchorY,
      }
    }
    live.current = next / k0
    applyGesture(next)
    const g = gesture.current
    viewport.scrollLeft = COLUMN_PADDING + g.anchorFitX * next - g.anchorX
    viewport.scrollTop = COLUMN_PADDING + g.anchorFitY * next - g.anchorY
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => { commitTo(next) }, GESTURE_COMMIT_MS)
  }, [applyGesture, commitTo])

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    // 触控板捏合与 Ctrl/⌘+滚轮缩放；普通滚轮交给原生滚动。
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const factor = Math.min(
      Math.max(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), GESTURE_FACTOR_MIN),
      GESTURE_FACTOR_MAX,
    )
    const bounds = event.currentTarget.getBoundingClientRect()
    zoomBy(factor, event.clientX - bounds.left, event.clientY - bounds.top)
  }, [zoomBy])

  // 放大后拖拽平移（原生滚动）；fit 态不拦截，SVG 文本可原生选中。
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
    setPanning(true)
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
    setPanning(false)
  }, [])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (zoomRef.current > 1 + Number.EPSILON || (live.current ?? 1) * zoomRef.current > 1 + Number.EPSILON) {
      commitTo(1)
    } else {
      const bounds = event.currentTarget.getBoundingClientRect()
      zoomBy(2, event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }, [commitTo, zoomBy])

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
      </div>
      {/* 徽标常驻 DOM（fit 态隐藏）：首段手势可即时露出，不等待状态提交。 */}
      <button
        type="button"
        className={css.zoomBadge}
        hidden={zoom <= 1 && live.current === undefined}
        onClick={() => { commitTo(1) }}
      >
        {`${Math.round(zoom * 100)}%`}
      </button>
    </div>
  )
}
