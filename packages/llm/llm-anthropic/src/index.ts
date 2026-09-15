/**
 * Register the {@link AnthropicAdapter} for the provider routes the
 * `llm-anthropic` settings section declares, replicating the pi-ai
 * multi-provider configuration model (a `providers` dict keyed by route,
 * dormant when empty, re-registered atomically on route-set changes).
 *
 * The route speaks the Anthropic Messages protocol: the official API and any
 * compatible gateway (custom `baseURL` + credential reference). The route id
 * prefix `anthropic-compatible` family naming avoids pi-ai's own `anthropic`
 * route id, so the families stay distinguishable on every configuration
 * surface.
 * @module @deepseek-ai/dsh-llm-anthropic
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { AnthropicCatalogModel, AnthropicConnectionOptions } from './adapter.ts'
import {
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  AnthropicAdapter,
} from './adapter.ts'
import { discoverModels } from './discovery.ts'

export {
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  AnthropicAdapter,
} from './adapter.ts'
export type { AnthropicAdapterOptions, AnthropicCatalogModel, AnthropicConnectionOptions } from './adapter.ts'
export type { RequestDefaults, ModelWireFacts } from './serialize.ts'
export { httpErrorCode } from './adapter.ts'

export const name = 'llm-anthropic'
export const inject = ['llm']

const NS = 'llm-anthropic'
/** The credentials-store reference new routes default to. */
const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY'
/** Public API default; a gateway endpoint comes from the profile's `baseURL`. */
export const PUBLIC_BASE_URL = 'https://api.anthropic.com'

/** Environment variable naming a route's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'ANTHROPIC_BASE_URL'

// The Messages wire carries text and (for vision models) image input.
const MODEL_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/** One configured provider route; the `providers` dict key IS the route id. */
export interface ProviderProfile {
  /** Display name for selectors and the Models page; defaults to the route key. */
  displayName?: string
  /** Credential reference (a store name) resolved per request; defaults to `ANTHROPIC_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/v1/messages` is appended. Defaults to $ANTHROPIC_BASE_URL from a trusted layer, then the public API. */
  baseURL?: string
  /** Default thinking effort (none sent when omitted); `off` never sends thinking. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Extended-thinking budget in tokens for reasoning models (default 16,384; clamped ≥1024 and below the cap). */
  thinkingBudgetTokens?: number
  /** Default per-request output cap (default 128,000 — the API requires this field). */
  maxTokens?: number
  /** Context capacity for rows that declare none. */
  defaultContextWindow?: number
  /** This route's advisory model catalog. */
  models?: AnthropicCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated inline base64 image payload per chat request. */
  maxRequestImageBytes?: number
  /** Maximum number of represented images per chat request. */
  maxImagesPerRequest?: number
  /** Base64-byte removal step after the request exceeds its image-byte bound. */
  imageOffloadByteQuantum?: number
  /** Image-count removal step after the request exceeds its count bound. */
  imageOffloadCountQuantum?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /** Provider routes keyed by route id; an empty dict is the dormant posture. */
  providers?: Record<string, ProviderProfile>
}

const catalogModel: z<AnthropicCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoning: z.boolean(),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  systemPromptUpdate: z.const('in-history'),
})

const profile: z<ProviderProfile> = z.object({
  displayName: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  thinkingBudgetTokens: z.number().step(1).min(1024),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST),
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM),
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM),
  retryPolicy: RetryPolicySchema,
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.dict(profile).default({}),
})

/** Validated connection facts for one route. */
export interface ResolvedAnthropicProfile extends AnthropicConnectionOptions {
  /** The dict key this route was resolved from. */
  provider: string
  /** Display name for selectors and the Models page. */
  displayName: string
}

