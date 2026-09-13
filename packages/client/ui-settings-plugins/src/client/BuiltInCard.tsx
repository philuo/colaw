/**
 * One built-in service's credential card: the same PluginCard + SecretField
 * presentation the configurable tab uses, keyed by the service instead of a
 * settings namespace (the keys live only in the credentials domain).
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BuiltInService } from './built-in-card-controller.ts'
import type { BuiltInCardFace } from './built-in-card-controller.ts'
import { PluginCard } from './PluginCard.tsx'
import { SecretField } from './fields.tsx'

/** Full component props: runtime share + locale seat + the injected face. */
export type BuiltInCardProps =
  PropsRuntime<'settings.plugins.builtin'> & PropsLocale<'settings.plugins'> & InjectFace<BuiltInCardFace> & {
    /** Which service this card presents. */
    readonly service: BuiltInService
  }

/**
 * Render one built-in service's key card.
 * @param props - the service identity, the framework seats, and the face.
 * @returns the card.
 */
export function BuiltInCard(props: BuiltInCardProps) {
  const { t, service } = props
  const state = props.useBuiltinCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey={`builtin.${service.key}` as const}
      descriptionKey={`builtin.${service.key}Description` as const}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id={`plugin-config-builtin-${service.key}`}
        label={t('builtinApiKey')}
        hint={t(`builtin.${service.key}Hint` as const)}
        disabled={!state.writable}
        text={state.secret.text}
        configured={state.configured}
        stateLabel={state.configured ? t('builtinApiKeySet') : t('builtinApiKeyUnset')}
        placeholder={t('builtinApiKeyPlaceholder')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
    </PluginCard>
  )
}
