/**
 * Trash settings section: the archived-session recycle bin, as one column
 * that swaps between two views. The list view rows every archived session
 * with its archive time and a row-level restore action; opening a row swaps
 * the column to the preview view — the stored title plus the conversation's
 * leading markdown — with a back affordance and the destructive actions.
 * Deletion removes the durable log from disk for good; clearing every entry
 * at once is the one verb that routes through a confirmation modal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronLeftOutline14, IconTrashOutline16, IconUndoOutline16, MarkdownText, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceTrashEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './TrashSettingsSection.module.css'

/** Registration-side business face: the workspace controller client service. */
export interface TrashSettingsSectionInjected {
  readonly trash: {
    readonly entries: () => Promise<readonly WorkspaceTrashEntry[]>
    readonly unarchive: (sessionId: SessionId) => Promise<void>
    readonly remove: (sessionId: SessionId) => Promise<void>
    readonly clear: () => Promise<void>
  }
}

/** Props the renderer binds for the section. */
export type TrashSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'workspace'>
  & TrashSettingsSectionInjected

/** The clear-all verb a pending confirmation modal speaks of. */
interface PendingConfirm {
  readonly kind: 'clear'
  readonly count: number
}

/**
 * Format one archive time in the viewer's locale, minute precision.
 * @param value - epoch milliseconds.
 * @param locale - BCP 47 tag the formatter runs in.
 * @returns the localized timestamp.
 */
