/**
 * The right sidebar's only expand/collapse control, pinned to the top bar's
 * right end.
 *
 * It is drawn beside the panel, inside the frame's right column, and pinned to
 * the frame's edge rather than carried by the panel: one position serves both
 * states, so the button never moves. Opening the panel slides the strip — the
 * split and fullscreen controls at its end — in from behind this button, and
 * closing slides them back out under it.
 *
 * The frame's reserved tail (`--dsh-topbar-right-inset`) is the box it takes,
 * and the panel's strip ends before that tail, so neither writes over the
 * other. Two things make it resident rather than conditional: it is drawn
 * whether or not this session's surface has materialized (the panel seat mints
 * it a tick later), and it keeps the same footprint in both states, so the bar
 * reads whole from first paint and no row ever moves for it.
 */
import type { ReactNode } from 'react'
import { IconPanelRightCollapse24, IconPanelRightOpen24 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createSidebarRightStore } from '../stores.ts'
import css from './SidebarToggle.module.css'

/** The button's props: the session it acts on, the shared store, and copy. */
export type SidebarToggleButtonProps =
  & PropsStore<ReturnType<typeof createSidebarRightStore>>
  & PropsLocale<'sidebarRight'>
  & {
    readonly sessionId: SessionId
  }

/** The resident toggle: opens a hidden panel, collapses a shown one. */
export function SidebarToggleButton({ sessionId, useStore, actions, t }: SidebarToggleButtonProps): ReactNode {
  // A session with no surface yet is collapsed: the panel seat materializes the
  // surface on its own mount, and until then there is nothing expanded.
  const expanded = useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)
  return (
    <div className={css.seat}>
      <button
        type="button"
        className={css.button}
        aria-label={expanded ? t('chrome.collapse') : t('chrome.expand')}
        title={expanded ? t('chrome.collapse') : t('chrome.expand')}
        data-sidebar-right-toggle={expanded ? 'collapse' : 'expand'}
        onClick={() => { actions.setExpanded(sessionId, !expanded) }}
      >
        {expanded
          ? <IconPanelRightCollapse24 size={16} className={css.icon} />
          : <IconPanelRightOpen24 size={16} className={css.icon} />}
      </button>
    </div>
  )
}
