/**
 * The 内置插件 tab: one card per product-shipped cloud service, rendered from
 * the `settings.plugins.builtin` keyed slot in fixed registration order.
 * AnySearch stays on the configurable tab as its own card — this tab is for
 * the services whose keys this product provisions per deployment.
 */
import { Fragment, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import { BUILT_IN_SERVICES } from './built-in-card-controller.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the built-in services tab. */
export type BuiltInServicesTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugins.builtin'>

/**
 * Render the built-in services' cards.
 * @param props - locale copy and the slot renderer.
 * @returns the card list.
 */
export function BuiltInServicesTab(props: BuiltInServicesTabProps): ReactNode {
  const { renderSlot } = props
  return (
    <ul className={css.cards}>
      {BUILT_IN_SERVICES.map(service => (
        <Fragment key={service.key}>{renderSlot('settings.plugins.builtin', {}, { entryKey: service.key })}</Fragment>
      ))}
    </ul>
  )
}
