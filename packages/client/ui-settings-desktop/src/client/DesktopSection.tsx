/**
 * The 电脑操控 section: three independent capability switches (the ChatGPT
 * permission-row layout — glyph, title, description, trailing switch) plus a
 * macOS-permission block that mirrors the host process's live TCC state and
 * deep-links System Settings while anything is missing. Switch writes are
 * optimistic; toggling never touches macOS TCC grants. The TCC answer rides
 * the section store: undefined is transient (a probe is in flight or was
 * rejected), and every mount re-probes, so a grant the user just made in
 * System Settings shows on the next visit.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Switch, IconBrowseOutline16, IconSkillOutline16, IconShieldOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createDesktopSectionStore, DesktopPermissionPane } from './desktop-store.ts'
import css from './DesktopSection.module.css'

export type { DesktopPermissionStatus, DesktopPermissionPane } from './desktop-store.ts'

/** Full component props: section runtime share + store share + locale seat + actions. */
export type DesktopSectionComponentProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createDesktopSectionStore>>
  & PropsLocale<'settings.desktop'>
  & {
    /** Optimistically flip one switch; the scope write settles in the store. */
    setField: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
    /** Re-probe the host's TCC state and publish the answer to the store. */
    refreshPermissions: () => void
    /** Dismiss the floating grant guide. */
    setGuide: (pane: DesktopPermissionPane | undefined) => void
    /** Reveal Colaw.app in Finder for the drag-into-list grant gesture. */
    revealAppInFinder: () => void
  }

/** The three rows, in display order. */
const ROWS: readonly {
  field: 'browserUse' | 'computerUse' | 'lockScreenOperation'
  titleKey: 'computerUseTitle' | 'browserUseTitle' | 'lockScreenTitle'
  descriptionKey: 'computerUseDescription' | 'browserUseDescription' | 'lockScreenDescription'
  Icon: typeof IconBrowseOutline16
}[] = [
  { field: 'computerUse', titleKey: 'computerUseTitle', descriptionKey: 'computerUseDescription', Icon: IconSkillOutline16 },
  { field: 'browserUse', titleKey: 'browserUseTitle', descriptionKey: 'browserUseDescription', Icon: IconBrowseOutline16 },
  { field: 'lockScreenOperation', titleKey: 'lockScreenTitle', descriptionKey: 'lockScreenDescription', Icon: IconShieldOutline16 },
]

/**
 * Render the desktop-control section.
 * @param props - section props with the mirrored store and the action face.
 * @returns the section element tree.
 */
export function DesktopSection(props: DesktopSectionComponentProps): ReactNode {
  const { t, useStore, setField, setGuide, refreshPermissions, revealAppInFinder } = props
  const state = useStore(s => s)
  const permissions = state.permissions
  const granted = permissions !== undefined && permissions.accessibility && permissions.screenRecording
  // Every mount re-probes: the store's answer may predate a grant the user
  // made in System Settings after the last visit.
  useEffect(() => { refreshPermissions() }, [refreshPermissions])
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.rows}>
        {ROWS.map(({ field, titleKey, descriptionKey, Icon }) => (
          <div key={field} className={css.row}>
            <div className={css.glyph}><Icon size={20} /></div>
            <div className={css.texts}>
              <span className={css.rowTitle}>{t(titleKey)}</span>
              <span className={css.description}>{t(descriptionKey)}</span>
            </div>
            <Switch
              checked={state[field]}
              disabled={state.status !== 'ready'}
              label={t(titleKey)}
              onChange={(next) => { setField(field, next) }}
            />
          </div>
        ))}
      </div>
      <div className={css.permissions}>
        <div className={css.permissionHead}>
          <span className={css.permissionHeadline}>{t('permissionHeadline')}</span>
          {permissions === undefined
            ? <span className={css.permissionChecking}>{t('permissionChecking')}</span>
            : (
              <span className={`${css.permissionPill} ${granted ? css.permissionGranted : css.permissionMissing}`}>
                {granted ? t('permissionGranted') : t('permissionMissing')}
              </span>
            )}
        </div>
        {permissions === undefined || granted
          ? null
          : (
            <div className={css.permissionBody}>
              <p className={css.permissionHint}>{t('permissionHint')}</p>
              <ul className={css.permissionList}>
                <li className={css.permissionItem}>
                  <span>{t('permissionAccessibility')}</span>
                  <span className={permissions.accessibility ? css.permissionGranted : css.permissionMissing}>
                    {permissions.accessibility ? t('permissionGranted') : t('permissionMissing')}
                  </span>
                </li>
                <li className={css.permissionItem}>
                  <span>{t('permissionScreenRecording')}</span>
                  <span className={permissions.screenRecording ? css.permissionGranted : css.permissionMissing}>
                    {permissions.screenRecording ? t('permissionGranted') : t('permissionMissing')}
                  </span>
                </li>
              </ul>
            </div>
          )}
      </div>
      {state.guide === undefined
        ? null
        : (
          <div className={css.guideBar} role="dialog" aria-label={t('guideTitle')}>
            <span className={css.guideIcon}>C</span>
            <span className={css.guideArrow} aria-hidden>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="var(--dsw-alias-brand-primary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className={css.guideText}>
              {t('guideBarDrag').replace('{pane}', state.guide === 'accessibility' ? t('permissionAccessibility') : t('permissionScreenRecording'))}
              <em>{t('guideBarHint')}</em>
            </span>
            <div className={css.guideActions}>
              <button type="button" className={css.guideAction} onClick={revealAppInFinder}>{t('guideReveal')}</button>
              <button type="button" className={css.guideAction} onClick={() => { refreshPermissions() }}>{t('guideRecheck')}</button>
              <button type="button" className={css.guideAction} onClick={() => { setGuide(undefined) }}>{t('guideDismiss')}</button>
            </div>
          </div>
        )}
    </div>
  )
}
