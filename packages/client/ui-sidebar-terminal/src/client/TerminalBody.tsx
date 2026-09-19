/** Sidebar terminal screen and connection recovery. */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalViewState, TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { TerminalBodyInjected } from './face.ts'
import type {} from './locales.ts'
import '@xterm/xterm/css/xterm.css'
import css from './TerminalBody.module.css'
import { TerminalTheme } from './terminal-theme.ts'
import { observeTerminalCursor } from './terminal-cursor.ts'

/** Standard sidebar owner share plus terminal model and localized copy. */
export type TerminalBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalBodyInjected>

/**
 * Minimum gap between PTY resizes while a drag is in flight. Every resize makes
 * the running program redraw, so this bounds the redraw rate during a drag
 * without making the pane wait for the drag to end; the trailing edge always
 * delivers the final size.
 */
const ptyResizeInterval = 80

/**
 * Render the retained terminal with the application theme.
 * @param props - sidebar occurrence, model lookup and translated copy.
 * @returns the terminal screen and any pending or exceptional state.
 */
export function TerminalBody({ useTabInfo, useTerminal, useTheme, view, t }: TerminalBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const theme = useTheme(value => value)
  const model = view(tab.id)
  const state = useTerminal(tab.id)
  useEffect(() => model.mount(), [model])
  if (state === undefined) return null
  const error = state.issue === undefined ? state.error ?? state.info?.error : t(state.issue)
  let status: string | undefined
  if (state.phase === 'idle' || state.phase === 'loading') status = t('loading')
  else if (state.phase === 'creating' || state.phase === 'connecting' || state.phase === 'disconnected') status = t(state.phase)
  else if (state.info?.state === 'exited') status = t('exited', { code: String(state.info.exitCode ?? '—') })
  else if (state.info?.state === 'failed') status = t('unavailable')
  else if (state.phase === 'closed') status = t('closed')
  const retry = state.phase === 'failed' || state.phase === 'disconnected'
  const readOnly = state.phase === 'connected' && state.info?.state === 'running' && !state.writable
  return (
    <section className={css.root} data-sidebar-terminal>
      {/* The pane is the terminal from its first frame, so the emulator is
         mounted unconditionally: it is what the pane measures itself against
         before the shell is allocated, and unmounting it on a phase change would
         discard a retained grid and collapse the pane height. */}
      <TerminalScreen state={state} model={model} visible={tab.visible} label={t('title')} theme={theme} />
      {(status !== undefined || retry || readOnly) && <div className={css.status} role="status">
        <div className={css.notice}>
          {status}
          {readOnly && <>{t('readonly')} <button type="button" onClick={() => { model.connect() }}>{t('control')}</button></>}
          {retry && (state.info === undefined
            ? <button type="button" onClick={() => { void model.refresh() }}>{t('retry')}</button>
            : <button type="button" onClick={() => { model.connect() }}>{t('reconnect')}</button>)}
        </div>
      </div>}
      {error !== undefined && <p className={css.error} role="alert">{t('failed', { message: error })}</p>}
    </section>
  )
}

