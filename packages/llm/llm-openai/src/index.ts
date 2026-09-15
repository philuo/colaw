/**
 * Register the {@link OpenAIAdapter} for the provider routes the
 * `llm-openai` settings section declares, with connection facts resolved per
 * request instead of frozen at load.
 *
 * The configuration shape replicates the pi-ai adapter's multi-provider
 * model: `providers` is a dict keyed by provider route (the dict key IS the
 * route), so a deployment may serve any number of OpenAI-protocol endpoints
 * side by side — the official API, a zai/one-api coding gateway, a
 * self-hosted server — each with its own key reference and model catalog. An
 * empty (or omitted) dict is the dormant posture: the plugin mounts with no
 * routes and registers them the moment a settings section supplies profiles,
 * and the routes drop again when it empties. A settings document that merely
 * reorders its keys is not mistaken for a route change; a change to the
 * route set or a retry policy re-registers atomically.
 *
 * Route ids are globally unique across adapter families: a profile keyed
 * `deepseek-official` (or `openai` — pi-ai's) is refused by the registry and
 * keeps the previous routes serving.
 * @module @deepseek-ai/dsh-llm-openai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenAIAdapter,
} from './adapter.ts'
import type { OpenAICatalogModel, OpenAIConnectionOptions } from './adapter.ts'
import { discoverModels } from './discovery.ts'

export {
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenAIAdapter,
} from './adapter.ts'
export type { OpenAIAdapterOptions, OpenAICatalogModel, OpenAIConnectionOptions } from './adapter.ts'
export type { RequestDefaults, ModelWireFacts } from './serialize.ts'
export { httpErrorCode } from './adapter.ts'

export const name = 'llm-openai'
export const inject = ['llm']

const NS = 'llm-openai'
/**
 * The credentials-store reference new routes default to. It is a store name,
 * not an environment read: the Models page writes the key under it, every
 * request resolves it through the credentials service, and the launching
 * environment is never consulted.
 */
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
/** Public API default; a gateway endpoint comes from the profile's `baseURL`. */
export const PUBLIC_BASE_URL = 'https://api.openai.com/v1'

/** Environment variable naming a route's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'OPENAI_BASE_URL'

// The chat-completions wire carries text and (for vision models) image
// input; the other harness modalities have no wire form on this route.
const MODEL_MODALITIES = ['text', 'image', 'video', 'file'] as const satisfies readonly ModelModality[]

/** One configured provider route; the `providers` dict key IS the route id. */
export interface ProviderProfile {
  /** Display name for selectors and the Models page; defaults to the route key. */
  displayName?: string
  /** Credential reference (a store name) resolved per request; defaults to `OPENAI_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to $OPENAI_BASE_URL from a trusted layer, then the public API. */
  baseURL?: string
  /**
   * Wire protocol every model on this route speaks. `openai-completions`
   * (the default, and what every OpenAI-compatible gateway serves) is fully
   * implemented; `openai-responses` is accepted by the schema and refuses at
   * request time until its wire lands in this build.
   */
  api?: 'openai-completions' | 'openai-responses'
  /** Route-level reasoning-effort default; omitted sends no effort field. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Output-cap wire field for this route (see the README). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Default per-request output cap for rows that declare none. */
  maxTokens?: number
  /** Context capacity for rows that declare none. */
  defaultContextWindow?: number
  /** This route's advisory model catalog. */
  models?: OpenAICatalogModel[]
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

// Schemastery's union members type every object key as `| null | undefined`,
// which `exactOptionalPropertyTypes` cannot relate to the interface's plain
// optionals; the assertion records that the object is the schema's own shape.
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoning: z.boolean(),
  thinkingFormat: z.union(['zai']),
  zaiToolStream: z.boolean(),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imagePixelBudget: z.union([z.number().step(1).min(1), 'low']),
  imageMaxBytes: z.number().step(1).min(1),
  systemPromptUpdate: z.const('in-history'),
}) as unknown as z<OpenAICatalogModel>

