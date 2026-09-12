/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar), the drag handles (pointer capture + rAF throttle), the column
 * solve (columns.ts), and the child-slot render decisions: the sidebar slot
 * receives live parameters from that solve. The root-scoped main slot selects
 * the Conversation or a global panel. Each column occupant owns its Session
 * binding and reports the geometry it needs.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, RIGHTBAR_DEFAULT_RATIO, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Desktop chrome is announced by the native host through an index-injected
 * global (`window.__DSH_DESKTOP__`): the window uses a transparent title bar
 * with inset traffic lights, so the shell owns a top inset, a draggable strip,
 * and a hover-peek rail. Absent in the browser surface.
 */
interface DesktopChromeMarker {
  chrome?: string
  titlebarInset?: number
}

/**
 * Unified top-bar height in desktop chrome. Every header control — the sidebar
 * toggle, New Session, the session title and preset, the open-locally pill, and
 * the right-panel toggle — centres in this one band instead of living in the
 * title-bar strip and the conversation header as two separate rows.
 */
const TOPBAR_HEIGHT = 42

/**
 * Horizontal room the two floating sidebar controls take, right of their
 * `left` anchor: two 28px buttons, a 4px gap, and 8px of breathing room. A
 * collapsed desktop sidebar drops its track, so the conversation header must
 * reserve this much itself before its title can follow them.
 */
const TOPBAR_CONTROLS_WIDTH = 68

function desktopChromeMarker(): DesktopChromeMarker | undefined {
  const marker = (globalThis as { __DSH_DESKTOP__?: DesktopChromeMarker }).__DSH_DESKTOP__
  return marker?.chrome === 'darwin' ? marker : undefined
}

/**
 * Send one window command to the desktop host.
 *
 * The preload owns the channel and the host reads the command out of the
 * event's detail; a browser surface has no host, so the send is simply dropped
 * there.
 * @param command - name the host's window-command handler answers.
 */
function sendDesktopCommand(command: 'toggle-window-zoom'): void {
  const send = (globalThis as { __electrobunSendToHost?: (message: unknown) => void }).__electrobunSendToHost
  send?.({ id: command })
}

/**
 * Chrome that a press must not be read as a window drag: every control that
 * answers a click of its own.
 */
const DRAG_REGION_CONTROLS = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"]'

/**
 * Drag-region markers the host preload reads, plus the custom property a
 * stylesheet's `app-region` declaration is mirrored into — the webview drops the
 * unsupported property from the CSSOM, so the preload rewrites every
 * `-webkit-app-region`/`app-region`/`window-drag` declaration in place and the
 * mirrored value is all the page can still read back.
 */
const PRELOAD_DRAG_CLASS = 'electrobun-webkit-app-region-drag'
const PRELOAD_NO_DRAG_CLASS = 'electrobun-webkit-app-region-no-drag'
const MIRRORED_REGION_PROPERTY = '--electrobun-app-region'
const REGION_PROPERTIES = [
  MIRRORED_REGION_PROPERTY, '-webkit-app-region', 'app-region', 'window-drag',
] as const

/** How a stylesheet spells a region, for an element that carries one inline. */
const INLINE_REGION = /(?:^|;)\s*(?:-webkit-app-region|app-region|window-drag)\s*:\s*(no-drag|drag)\b/i

type AppRegion = 'drag' | 'no-drag' | null

function normalizedRegion(value: string | null | undefined): AppRegion {
  const trimmed = (value ?? '').trim()
  if (trimmed === 'no-drag') return 'no-drag'
  if (trimmed === 'drag') return 'drag'
  return null
}