function formatArchivedAt(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

/**
 * The one confirmation modal both destructive verbs share.
 * @param props - locale seat, the pending verb, and the close/confirm callbacks.
 * @returns the modal layer.
 */
function ConfirmModal({ t, pending, busy, onClose, onConfirm }: {
  t: TrashSettingsSectionProps['t']
  pending: PendingConfirm
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const title = t('trash.confirmClearTitle')
  const body = t('trash.confirmClearBody', { n: pending.count })
  return (
    <div className={css.modalOverlay} role="presentation">
      <div className={css.modalMask} aria-hidden="true" onClick={onClose} />
      <div className={css.modalCard} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={css.modalIcon}><IconTrashOutline16 size={20} /></div>
        <h3 className={css.modalTitle}>{title}</h3>
        <p className={css.modalBody}>{body}</p>
        <div className={css.modalTools}>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t('trash.cancel')}
          </Button>
          <button type="button" className={css.buttonDanger} disabled={busy} onClick={onConfirm}>
            {t('trash.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Render the trash page. */
export function TrashSettingsSection({ t, trash }: TrashSettingsSectionProps) {
  const [entries, setEntries] = useState<readonly WorkspaceTrashEntry[]>([])
  const [selected, setSelected] = useState<SessionId | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirm, setConfirm] = useState<PendingConfirm | undefined>(undefined)
  const locale = t('trash.locale') === 'zh' ? 'zh-CN' : 'en-US'

  const reload = useCallback((): Promise<readonly WorkspaceTrashEntry[]> => {
    setError(undefined)
    return trash.entries()
  }, [trash])

  useEffect(() => {
    setBusy(true)
    reload()
      .then(next => {
        setEntries(next)
        setSelected(current => current !== undefined && next.some(entry => entry.sessionId === current)
          ? current
          : undefined)
      })
      .catch((reason: unknown) => { setError(String(reason)) })
      .finally(() => { setBusy(false) })
  }, [reload])

  const selectedEntry = useMemo(() =>
    entries.find(entry => entry.sessionId === selected), [entries, selected])

  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('trash.copy'), copiedLabel: t('trash.copied') },
    footnotes: t('trash.footnotes'),
  }), [t])

  /** Run one trash action, then refresh the listing it changed. */
  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    action()
      .then(() => reload())
      .then(next => {
        setEntries(next)
        setSelected(current => current !== undefined && next.some(entry => entry.sessionId === current)
          ? current
          : undefined)
      })
      .catch((reason: unknown) => { setError(String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const restore = (id: SessionId): void => { run(() => trash.unarchive(id)) }
  const confirmVerb = (): void => {
    setConfirm(undefined)
    run(() => trash.clear())
  }

  return (
    <div className={css.section}>
      <div className={css.header}>
        <h2 className={css.heading}>{t('trash.title')}</h2>
        <div className={css.headerRow}>
          <p className={css.intro}>{t('trash.intro')}</p>
          {entries.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className={css.clearButton}
              disabled={busy}
              onClick={() => { setConfirm({ kind: 'clear', count: entries.length }) }}
            >
              <IconTrashOutline16 size={14} />
              {t('trash.clear')}
            </Button>
          )}
        </div>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {selectedEntry === undefined
        ? (
          <div className={css.listWrap}>
            {entries.length === 0
              ? <p className={css.empty}>{busy ? t('trash.loading') : t('trash.empty')}</p>
              : (
                <ul className={css.list}>
                  {entries.map(entry => (
                    <li key={entry.sessionId}>
                      <div className={css.row}>
                        <button
                          type="button"
                          className={css.rowMain}
                          onClick={() => { setSelected(entry.sessionId) }}
                        >
                          <span className={css.rowTitle}>{entry.title ?? entry.sessionId}</span>
                          <span className={css.rowTime}>
                            {entry.archivedAt === undefined
                              ? t('trash.archivedUnknown')
                              : `${t('trash.archivedAt')} ${formatArchivedAt(entry.archivedAt, locale)}`}
                          </span>
                        </button>
                        <div className={css.rowTools}>
                          <Tooltip label={t('trash.restoreTip')} side="top">
                            <button
                              type="button"
                              className={css.iconButton}
                              aria-label={t('trash.restoreTip')}
                              disabled={busy}
                              onClick={() => { restore(entry.sessionId) }}
                            >
                              <IconUndoOutline16 size={16} />
                            </button>
                          </Tooltip>
                          <Tooltip label={t('trash.deleteTip')} side="top">
                            <button
                              type="button"
                              className={clsx(css.iconButton, css.iconDanger)}
                              aria-label={t('trash.deleteTip')}
                              disabled={busy}
                              onClick={() => { run(() => trash.remove(entry.sessionId)) }}
                            >
                              <IconTrashOutline16 size={16} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )
        : (
          <div className={css.preview}>
            <div className={css.previewHead}>
              <Button
                variant="outline"
                size="sm"
                className={css.back}
                onClick={() => { setSelected(undefined) }}
              >
                <IconChevronLeftOutline14 size={14} />
                {t('trash.back')}
              </Button>
              <div className={css.previewTools}>
                <Tooltip label={t('trash.restoreTip')} side="top">
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('trash.restoreTip')}
                    disabled={busy}
                    onClick={() => { restore(selectedEntry.sessionId) }}
                  >
                    <IconUndoOutline16 size={16} />
                  </button>
                </Tooltip>
                <Tooltip label={t('trash.deleteTip')} side="top">
                  <button
                    type="button"
                    className={clsx(css.iconButton, css.iconDanger)}
                    aria-label={t('trash.deleteTip')}
                    disabled={busy}
                    onClick={() => { run(() => trash.remove(selectedEntry.sessionId)) }}
                  >
                    <IconTrashOutline16 size={16} />
                  </button>
                </Tooltip>
              </div>
            </div>
            <div className={css.previewMeta}>
              <span className={css.previewTitle}>{selectedEntry.title ?? selectedEntry.sessionId}</span>
              <span className={css.rowTime}>
                {selectedEntry.archivedAt !== undefined
                  && `${t('trash.archivedAt')} ${formatArchivedAt(selectedEntry.archivedAt, locale)}`}
              </span>
            </div>
            <div className={css.previewBody} data-dsh-selectable="">
              {selectedEntry.digest === undefined
                ? <p className={css.empty}>{t('trash.previewEmpty')}</p>
                : <MarkdownText text={selectedEntry.digest} labels={labels} />}
            </div>
          </div>
        )}
      {confirm !== undefined && (
        <ConfirmModal
          t={t}
          pending={confirm}
          busy={busy}
          onClose={() => { setConfirm(undefined) }}
          onConfirm={confirmVerb}
        />
      )}
    </div>
  )
}
