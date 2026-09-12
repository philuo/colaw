/** About-system settings section: installed release, manual update check, and the silent auto-update preference. */

import { useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutline16, MarkdownText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AboutSettingsSection.module.css'

/** The release identity the host injects for the About surface (empty when absent). */
interface AboutGlobal {
  readonly version?: string
  readonly channel?: string
  readonly hash?: string
  readonly autoUpdate?: boolean
}

/** Registration-side business face: the about-settings scope. */
export interface AboutSettingsSectionInjected {
  readonly about: SettingsScope<{ autoUpdate?: boolean }>
}

/** Props the renderer binds for the section. */
export type AboutSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings'>
  & AboutSettingsSectionInjected

/** One forwarded updater lifecycle event from the host. */
interface AboutEvent {
  readonly kind: 'result' | 'status' | 'unavailable' | 'error'
  readonly notes?: string
  readonly status?: string
  readonly version?: string
  readonly updateAvailable?: boolean
  readonly updateReady?: boolean
  readonly error?: string
  readonly message?: string
}

/**
 * Render the About page: version line with a manual-check affordance, the
 * auto-update preference checkbox, and a live status line fed by the host's
 * forwarded updater events.
 * @param props - locale seat and the about settings scope.
 * @returns the section.
 */
export function AboutSettingsSection({ t, about }: AboutSettingsSectionProps) {
  const [event, setEvent] = useState<AboutEvent | undefined>(undefined)
  const [notes, setNotes] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [checked, setChecked] = useState(false)
  const installed = (globalThis as { __DSH_ABOUT__?: AboutGlobal }).__DSH_ABOUT__
  const send = (globalThis as { __electrobunSendToHost?: (message: unknown) => void }).__electrobunSendToHost

  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('about.copy'), copiedLabel: t('about.copied') },
    footnotes: t('about.footnotes'),
  }), [t])

  useEffect(() => {
    setChecked(about.getSnapshot().value?.autoUpdate === true)
    return about.subscribe(() => { setChecked(about.getSnapshot().value?.autoUpdate === true) })
  }, [about])

  useEffect(() => {
    const onAboutUpdate = (e: Event): void => {
      try {
        const parsed = JSON.parse((e as CustomEvent<string>).detail) as AboutEvent
        setEvent(parsed)
        if (parsed.notes !== undefined) setNotes(parsed.notes)
        if (parsed.kind === 'result') setReady(parsed.updateReady === true)
        if (parsed.status === 'download-complete' || parsed.status === 'complete') setReady(true)
      } catch { /* not ours */ }
    }
    window.addEventListener('dsh:about-update', onAboutUpdate)
    return () => { window.removeEventListener('dsh:about-update', onAboutUpdate) }
  }, [])

  const statusLine = (): string => {
    if (installed === undefined) return t('about.statusUnknown')
    if (event === undefined) return installed.autoUpdate ? '' : t('about.statusIdle')
    if (event.kind === 'unavailable') return t('about.statusUnavailable')
    if (event.kind === 'error') return t('about.statusError', { message: event.error ?? event.message ?? '' })
    if (event.kind === 'status') {
      if (event.status === 'update-available') return t('about.statusFound')
      if (event.status === 'downloading-patch' || event.status === 'downloading-full-bundle') return t('about.statusDownloading')
      if (event.status === 'download-complete' || event.status === 'complete') return t('about.statusReady')
      if (event.status === 'no-update') return t('about.statusLatest')
      if (event.status === 'error') return t('about.statusError', { message: '' })
    }
    if (event.kind === 'result') {
      if (event.error !== undefined) return t('about.statusError', { message: event.error })
      if (event.updateReady) return t('about.statusReady')
      if (event.updateAvailable) return t('about.statusFound')
      return t('about.statusLatest')
    }
    return t('about.statusIdle')
  }

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('about.title')}</h2>
      <div className={css.versionRow}>
        <span className={css.version}>
          {t('about.version')}
          {' '}
          {installed?.version ?? '—'}
          {installed !== undefined && installed.channel !== '' && (
            <span className={css.channel}>（{installed.channel} · {installed.hash}）</span>
          )}
        </span>
        <Tooltip label={t('about.check')} side="top">
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('about.check')}
            onClick={() => { send?.({ id: 'check-update' }) }}
          >
            <IconRefreshOutline16 size={16} />
          </button>
        </Tooltip>
      </div>
      <label className={css.option}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => {
            setChecked(e.target.checked)
            void about.set('autoUpdate', e.target.checked)
          }}
        />
        <span>{t('about.autoUpdate')}</span>
      </label>
      <p className={css.hint}>{t('about.autoUpdateHint')}</p>
      {ready && (
        <div className={css.restartRow}>
          <Button variant="primary" size="sm" onClick={() => { send?.({ id: 'restart-to-update' }) }}>
            {t('about.restartNow')}
          </Button>
        </div>
      )}
      {notes !== undefined && notes !== '' && (
        <div className={css.notes} data-dsh-selectable="">
          <p className={css.notesTitle}>{t('about.notesTitle')}</p>
          <MarkdownText text={notes} labels={markdownLabels} />
        </div>
      )}
      <p className={css.status} role="status">{statusLine()}</p>
    </div>
  )
}