/** The region one element declares, read in the order the preload reads it. */
function elementRegion(
  element: Element,
  readComputedStyle: (element: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'>,
): AppRegion {
  if (element.classList.contains(PRELOAD_NO_DRAG_CLASS)) return 'no-drag'
  // Our own marker for the strips the frame paints behind the header. The
  // preload never sees it, but a press on a strip lands on the strip, so it has
  // to read as a drag region here as well.
  if (element.hasAttribute('data-dsh-window-drag')) return 'drag'
  const inline = element.getAttribute('style')
  if (inline !== null) {
    const declared = normalizedRegion(INLINE_REGION.exec(inline)?.[1])
    if (declared !== null) return declared
  }
  for (const property of REGION_PROPERTIES) {
    try {
      const region = normalizedRegion(readComputedStyle(element).getPropertyValue(property))
      if (region !== null) return region
    } catch {
      // A detached element has no computed style; keep walking.
      break
    }
  }
  return element.classList.contains(PRELOAD_DRAG_CLASS) ? 'drag' : null
}

/**
 * Whether a press at `target` moves the window — the same question the host
 * preload answers for itself before it starts a native window move.
 *
 * The gesture is counted from the presses (see the double-click effect below)
 * because the native move that follows the first one swallows every later event,
 * so the page must decide for itself whether a press was in the title bar. It
 * decides by asking the preload's question — walk up, `no-drag` is a hard stop —
 * rather than by testing for the drag strips: the strips sit *behind* the title
 * bar's content, so a press on the title text never has one as an ancestor.
 * @param target - the pressed element, as the event reports it.
 * @param readComputedStyle - computed-style reader, injected so this is testable.
 */
export function isWindowDragTarget(
  target: EventTarget | null,
  readComputedStyle: (element: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'> =
    element => getComputedStyle(element),
): boolean {
  let element: Element | null = target instanceof Element ? target : null
  let drag = false
  while (element !== null) {
    const region = elementRegion(element, readComputedStyle)
    if (region === 'no-drag') return false
    if (region === 'drag') drag = true
    element = element.parentElement
  }
  return drag
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    callbacks.current.onDrag(e.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === e.pointerId) endDrag()
  }, [endDrag])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  usePanelInfo,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      // The frame fills the webview, so the window is its physical ceiling:
      // without the clamp, a frame whose content momentarily overflows feeds
      // its own grown box back as the viewport, and the concession loop
      // chases it (a persisted wide layout would reopen off-window forever).
      const width = Math.min(el.getBoundingClientRect().width, window.innerWidth)
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const desktopMarker = desktopChromeMarker()
  const desktopChrome = desktopMarker !== undefined

  // Buttons never join the Tab ring (product decision: this is a chat-first
  // desktop shell whose typing target is the composer; Tab hopping through
  // toolbars and message controls is noise, and native shortcuts already
  // reach every action). Stamped in the DOM rather than per-component so the
  // rule covers every button, present and future; an author's explicit
  // tabIndex wins, and -1 keeps the element focusable programmatically
  // (focus traps, .focus()) — only sequential traversal is removed.
  useEffect(() => {
    const stamp = (root: ParentNode): void => {
      for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
        if (!button.hasAttribute('tabindex')) button.tabIndex = -1
      }
    }
    stamp(document)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node instanceof HTMLButtonElement && !node.hasAttribute('tabindex')) node.tabIndex = -1
          stamp(node)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  // Desktop chrome: double-clicking the title bar toggles the window's zoom —
  // what macOS itself runs on that gesture. The strip's drag is started by the
  // host's preload on mousedown, and the native window move that follows swallows
  // mouseup, click, and dblclick: the page never sees them. The gesture is
  // therefore counted from the presses themselves, which the page does see. A
  // capture-phase listener runs ahead of the preload's, so the second press can
  // be claimed before it starts a move of its own, and `preventDefault` keeps
  // every such press from starting a text selection — otherwise the drag
  // region's default.
  useEffect(() => {
    if (!desktopChrome) return
    const DOUBLE_PRESS_MS = 400
    let lastPressAt = 0
    const onMouseDown = (event: MouseEvent): void => {
      if (!isWindowDragTarget(event.target)) return
      const target = event.target
      if (target instanceof Element && target.closest(DRAG_REGION_CONTROLS) !== null) return
      // The window is already moving with the pointer; the word under it must
      // not come away as well.
      event.preventDefault()
      if (event.timeStamp - lastPressAt > DOUBLE_PRESS_MS) {
        lastPressAt = event.timeStamp
        return
      }
      lastPressAt = 0
      event.stopImmediatePropagation()
      sendDesktopCommand('toggle-window-zoom')
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => { document.removeEventListener('mousedown', onMouseDown, true) }
  }, [desktopChrome])

  // Desktop chrome: a collapsed sidebar has NO track (it is really hidden; only
  // its floating toggle remains next to the traffic lights) and hovering that
  // toggle floats the panel out over the conversation.
  const [peeking, setPeeking] = useState(false)
  const desktopHidden = desktopChrome && sidebarCollapsed
  const peekingNow = desktopHidden && peeking
  useEffect(() => { if (!desktopHidden) setPeeking(false) }, [desktopHidden])
  // macOS fullscreen hides the traffic lights, so the title-bar controls move
  // left. The native host is the authority (a maximized window is not
  // fullscreen): it pushes `__DSH_DESKTOP_FULLSCREEN__` and a change event.
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    if (!desktopChrome) return
    const update = (): void => {
      setFullscreen((globalThis as { __DSH_DESKTOP_FULLSCREEN__?: boolean }).__DSH_DESKTOP_FULLSCREEN__ === true)
    }
    update()
    window.addEventListener('dsh:desktop-fullscreen', update)
    return () => { window.removeEventListener('dsh:desktop-fullscreen', update) }
  }, [desktopChrome])
  // The remembered drag width, which a collapse does not clear — so re-expanding
  // (and a narrow re-widen) returns to the width the user chose.
  const sidebarPreference = sidebarCollapsed ? 0 : layoutInfo.sidebarWidth
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference)
  const cols = computeColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0)
  // The desktop collapsed state drops the rail track entirely.
  const sidebarTrack = desktopHidden ? 0 : cols.sidebar
  // The sidebar slot stays mounted (its floating toggle is the reopen affordance).
  const slotCollapsed = desktopHidden ? !peekingNow : sidebarCollapsed
  const slotWidth = peekingNow ? SIDEBAR_DEFAULT : sidebarTrack
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarWidth.current; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => {
    actions.setRightbar(rightbarBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  // macOS hides the traffic lights in fullscreen, so the two floating sidebar
  // controls re-anchor to the window edge there.
  const controlsLeft = fullscreen ? 14 : 76
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
  // The right pane's rendered width rides the --dsh-rightbar-width var below,
  // and its React subtree is memoized on drag-stable keys — so dragging the
  // divider re-renders only this frame (grid tracks + the var) and the pane's
  // whole tree (dock, tabs, previews) never re-renders per drag frame. The
  // numeric width prop stays in the contract for seats that read it, read
  // through a ref so the memo never captures a stale closure of it.
  const rightbarOpen = normal.rightbar > 0
  const rightbarWidthProp = useRef(normal.rightbar)
  rightbarWidthProp.current = normal.rightbar
  const rightbar = useMemo(() => renderSlot('rightbar', {
    width: rightbarWidthProp.current,
    viewportWidth: viewport,
    canShow: rightbarOpen,
  }), [renderSlot, viewport, rightbarOpen])
  // Render-site slot call with live concession output: a closed sidebar keeps
  // the mounted slot at the compact-rail width, and the component sees its
  // rendered state as owner params decided here (collapsed follows the resolved
  // rail, so a derived auto-collapse renders the rail UI too). Desktop chrome
  // instead hides the track and keeps only the slot's floating toggle; peeking
  // re-renders it wide at the default width, overlaying the centre.
  const sidebar = useMemo(() => renderSlot('sidebar', {
    collapsed: slotCollapsed,
    // The top-bar toggle keys on the LAYOUT state, so the hover-peek panel
    // floating out cannot flip its icon.
    collapsedInLayout: sidebarCollapsed,
    width: slotWidth,
  }), [renderSlot, slotCollapsed, sidebarCollapsed, slotWidth])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        gridTemplateColumns:
          `${sidebarTrack}px minmax(0, 1fr) ${cols.rightbar}px`,
        ...(({
          '--dsh-rightbar-width': `${normal.rightbar}px`,
        }) as CSSProperties),
        ...(desktopChrome
          ? ({
            '--dsh-titlebar-inset': `${desktopMarker.titlebarInset ?? 32}px`,
            '--dsh-titlebar-controls-left': `${controlsLeft}px`,
            '--dsh-topbar-height': `${TOPBAR_HEIGHT}px`,
            // The conversation header's title row IS the top bar, so it drops
            // the browser surface's own top padding while the bar exists.
            '--dsh-header-top-padding': '0px',
            // A hidden desktop sidebar has no track, so its two floating
            // controls overhang the conversation; the header starts past them.
            '--dsh-topbar-left-inset': desktopHidden
              ? `${controlsLeft + TOPBAR_CONTROLS_WIDTH}px`
              : '0px',
          } as CSSProperties)
          : {}),
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
      data-desktop-chrome={desktopChrome || undefined}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      {/* Draggable title-bar strips: the centre strip spans only the centre
          track, so the sidebar controls and an open right panel stay
          interactive; the sidebar column carries its own strip. */}
      {desktopChrome && (
        <div
          className={css.titlebarDrag}
          style={{ left: sidebarTrack, right: cols.rightbar }}
          data-dsh-window-drag=""
          aria-hidden="true"
        />
      )}
      <div
        className={css.sidebarCol}
        data-peeking={peekingNow || undefined}
        data-desktop-collapsed={desktopHidden || undefined}
        onPointerEnter={() => { if (desktopHidden) setPeeking(true) }}
        onPointerLeave={() => { if (desktopHidden) setPeeking(false) }}
      >
        {/* Hover target at the window's left edge: entering it (or the floating
            controls) floats the hidden sidebar out. */}
        {desktopHidden && <div className={css.peekEdge} aria-hidden="true" />}
        {/* Sidebar-column drag strip: sits below the title-bar controls. */}
        {desktopChrome && !desktopHidden && (
          <div
            className={css.sidebarDrag}
            style={{ width: sidebarTrack }}
            data-dsh-window-drag=""
            aria-hidden="true"
          />
        )}
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>
          {rightbar}
        </RightbarColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
