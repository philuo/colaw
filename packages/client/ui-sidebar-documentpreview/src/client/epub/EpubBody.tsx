/**
 * EPUB 预览：foliate 视图组件挂载滚动阅读器，附目录抽屉、翻页与字号
 * 缩放。打开顺序遵循官方 reader：先挂载视图，再 open，再注入阅读样式
 * 并跳到首屏。阅读样式跟随系统明暗主题（暗色强制底色/字色，书籍自带
 * 样式除外）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { openEpubBook } from './epub-book.ts'
import type { FoliateView } from './foliate/view.js'
import type { FoliateTocItem } from './foliate/epub.d.ts'
import { createTOCView } from './foliate/tree.js'
import './foliate/view.js'
import css from './EpubBody.module.css'

/** 注入各章节文档的阅读样式；字号档与明暗主题决定最终形态。 */
const readingStyles = (fontScale: number, dark: boolean): string => `
    html {
        color-scheme: ${dark ? 'dark' : 'light'};
        font-size: ${(14 * fontScale).toFixed(1)}px;
        ${dark ? 'background: #1f1f20; color: #d8d8d8;' : ''}
    }
    ${dark ? 'body { background: #1f1f20; color: #d8d8d8; }' : ''}
    ${dark ? 'a:link { color: #8ab4f8; }' : ''}
    p, li, blockquote, dd {
        line-height: 1.6;
        text-align: start;
        widows: 2;
    }
    pre {
        white-space: pre-wrap !important;
    }
    img, svg, video {
        max-width: 100%;
        height: auto;
    }
`

const MIN_FONT_SCALE = 0.6
const MAX_FONT_SCALE = 3

type Phase = 'loading' | 'ready' | 'failed' | 'unsupported'

/** 系统明暗主题（阅读样式跟随）。 */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => globalThis.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const query = globalThis.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => { setDark(event.matches) }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return dark
}

/** 统一尺寸的线性图标（章节前进/后退）。 */
function ChevronIcon({ direction }: { direction: 'left' | 'right' }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={direction === 'left' ? 'M10.2 2.8 L5 8 L10.2 13.2' : 'M5.8 2.8 L11 8 L5.8 13.2'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 目录抽屉：官方 createTOCView 树 + 当前位置跟随。 */
function TocDrawer({ view, toc, onClose }: {
  view: FoliateView
  toc: readonly FoliateTocItem[]
  onClose: () => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const { element } = createTOCView(toc, (href) => {
      void view.goTo(href)
      onClose()
    })
    host.append(element)
    return () => { element.remove() }
  }, [view, toc, onClose])
  return (
    <div className={css.drawer}>
      <div className={css.drawerTitle}>目录</div>
      <div className={css.drawerBody} ref={hostRef} />
    </div>
  )
}

/**
 * Present complete EPUB bytes as a scrolled foliate reader with TOC,
 * page turns, and font-size zoom.
 * @param props - document bytes and locale.
 * @returns the reading surface.
 */
export function EpubBody({ content, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  t: (key: 'loading' | 'failed' | 'unsupported') => string
}): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<Phase>('loading')
  const [toc, setToc] = useState<readonly FoliateTocItem[]>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [fontScale, setFontScale] = useState(1)
  const dark = usePrefersDark()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<FoliateView | null>(null)

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
      viewRef.current = view
      hostRef.current?.append(view)
      await view.open(book)
      // disposed 在 open 的 await 期间翻转会错过清理：这里补一次。
      if (isDisposed()) {
        view.close()
        view.remove()
        return
      }
      // 滚动模式适合侧栏窄幅：连续排版，靠原生滚动翻页。
      view.renderer.setAttribute('flow', 'scrolled')
      view.renderer.setStyles?.(readingStyles(1, dark))
      await view.renderer.next()
      setToc(book.toc)
      setState('ready')
    }).catch(() => {
      if (!isDisposed()) setState('failed')
    })
    return () => {
      disposed = true
      viewRef.current = null
      view?.close()
      view?.remove()
    }
  }, [data, dark])

  // 重注入阅读样式实现字号档与主题切换（重排式内容的缩放即字号缩放）。
  useEffect(() => {
    if (state !== 'ready') return
    viewRef.current?.renderer.setStyles?.(readingStyles(fontScale, dark))
  }, [fontScale, dark, state])

  const turn = (direction: 'goLeft' | 'goRight'): void => {
    void viewRef.current?.[direction]()
  }

  if (state === 'unsupported') return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (state === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const view = viewRef.current
  return (
    <div className={css.host}>
      {state === 'ready' && view !== null && toc !== undefined && toc.length > 0 && (
        <div className={css.bar}>
          <button type="button" className={css.barButton} onClick={() => setDrawerOpen(open => !open)}>目录</button>
          <span className={css.barSpring} />
          <button type="button" className={css.barButton} aria-label="Previous page" title="上一页" onClick={() => turn('goLeft')}>
            <ChevronIcon direction="left" />
          </button>
          <button type="button" className={css.barButton} aria-label="Next page" title="下一页" onClick={() => turn('goRight')}>
            <ChevronIcon direction="right" />
          </button>
          <button type="button" className={css.barButton} aria-label="Smaller text" title="缩小字号" onClick={() => setFontScale(scale => Math.max(MIN_FONT_SCALE, scale - 0.15))}>A−</button>
          <button type="button" className={css.barButton} aria-label="Larger text" title="放大字号" onClick={() => setFontScale(scale => Math.min(MAX_FONT_SCALE, scale + 0.15))}>A+</button>
        </div>
      )}
      {drawerOpen && view !== null && toc !== undefined && (
        <TocDrawer view={view} toc={toc} onClose={() => setDrawerOpen(false)} />
      )}
      {state === 'ready' ? null : <LoadingIndicator className={css.status} label={t('loading')} />}
      <div ref={hostRef} className={state === 'ready' ? css.reader : css.readerBehind} />
    </div>
  )
}
