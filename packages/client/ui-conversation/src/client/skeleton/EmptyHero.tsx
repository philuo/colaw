// The composer remains in ConversationRoot so switching out of the blank-draft
// phase does not remount its textarea.

import type { ReactNode, RefObject } from 'react'
import {
  CatLogo, IconChevronDownOutline14, IconCircleCloseFill16, IconFolderClose16,
  IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * The workspace chip, in the two Codex-style postures:
 *
 * - bound (label present): a static folder + label row whose icon seat swaps,
 *   on hover/focus, from the folder glyph to a filled circle-X button; the
 *   click removes the directory (the flow drops to a workspace-less Session).
 *   Switching workspaces starts here too — remove first, then pick.
 * - unbound (label omitted): the closed folder + "Choose workspace" + chevron
 *   button that opens the picker menu of existing Workspaces.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → picker trigger.
 * @param props.buttonRef - picker anchor (unbound form only).
 * @param props.menuOpen - menu expansion echo (unbound form only).
 * @param props.onClick - menu toggle (unbound form only).
 * @param props.onRemove - directory removal (bound form only).
 * @returns the chip element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, onRemove, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  onClick?: () => void
  onRemove?: () => void
  t: HeroTranslate
}) {
  if (label !== undefined && onRemove !== undefined) {
    return (
      <span className={css.workspace} data-workspace-chip="bound">
        <button
          type="button"
          className={css.remove}
          aria-label={t('hero.removeWorkspace')}
          onClick={onRemove}
        >
          <IconFolderOpen16 className={css.removeFolder} size={16} />
          <IconCircleCloseFill16 className={css.removeX} size={16} />
        </button>
        <span className={css.workspaceLabel}>{label}</span>
      </span>
    )
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      <IconFolderClose16 className={css.folder} size={16} />
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Authorized renderer for the hero brand-mark slot. */
  renderSlot: ConversationSlotProps['renderSlot']
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/**
 * Render the hero chrome (headline only; no composer, no workspace row).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* Colaw cat mark leading the headline (34px square). */}
          <span className={css.fishHitbox}>
            {renderSlot('conversation.hero.brand.mark', { size: 34, className: css.fish }, {
              fallback: <CatLogo size={34} className={css.fish} />,
            })}
          </span>
          <span className={css.titleGroup}>
            <span>{t('hero.headline')}</span>
          </span>
        </div>
        <div className={css.body}>
          {/* The composer remains mounted outside this component. */}
        </div>
      </div>
      {children}
    </div>
  )
}
