/**
 * The web-search provider's card. The key is its only control: the provider is
 * the product's own AnySearch MCP, and the key is written through the
 * credentials domain, never into the settings section, so the literal never
 * rides a response.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id="plugin-config-web-search-key"
        label={t('webSearchApiKey')}
        hint={t('webSearchApiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
        placeholder={state.apiKeyConfigured ? t('webSearchApiKeyStored') : t('webSearchApiKeyPlaceholder')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
    </PluginCard>
  )
}
