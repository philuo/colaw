/**
 * The 电脑操控 section: three independent capability switches (figma layout:
 * the ChatGPT-style permission row — glyph, title, description, trailing
 * switch). Each row reads one field of the shared desktop-control namespace;
 * a switch only writes that field. Toggling never touches macOS TCC grants.
 */
import { Switch, IconBrowseOutline16, IconSkillOutline16, IconShieldOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopSettings } from '../desktop-settings.ts'
import css from './DesktopSection.module.css'

/** Full component props: section runtime share + scope snapshot + locale seat. */
export type DesktopSectionComponentProps =
  PropsRuntime<'settings.section'> & {
    /** The settings scope snapshot for the desktop-control namespace. */
    snapshot: { status: 'loading' | 'ready' | 'unavailable'; value: DesktopSettings | undefined }
    /** Write one field of the namespace. */
    setField: (field: keyof DesktopSettings, value: boolean) => void
  } & PropsLocale<'settings.desktop'>

/** The three rows, in display order. */
const ROWS: readonly {
  field: keyof DesktopSettings
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
 * @param props - section props with the bound scope snapshot and writer.
 * @returns the section element tree.
 */
export function DesktopSection({ t, snapshot, setField }: DesktopSectionComponentProps) {
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.rows}>
        {ROWS.map(({ field, titleKey, descriptionKey, Icon }) => {
          // While the scope is still loading the switch renders off but stays
          // disabled: the persisted fact, once it arrives, is authoritative.
          const checked = snapshot.status === 'ready' && snapshot.value?.[field] === true
          const disabled = snapshot.status !== 'ready'
          return (
            <div key={field} className={css.row}>
              <div className={css.glyph}><Icon size={20} /></div>
              <div className={css.texts}>
                <span className={css.rowTitle}>{t(titleKey)}</span>
                <span className={css.description}>{t(descriptionKey)}</span>
              </div>
              <Switch
                checked={checked}
                disabled={disabled}
                label={t(titleKey)}
                onChange={next => { setField(field, next) }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
