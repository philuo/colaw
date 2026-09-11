/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps,
} from './contract/slots.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * Key equivalents the desktop menu answers. Shown beside the matching control's
 * tooltip; the menu, not this component, is what listens for the keystroke.
 */
const NEW_SESSION_SHORTCUT = '⌘N'
const SIDEBAR_SHORTCUT = '⌘B'

/**
 * Desktop chrome is announced by the native host (`window.__DSH_DESKTOP__`).
 * In that shell the sidebar toggle lives in the title-bar strip, to the right
 * of the traffic lights, and a collapsed sidebar is really hidden.
 */
function desktopChromeEnabled(): boolean {
  return (globalThis as { __DSH_DESKTOP__?: { chrome?: string } }).__DSH_DESKTOP__?.chrome === 'darwin'
}

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel'>
  & PropsRenderSlots<'sidebar.panellist'>

/** Each panel row subscribes only to its own selection state. */
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.panelRow, active && css.panelActive)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => { selectPanel(id) }}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}
        </span>
        {wide && (
          <span className={clsx(css.panelTitle, css.wide)}>
            {label}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  collapsedInLayout,
  width,
  startSession,
  toggleSidebar,
  selectPanel,
  usePanels,
  usePanelInfo,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const desktopChrome = desktopChromeEnabled()

  // Desktop chrome: expand/collapse + new chat live in the title-bar strip,
  // immediately right of the traffic lights, in both states.
  const titlebarControls = (
    <div className={css.titlebarControls}>
      {/* The toggle keys on the LAYOUT state (collapsedInLayout): while the
          hover-peek panel floats out, `collapsed` flips false to render it, but
          the column still holds no width — the icon keeps the expand
          affordance so peeking cannot flip the control. */}
      <Tooltip label={collapsedInLayout ? t('toggle.open') : t('toggle.collapse')} delayMs={500} shortcut={SIDEBAR_SHORTCUT}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={collapsedInLayout ? t('toggle.open') : t('toggle.collapse')}
          onClick={() => { toggleSidebar() }}
        >
          <IconPanelLeftOutline16 className={collapsedInLayout ? css.panelIconFlipped : undefined} size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('session.new.label')} delayMs={500} shortcut={NEW_SESSION_SHORTCUT}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutline16 size={16} />
        </button>
      </Tooltip>
    </div>
  )

  // A collapsed desktop sidebar is fully hidden; only its controls remain.
  if (desktopChrome && collapsed) return titlebarControls

  return (
    <>
      {/* The title-bar controls are the panel's SIBLING so they keep the
          frame's stacking context and paint above the peek panel. */}
      {desktopChrome && titlebarControls}
      <div
        ref={column}
        className={clsx(
          css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
          collapsed && wide && css.fading, !pointerInside && css.quietBars,
        )}
        style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
        onPointerEnter={() => {
          cancelLinger()
          setPointerInside(true)
        }}
        onPointerLeave={() => { armLinger() }}
        data-sidebar-panel=""
      >
        <div className={css.logoRow} />

        {/* Expanded, the button carries its own label — tooltip only on the rail. */}
        <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide} shortcut={NEW_SESSION_SHORTCUT}>
          <button
            type="button"
            className={css.newSession}
            aria-label={t('session.new.label')}
            onClick={() => { startSession() }}
          >
            <IconNewChatOutline16 size={wide ? 14 : 18} />
            {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
          </button>
        </Tooltip>

        {panels.length > 0 && (
          <nav className={css.panelList} aria-label={t('panels.label')}>
            {panels.map(({ id, label }) => (
              <PanelRow
                key={id}
                id={id}
                label={label}
                wide={wide}
                usePanelInfo={usePanelInfo}
                selectPanel={selectPanel}
                renderSlot={renderSlot}
              />
            ))}
          </nav>
        )}

        {/* The browsing region fills the column between the controls and the
          foot in both states; its rail icon column rides the same slot. */}
        <div className={css.regionArea}>
          {renderSlot('sidebar.workspaces', {
            wide,
            expandSidebar: () => { if (collapsed) toggleSidebar() },
          })}
        </div>

        {/* Footer actions stack above Settings in both sidebar widths. */}
        <div className={css.footArea}>
          <div className={css.footerActions}>
            {renderSlot('sidebar.footer.action', { wide })}
          </div>
          <div className={css.settingsArea}>
            {renderSlot('sidebar.settings', { wide })}
          </div>
        </div>
      </div>
    </>
  )
}
