/**
 * 身份预设 (identity preset) row in the General settings section: two text
 * fields — the AI persona the assistant speaks as, and the user persona the
 * assistant serves. Writes go through the settings scope on blur (not per
 * keystroke), and the host half republishes the system-prompt section on
 * every settled change, so the next request already speaks as the edited
 * identity.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { IdentitySettings } from '../identity-settings.ts'
import css from './IdentityRow.module.css'

/** Registration-side business face: the identity settings scope. */
export interface IdentityRowInjected {
  readonly identity: SettingsScope<IdentitySettings>
}

/** Full component props: runtime share + locale seat + injected scope. */
export type IdentityRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & IdentityRowInjected

/**
 * Render the identity preset row.
 * @param props - composed slot props with the identity scope.
 * @returns the row element tree.
 */
export function IdentityRow({ t, identity }: IdentityRowComponentProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => identity.subscribe(listener),
    () => identity.getSnapshot(),
  )
  const value = snapshot.value ?? {}
  return (
    <div className={css.row} data-identity-row>
      <div className={css.rowText}>
        <div className={css.title}>{t('identity.title')}</div>
        <div className={css.desc}>{t('identity.description')}</div>
      </div>
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>AI</span>
          <input
            type="text"
            className={css.input}
            defaultValue={value.aiPersona ?? ''}
            placeholder={t('identity.aiPlaceholder')}
            aria-label={t('identity.aiLabel')}
            onBlur={(event) => { void identity.set('aiPersona', event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('identity.userLabel')}</span>
          <input
            type="text"
            className={css.input}
            defaultValue={value.userPersona ?? ''}
            placeholder={t('identity.userPlaceholder')}
            aria-label={t('identity.userLabel')}
            onBlur={(event) => { void identity.set('userPersona', event.target.value) }}
          />
        </label>
      </div>
    </div>
  )
}