/* oxlint-disable typescript/no-non-null-assertion -- React sets the DOM ref, then these effects initialize and use the emulator. */
function TerminalScreen({ state, model, visible, label, theme }: {
  state: TerminalViewState
  model: TerminalView
  visible: boolean
  label: string
  theme: ThemeSnapshot
}): ReactNode {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>()
  const fit = useRef<FitAddon>()
  const colors = useRef<TerminalTheme>()
  const lastRevision = useRef(0)
  const current = useRef({ state, visible })
  current.current = { state, visible }

  useLayoutEffect(() => {
    const node = element.current!
    const environment = current.current.state.environment
    const xterm = new Terminal({
      // Kept at the value this pane has always shipped. It rewrites the ANSI
      // palette to reach the ratio on a light background, which darkens most
      // entries, so it is a deliberate look rather than an oversight.
      minimumContrastRatio: 4.5, cursorBlink: true, fontSize: 12.942,
      // `ui-monospace` — the same font macOS Terminal.app uses. WebKit resolves
      // it to SF Mono (`.SF NS Mono`, a leading-dot system family that no name
      // lookup can reach: `"SF Mono"` and `"SFMono-Regular"` both fall through to
      // the generic monospace). Measured advance 8.036px at 13px = 0.618em, which
      // matches `.SF NS Mono`'s 0.618 and no other installed monospace (Menlo and
      // Andale are 0.600, Menlo 0.602), so the glyphs match the native terminal's.
      // The block art does not depend on the font: the canvas and WebGL renderers
      // draw U+2580-259F themselves (blockElementDefinitions, with customGlyphs
      // defaulting to true), which is why the mascot stays solid in every font —
      // verified against Menlo, Andale and a fallback face.
      //
      // 12.941px, and the fraction is load-bearing. The atlas renderers rasterise
      // glyphs into a cell sized in whole device pixels; SF Mono advances 0.618em,
      // so an 8.000 CSS px advance (16 device px at DPR 2, 8 at DPR 1, 12 at 1.5)
      // needs exactly this size. Get it wrong and every glyph is drawn into a cell
      // narrower or wider than itself — 0.90 antialiased pixels per inked pixel
      // against 0.74 when the geometry is exact, i.e. visibly soft text.
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei Mono", monospace',
      // The Host's scrollback cap arrives with the environment request, which
      // is after this emulator exists. xterm's own default already retains
      // history, so the option is only set when the answer is known — passing
      // an explicit `undefined` would disable scrollback outright, which is
      // what made the pane unable to scroll at all.
      ...environment === undefined ? {} : { scrollback: environment.scrollback },
    })
    const addon = new FitAddon()
    xterm.loadAddon(addon)
    xterm.open(node)
    // Draw with the WebGL renderer: it rasterises each glyph once into a texture
    // atlas and blits it at integer cell positions, so a block-art TUI (Claude
    // Code's mascot is a grid of █ with a ▄ eye row) is one solid shape. The DOM
    // renderer lays each cell out on its own at a fractional x, so every column
    // gets its own antialiasing — next to a native terminal the same logo showed
    // vertical seams and a slightly different tint per column.
    //
    // A WebGL context can be lost — the platform reclaims them and a page may
    // only hold a handful — and a lost one leaves a dead canvas in place, so the
    // handler drops the addon and lets xterm fall back to the DOM renderer.
    // Measured here: after `dispose()` the canvases are gone and the DOM rows are
    // back, with the buffer untouched. The addon itself is also optional: a
    // webview without WebGL2 throws on load and keeps the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl.dispose() })
      xterm.loadAddon(webgl)
    } catch (error) {
      console.warn('Terminal WebGL renderer unavailable, using the DOM renderer:', error)
    }
    // Report the pane's size before the view's mount effect allocates the
    // process, so the shell starts at the box it will be drawn in. A terminal
    // created at a placeholder size lays its banner and prompt out for that
    // wrong box, and the fit that follows reflows the grid — re-wrapped text
    // and a prompt pushed down the pane, at the moment a tab is opened.
    const measured = addon.proposeDimensions()
    if (measured !== undefined && Number.isFinite(measured.cols) && Number.isFinite(measured.rows)
      && measured.cols >= 2 && measured.rows >= 1) {
      model.prefer(
        Math.min(measured.cols, environment?.maxCols ?? measured.cols),
        Math.min(measured.rows, environment?.maxRows ?? measured.rows),
      )
    }
    const palette = new TerminalTheme(xterm)
    colors.current = palette
    const cursor = observeTerminalCursor(xterm, node, () => palette.cursor)
    xterm.textarea?.setAttribute('aria-label', label)
    terminal.current = xterm
    fit.current = addon
    lastRevision.current = 0
    const input = xterm.onData((data) => { model.write(data) })
    // A pane resize or sidebar drag fires the observer continuously, and the
    // two halves of a resize want different timing:
    //   - the local grid must follow every event, because reflowing the rows we
    //     already have is what makes the pane track the pointer;
    //   - the PTY must be throttled, because each resize makes the program
    //     redraw and one resize per event is one redraw per frame.
    // The first event fires immediately and the last size always lands, so a
    // drag re-lays-out the program while it happens — the way a native terminal
    // behaves — instead of snapping into place only after the drag ends.
    let resizeTimer: number | undefined
    let sentAt = 0
    let pending: { cols: number; rows: number } | undefined
    const settle = (): void => {
      const next = pending
      pending = undefined
      resizeTimer = undefined
      if (next === undefined || !current.current.visible || !current.current.state.writable) return
      sentAt = Date.now()
      model.resize(next.cols, next.rows)
    }
    const measure = (): void => {
      if (!current.current.state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      const dimensions = addon.proposeDimensions()
      const environment = current.current.state.environment
      if (dimensions === undefined || environment === undefined) return
      const cols = Math.min(dimensions.cols, environment.maxCols)
      const rows = Math.min(dimensions.rows, environment.maxRows)
      if (cols < 2 || rows < 1) return
      if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
      pending = { cols, rows }
      if (resizeTimer !== undefined) return
      const wait = ptyResizeInterval - (Date.now() - sentAt)
      if (wait > 0) resizeTimer = window.setTimeout(settle, wait)
      else settle()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
      window.clearTimeout(resizeTimer)
      input.dispose()
      cursor.dispose()
      palette.dispose()
      xterm.dispose()
      terminal.current = undefined
      fit.current = undefined
    }
  }, [model])

  useLayoutEffect(() => {
    const style = getComputedStyle(element.current!)
    colors.current!.update(style.backgroundColor, style.color)
  }, [theme, model])

  useLayoutEffect(() => {
    const xterm = terminal.current!
    const scrollback = state.environment?.scrollback
    if (scrollback !== undefined && xterm.options.scrollback !== scrollback) xterm.options.scrollback = scrollback
  }, [state.environment?.scrollback, model])

  useLayoutEffect(() => {
    const xterm = terminal.current!
    const render = state.render
    if (render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    if (render.frame.type === 'snapshot') {
      xterm.reset()
      xterm.resize(render.frame.info.cols, render.frame.info.rows)
    }
    xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => { model.acknowledge(render.revision) })
  }, [state.render, model])

  useLayoutEffect(() => {
    const xterm = terminal.current!
    xterm.options.disableStdin = !state.writable
    if (visible && state.writable && element.current?.clientWidth && element.current.clientHeight) {
      fitScreen(xterm, fit.current!, state, model)
    } else if (state.info !== undefined && !state.writable) xterm.resize(state.info.cols, state.info.rows)
  }, [visible, state.writable, state.info?.cols, state.info?.rows, model])
  useEffect(() => {
    terminal.current!.textarea?.setAttribute('aria-label', label)
  }, [label])
  useEffect(() => { if (visible && state.writable) terminal.current!.focus() }, [visible, state.writable])
  return <div className={css.screen} ref={element} />
}
/* oxlint-enable typescript/no-non-null-assertion */

function fitScreen(xterm: Terminal, fit: FitAddon, state: TerminalViewState, model: TerminalView): void {
  const dimensions = fit.proposeDimensions()
  const environment = state.environment
  if (dimensions === undefined || environment === undefined) return
  const cols = Math.min(dimensions.cols, environment.maxCols)
  const rows = Math.min(dimensions.rows, environment.maxRows)
  if (cols < 2 || rows < 1) return
  xterm.resize(cols, rows)
  model.resize(cols, rows)
}
