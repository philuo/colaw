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
import {
  DESKTOP_REQUIRED_GRANTS,
  type createDesktopSectionStore,
  type DesktopCapabilityField,
  type DesktopPermissionPane,
} from './desktop-store.ts'
import css from './DesktopSection.module.css'

export type { DesktopPermissionStatus, DesktopPermissionPane } from './desktop-store.ts'

/** The action face the wiring injects alongside the store mirror. */
export interface DesktopSectionActions {
  /** Optimistically flip one switch; the scope write settles in the store. */
  setField: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
  /** Re-probe the host's TCC state and publish the answer to the store. */
  refreshPermissions: () => void
  /** Open the floating grant guide for a pane. */
  setGuide: (pane: DesktopPermissionPane | undefined) => void
  /** Clear the grants-landed banner. */
  setGrantDone: (field: DesktopCapabilityField | undefined) => void
  /** Clear the revoked-grant alert once the user has seen it. */
  setRevoked: (value: boolean) => void
  /** Abandon a pending enable: clears the prompt without touching the switch. */
  dismissPending: () => void
  /** Deep-link the pane of the first missing grant and summon the guide. */
  openMissingPane: () => void
  /** Reveal Colaw.app in Finder for the drag-into-list grant gesture. */
  revealAppInFinder: () => void
  /** Restart the app so the freshly granted surface activates. */
  restartApp: () => void
}

/**
 * Full component props. The action face is partial at the type level because
 * the slot contract declares no inject seat — the renderer binds what the
 * registration returned; the component renders nothing when it is absent.
 */
export type DesktopSectionComponentProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createDesktopSectionStore>>
  & PropsLocale<'settings.desktop'>
  & Partial<DesktopSectionActions>

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
  const {
    t, useStore, setField, setGuide, setGrantDone, setRevoked, dismissPending, refreshPermissions,
    openMissingPane, revealAppInFinder, restartApp,
  } = props
  if (setField === undefined || setGuide === undefined || setGrantDone === undefined
    || refreshPermissions === undefined || revealAppInFinder === undefined || restartApp === undefined
    || setRevoked === undefined || dismissPending === undefined || openMissingPane === undefined) return null
  const state = useStore(s => s)
  const permissions = state.permissions
  const granted = permissions !== undefined && permissions.accessibility && permissions.screenRecording
  // The switch the user asked for whose grants have not landed. The switch
  // itself stays off until the user flips it: this section only reports that
  // the permission is now in and hands them the switch.
  const pending = state.pendingEnable
  const pendingReady = pending !== undefined && permissions !== undefined
    && DESKTOP_REQUIRED_GRANTS[pending].every(grant => permissions[grant])
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
        {/* Stateable in advance, so it never has to be diagnosed live: macOS 15
            asks about screen recording on its own schedule — a dialog that
            looks like a fresh request while this pane still reports Granted. */}
        {permissions === undefined
          ? null
          : <p className={css.permissionHint}>{t('permissionMonthly')}</p>}
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
      {state.revoked
        ? (
          <div className={`${css.notice} ${css.noticeDanger}`} role="alert" aria-label={t('revokedTitle')}>
            <span className={css.noticeIcon} aria-hidden>!</span>
            <span className={css.noticeText}>
              {t('revokedTitle')}
              <em>{t('revokedHint')}</em>
            </span>
            <div className={css.noticeActions}>
              <button type="button" className={css.guideAction} onClick={openMissingPane}>{t('revokedRegrant')}</button>
              <button type="button" className={css.guideAction} onClick={() => { setRevoked(false) }}>{t('guideDismiss')}</button>
            </div>
          </div>
        )
        : null}
      {pending === undefined
        ? null
        : pendingReady
          ? (
            <div className={css.notice} role="status" aria-label={t('pendingTitle')}>
              <span className={css.noticeIcon} aria-hidden>✓</span>
              <span className={css.noticeText}>{t('pendingTitle')}</span>
              <div className={css.noticeActions}>
                {/* The switch is the user's to flip: a grant landing in System
                    Settings must never move a control they are looking at. */}
                <button
                  type="button"
                  className={css.guideAction}
                  onClick={() => { setField(pending, true) }}
                >
                  {t('pendingAction')}
                </button>
                <button type="button" className={css.guideAction} onClick={dismissPending}>{t('guideDismiss')}</button>
              </div>
            </div>
          )
          : (
            <div className={css.notice} role="status" aria-label={t('pendingWaiting')}>
              <span className={css.noticeIcon} aria-hidden>…</span>
              <span className={css.noticeText}>{t('pendingWaiting')}</span>
              <div className={css.noticeActions}>
                <button type="button" className={css.guideAction} onClick={refreshPermissions}>{t('guideRecheck')}</button>
                <button type="button" className={css.guideAction} onClick={dismissPending}>{t('guideDismiss')}</button>
              </div>
            </div>
          )}
      {state.grantDone === undefined
        ? null
        : (
          <div className={css.guideBar} role="status" aria-label={t('grantDoneTitle')}>
            <span className={css.guideIcon}>✓</span>
            <span className={css.guideText}>{t('grantDoneTitle')}</span>
            <div className={css.guideActions}>
              <button type="button" className={css.guideAction} onClick={restartApp}>{t('grantRestart')}</button>
              <button type="button" className={css.guideAction} onClick={() => { setGrantDone(undefined) }}>{t('guideDismiss')}</button>
            </div>
          </div>
        )}
      {state.guide === undefined || state.nativeGuide
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