const profile: z<ProviderProfile> = z.object({
  displayName: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  api: z.union(['openai-completions', 'openai-responses']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
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
export interface ResolvedOpenAIProfile extends OpenAIConnectionOptions {
  /** The dict key this route was resolved from. */
  provider: string
  /** Display name for selectors and the Models page. */
  displayName: string
}

/** Resolve, validate, and detach one profile's advisory model catalog. */
function resolveModels(provider: string, models: readonly OpenAICatalogModel[] | undefined): OpenAICatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error(`llm-openai: model ids in provider "${provider}" must be non-empty`)
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-openai: model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-openai: model "${model.id}" maxTokens must be a positive integer`)
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (model.imagePixelBudget !== undefined
      && model.imagePixelBudget !== 'low'
      && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget <= 0)) {
      throw new Error(`llm-openai: model "${model.id}" imagePixelBudget must be "low" or a positive safe integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-openai: duplicate model "${model.id}" in provider "${provider}"`)
    seen.add(model.id)
    const hasImage = inputModalities.includes('image')
    if (!hasImage && (model.imagePixelBudget !== undefined || model.imageMaxBytes !== undefined)) {
      throw new Error(`llm-openai: text-only model "${model.id}" in provider "${provider}" cannot declare image request limits`)
    }
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
      ...model.thinkingFormat === undefined ? {} : { thinkingFormat: model.thinkingFormat },
      ...model.zaiToolStream === undefined ? {} : { zaiToolStream: model.zaiToolStream },
      ...model.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: model.systemPromptUpdate },
      inputModalities: [...inputModalities],
      ...(hasImage
        ? {
          imagePixelBudget: model.imagePixelBudget === 'low'
            ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
            : model.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
          imageMaxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        }
        : {}),
    }
  })
}

/**
 * Resolve every configured route to validated connection facts. An omitted
 * dict resolves to the empty, dormant route set.
 * @param providers - configured profiles keyed by route.
 * @param environment - this run's environment layers; a route without its
 *   own baseURL falls back to $OPENAI_BASE_URL, then the public API.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, ProviderProfile>> | undefined,
  environment?: LaunchEnvironmentSnapshot,
): Map<string, ResolvedOpenAIProfile> {
  const resolved = new Map<string, ResolvedOpenAIProfile>()
  for (const [provider, source] of Object.entries(providers ?? {})) {
    if (provider.length === 0) throw new Error('llm-openai: provider route names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-openai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-openai: provider "${provider}" has an empty displayName`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-openai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error(`llm-openai: provider "${provider}" maxRequestImageBytes must be a positive safe integer`)
    }
    const maxImagesPerRequest = source.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
    if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
      throw new Error(`llm-openai: provider "${provider}" maxImagesPerRequest must be a positive safe integer`)
    }
    const imageOffloadByteQuantum = source.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
    if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadByteQuantum must be a positive safe integer`)
    }
    if (imageOffloadByteQuantum > maxRequestImageBytes) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadByteQuantum must not exceed maxRequestImageBytes`)
    }
    const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
    if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadCountQuantum must be a positive safe integer`)
    }
    if (imageOffloadCountQuantum > maxImagesPerRequest) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadCountQuantum must not exceed maxImagesPerRequest`)
    }
    const models = resolveModels(provider, source.models)
    const connection: OpenAIConnectionOptions = {
      api: source.api ?? 'openai-completions',
      apiKeyEnv: credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
      baseURL: source.baseURL
        ?? environment?.get(BASE_URL_ENV)?.value
        ?? PUBLIC_BASE_URL,
      defaults: {
        reasoningEffort: source.reasoningEffort,
        maxTokensField: source.maxTokensField,
      },
      maxTokens: source.maxTokens,
      defaultContextWindow: source.defaultContextWindow,
      models,
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      maxImagesPerRequest,
      imageOffloadByteQuantum,
      imageOffloadCountQuantum,
      retryPolicy: resolveRetryPolicy(source.retryPolicy, `llm-openai: provider "${provider}" retryPolicy`),
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
 * profile. Programmatic construction may bypass Schemastery normalization,
 * so every default and bound is re-judged here.
 */
export function resolveAdapterOptions(config: ProviderProfile, environment?: LaunchEnvironmentSnapshot): OpenAIConnectionOptions {
  const key = config.displayName ?? 'openai-compatible'
  const resolved = resolveProfiles({ [key]: config }, environment).get(key)
  if (resolved === undefined) throw new Error(`llm adapter: profile "${key}" vanished during resolution`)
  return resolved
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedOpenAIProfile> | undefined
  /** Resolved routes for the current snapshot, memoized by snapshot identity. */
  const profiles = (): ReadonlyMap<string, ResolvedOpenAIProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers, launchEnvironmentOf(ctx))
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const resolveApiKey = async (provider: string, profile: ResolvedOpenAIProfile): Promise<string> => {
    const ref = profile.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-openai', ref)
    }
    throw new LlmError(
      `llm-openai: no API key for provider route "${provider}"; store ${ref} through the credentials`
      + ' service (the web Models page writes it)',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new OpenAIAdapter({
    options: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined) {
        throw new LlmError(`llm-openai: route "${provider}" vanished from configuration`, 'NO_ADAPTER')
      }
      return profile
    },
    resolveApiKey: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined) {
        return Promise.reject(new LlmError(`llm-openai: route "${provider}" vanished from configuration`, 'NO_ADAPTER'))
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

  /**
   * The registry captures the route set and each route's retry policy at
   * registration; a change to either re-registers atomically. Sorted by
   * route so a settings document that merely reorders keys is not mistaken
   * for a route change. A dormant (empty) mount registers nothing.
   */
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

  /** The configurable-provider directory: one entry per declared route. */
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
    // The registry refuses an empty declaration: a dormant mount (or an
    // emptied section) withdraws the previous directory instead.
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

  /** Discovery for the whole namespace: a being-added route has no profile yet. */
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
        // A refused registry swap keeps the previous routes serving; the
        // directory follows only the routes the registry accepted, so a
        // route that failed to register is not advertised as configurable.
        try {
          ensureRegistrationFacts()
        } catch (error) {
          ctx.logger.error('llm-openai: keeping the previously registered routes after a refused update')
          ctx.logger.error(error)
        }
        try {
          ensureDirectory()
        } catch (error) {
          ctx.logger.error('llm-openai: keeping the previous configurable-provider directory after a refused update')
          ctx.logger.error(error)
        }
      },
    })
  })
}
