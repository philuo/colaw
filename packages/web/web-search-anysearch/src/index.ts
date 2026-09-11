/**
 * AnySearch-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service, and is the web seam's default provider:
 * the endpoint is the product's own AnySearch MCP, and the only configuration a
 * reader gives it is the key (the settings web-search card writes it through
 * the credentials domain).
 *
 * @module @deepseek-ai/dsh-web-search-anysearch
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { AnySearchProvider, ANYSEARCH_DEFAULT_ENDPOINT } from './provider.ts'

export {
  ANYSEARCH_DEFAULT_ENDPOINT,
  ANYSEARCH_PROVIDER_ID,
  AnySearchProvider,
  parseAnySearchAnswer,
} from './provider.ts'
export type { AnySearchProviderOptions, AnySearchEntry } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-anysearch'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace this plugin owns (the web-search card edits it). */
export const NS = 'web-search-anysearch'

/** Credential reference the provider resolves when the section names none. */
export const DEFAULT_API_KEY_REF = 'ANYSEARCH_API_KEY'

/** Plugin config; every field is optional. */
export interface Config {
  /** Credential reference naming the stored key; defaults to `ANYSEARCH_API_KEY`. */
  apiKeyEnv?: string
  /** Literal key; the credentials store wins when both exist. */
  apiKey?: string
  /** The MCP endpoint URL; defaults to the public AnySearch MCP. */
  endpoint?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  apiKey: z.string(),
  endpoint: z.string(),
})

/** Register the AnySearch search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const ref = config.apiKeyEnv ?? DEFAULT_API_KEY_REF
  ctx.web.registerSearchProvider(new AnySearchProvider({
    endpoint: config.endpoint ?? ANYSEARCH_DEFAULT_ENDPOINT,
    ...config.apiKey !== undefined ? { apiKey: config.apiKey } : {},
    resolveApiKey: async (): Promise<string> => {
      // The credentials store is the in-app path (the settings card writes
      // it); the launching environment is the ambient fallback for headless
      // compositions, mirroring every other credential this product resolves.
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined) return hit.value
      }
      return launchEnvironmentOf(ctx).get(ref)?.value ?? ''
    },
  }))

  // Publish the section so the settings card has a scope to stage against.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(NS, Config)
  })
}
