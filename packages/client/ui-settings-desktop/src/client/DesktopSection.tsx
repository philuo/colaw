/**
 * The 电脑操控 section: three independent capability switches (the ChatGPT
 * permission-row layout — glyph, title, description, trailing switch) plus a
 * macOS-permission block that mirrors the host process's live TCC state and
 * deep-links System Settings while anything is missing. Switch writes are
 * optimistic; toggling never touches macOS TCC grants.
 */
import { Switch, IconBrowseOutline16, IconSkillOutline16, IconShieldOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createDesktopSectionStore } from './desktop-store.ts'
import css from './DesktopSection.module.css'

/** One TCC grant pair as the section renders it. */
export interface DesktopPermissionStatus {
  accessibility: boolean
  screenRecording: boolean
}

/** Full component props: section runtime share + store share + locale seat + actions. */
export type DesktopSectionComponentProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createDesktopSectionStore>>
  & PropsLocale<'settings.desktop'>
  & {
    /** Optimistically flip one switch; the scope write settles in the store. */
    setField: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
    /** The live TCC state, or undefined while the first probe is in flight. */
    permissions: DesktopPermissionStatus | undefined
    /** Deep-link macOS System Settings for the user to grant. */
    openPermissionSettings: () => void
  }

/** The three rows, in display order. */
const ROWS: readonly {
  field: 'browserUse' | 'computerUse' | 'lockScreenOperation'
  titleKey: 'browserUseTitle' | 'computerUseTitle' | 'lockScreenTitle'
  descriptionKey: 'browserUseDescription' | 'computerUseDescription' | 'lockScreenDescription'
  Icon: typeof IconBrowseOutline16
}[] = [
  { field: 'computerUse', titleKey: 'computerUseTitle', descriptionKey: 'computerUseDescription', Icon: IconSkillOutline16 },
  { field: 'browserUse', titleKey: 'browserUseTitle', descriptionKey: 'browserUseDescription', Icon: IconBrowseOutline16 },
  { field: 'lockScreenOperation', titleKey: 'lockScreenTitle', descriptionKey: 'lockScreenDescription', Icon: IconShieldOutline16 },
]

/**
 * Render the desktop-control section.
 * @param props - section props with the mirrored store and the switch writer.
 * @returns the section element tree.
 */
export function DesktopSection({ t, useStore, setField, permissions, openPermissionSettings }: DesktopSectionComponentProps) {
  const state = useStore(s => s)
  const granted = permissions !== undefined && permissions.accessibility && permissions.screenRecording
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
              <button type="button" className={css.permissionButton} onClick={openPermissionSettings}>
                {t('permissionOpenSettings')}
              </button>
            </div>
          )}
      </div>
    </div>
  )
}