/** Resolve, validate, and detach one profile's advisory model catalog. */
function resolveModels(provider: string, models: readonly AnthropicCatalogModel[] | undefined): AnthropicCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error(`llm-anthropic: model ids in provider "${provider}" must be non-empty`)
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-anthropic: model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-anthropic: model "${model.id}" maxTokens must be a positive integer`)
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-anthropic: model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-anthropic: model "${model.id}" inputModalities must not contain duplicates`)
    }
    const systemPromptUpdate: string | undefined = model.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new Error(`llm-anthropic: model "${model.id}" systemPromptUpdate must be "in-history" when present`)
    }
    if (seen.has(model.id)) throw new Error(`llm-anthropic: duplicate model "${model.id}" in provider "${provider}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
      ...model.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: model.systemPromptUpdate },
      inputModalities: [...inputModalities],
    }
  })
}

/**
 * Resolve every configured route to validated connection facts. An omitted
 * dict resolves to the empty, dormant route set.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, ProviderProfile>> | undefined,
  environment?: LaunchEnvironmentSnapshot,
): Map<string, ResolvedAnthropicProfile> {
  const resolved = new Map<string, ResolvedAnthropicProfile>()
  for (const [provider, source] of Object.entries(providers ?? {})) {
    if (provider.length === 0) throw new Error('llm-anthropic: provider route names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-anthropic: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-anthropic: provider "${provider}" has an empty displayName`)
    }
    if (source.thinkingBudgetTokens !== undefined
      && (!Number.isSafeInteger(source.thinkingBudgetTokens) || source.thinkingBudgetTokens < 1024)) {
      throw new Error(`llm-anthropic: provider "${provider}" thinkingBudgetTokens must be a safe integer of at least 1024`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-anthropic: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error('llm-anthropic: maxRequestImageBytes must be a positive safe integer')
    }
    const maxImagesPerRequest = source.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
    if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
      throw new Error('llm-anthropic: maxImagesPerRequest must be a positive safe integer')
    }
    const imageOffloadByteQuantum = source.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
    if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
      throw new Error('llm-anthropic: imageOffloadByteQuantum must be a positive safe integer')
    }
    if (imageOffloadByteQuantum > maxRequestImageBytes) {
      throw new Error('llm-anthropic: imageOffloadByteQuantum must not exceed maxRequestImageBytes')
    }
    const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
    if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
      throw new Error('llm-anthropic: imageOffloadCountQuantum must be a positive safe integer')
    }
    if (imageOffloadCountQuantum > maxImagesPerRequest) {
      throw new Error('llm-anthropic: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
    }
    const models = resolveModels(provider, source.models)
    const connection: AnthropicConnectionOptions = {
      apiKeyEnv: credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
      baseURL: source.baseURL
        ?? environment?.get(BASE_URL_ENV)?.value
        ?? PUBLIC_BASE_URL,
      defaults: {
        reasoningEffort: source.reasoningEffort,
        thinkingBudgetTokens: source.thinkingBudgetTokens,
      },
      maxTokens: source.maxTokens ?? DEFAULT_MAX_TOKENS,
      defaultContextWindow: source.defaultContextWindow,
      models,
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      maxImagesPerRequest,
      imageOffloadByteQuantum,
      imageOffloadCountQuantum,
      retryPolicy: resolveRetryPolicy(source.retryPolicy, `llm-anthropic: provider "${provider}" retryPolicy`),
    }
    resolved.set(provider, {
      ...connection,
      provider,
      displayName: source.displayName ?? provider,
    })
  }
  return resolved
}

/**
 * The complete resolve step for one route's connection facts, from a raw
 * profile.
 */



/**
 * The complete resolve step for one route's connection facts, from a raw
 * profile. Programmatic construction may bypass Schemastery normalization,
 * so every default and bound is re-judged here.
 */
export function resolveAdapterOptions(config: ProviderProfile, environment?: LaunchEnvironmentSnapshot): AnthropicConnectionOptions {
  const key = config.displayName ?? 'anthropic-compatible'
  const resolved = resolveProfiles({ [key]: config }, environment).get(key)
  if (resolved === undefined) throw new Error(`llm adapter: profile "${key}" vanished during resolution`)
  return resolved
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedAnthropicProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedAnthropicProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers, launchEnvironmentOf(ctx))
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const resolveApiKey = async (provider: string, profile: ResolvedAnthropicProfile): Promise<string> => {
    const ref = profile.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-anthropic', ref)
    }
    throw new LlmError(
      `llm-anthropic: no API key for provider route "${provider}"; store ${ref} through the credentials`
      + ' service (the web Models page writes it)',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new AnthropicAdapter({
    options: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined) {
        throw new LlmError(`llm-anthropic: route "${provider}" vanished from configuration`, 'NO_ADAPTER')
      }
      return profile
    },
    resolveApiKey: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined) {
        return Promise.reject(new LlmError(`llm-anthropic: route "${provider}" vanished from configuration`, 'NO_ADAPTER'))
      }
      return resolveApiKey(provider, profile)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })

  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = [...profiles().entries()]
      .map(([route, profile]) => ({ route, displayName: profile.displayName, retryPolicy: profile.retryPolicy }))
      .sort((left, right) => left.route.localeCompare(right.route))
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = facts.map(fact => fact.route)
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = [...profiles().entries()].map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
      declared: true,
    }))
    if (deepEqualJson(entries, directoryFacts)) return
    if (entries.length === 0) {
      directory?.()
      directory = undefined
      directoryFacts = entries
      return
    }
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    directoryFacts = entries
  }
  ensureDirectory()

  /** Discovery for the whole namespace (Anthropic model listing). */
  ctx.llm.registerModelDiscovery(NS, (request, signal) => {
    const profile = request.provider === undefined ? undefined : profiles().get(request.provider)
    const catalog = (profile?.models ?? []).map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }))
    return discoverModels(
      { ...request, ...signal === undefined ? {} : { signal } },
      catalog,
      profile === undefined
        ? undefined
        : () => resolveApiKey(profile.provider, profile).catch(() => undefined),
    )
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        try {
          ensureRegistrationFacts()
        } catch (error) {
          ctx.logger.error('llm-anthropic: keeping the previously registered routes after a refused update')
          ctx.logger.error(error)
        }
        try {
          ensureDirectory()
        } catch (error) {
          ctx.logger.error('llm-anthropic: keeping the previous configurable-provider directory after a refused update')
          ctx.logger.error(error)
        }
      },
    })
  })
}
