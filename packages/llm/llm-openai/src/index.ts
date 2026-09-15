/**
 * The single pi-ai replacement: one plugin owning every wire protocol a
 * hand-configurable provider speaks. Provider routes live in the
 * `llm-openai` settings section's `providers` dict (the dict key IS the
 * route), each naming its protocol through `api` — `openai-completions`
 * (the default, and what every OpenAI-compatible gateway serves),
 * `openai-responses` (OpenAI's stateless Responses wire), or
 * `anthropic-messages` (the official API and its many vendor-compatible
 * coding endpoints). A deployment may serve any number of endpoints side by
 * side — the official APIs, a zai/one-api gateway, a self-hosted server —
 * each with its own key reference, protocol, and model catalog. An empty
 * (or omitted) dict is the dormant posture: the plugin mounts with no
 * routes and registers them the moment a settings section supplies
 * profiles, and the routes drop again when it empties. A settings document
 * that merely reorders its keys is not mistaken for a route change; a
 * change to the route set, a route's protocol, or a retry policy
 * re-registers atomically.
 *
 * Route ids are globally unique across adapter families: a profile keyed
 * `deepseek-official` is refused by the registry and keeps the previous
 * routes serving.
 * @module @deepseek-ai/dsh-llm-openai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, convertLegacyPiAiModels, convertLegacyPiAiProfile, LlmError, migrateLegacyPiAiProfiles, resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmConfigurableProvider, LegacyMigrationSettings, LegacyPiAiProfile, ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
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
import {
  ANTHROPIC_IMAGE_OFFLOAD_BYTE_QUANTUM,
  ANTHROPIC_IMAGE_OFFLOAD_COUNT_QUANTUM,
  ANTHROPIC_MAX_IMAGES_PER_REQUEST,
  ANTHROPIC_MAX_REQUEST_IMAGE_BYTES,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
  AnthropicAdapter,
} from './anthropic-adapter.ts'
import type { AnthropicCatalogModel, AnthropicConnectionOptions } from './anthropic-adapter.ts'
import { discoverModels as discoverAnthropicModels } from './anthropic-discovery.ts'

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
export {
  ANTHROPIC_IMAGE_OFFLOAD_BYTE_QUANTUM,
  ANTHROPIC_IMAGE_OFFLOAD_COUNT_QUANTUM,
  ANTHROPIC_MAX_IMAGES_PER_REQUEST,
  ANTHROPIC_MAX_REQUEST_IMAGE_BYTES,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
  AnthropicAdapter,
} from './anthropic-adapter.ts'
export type { AnthropicAdapterOptions, AnthropicCatalogModel, AnthropicConnectionOptions } from './anthropic-adapter.ts'
export type { RequestDefaults as AnthropicRequestDefaults, ModelWireFacts as AnthropicModelWireFacts } from './anthropic-serialize.ts'
export { httpErrorCode as anthropicHttpErrorCode } from './anthropic-adapter.ts'
export { MESSAGE_STOP } from './anthropic-sse.ts'

export const name = 'llm-openai'
export const inject = ['llm']

const NS = 'llm-openai'
/**
 * The credentials-store reference a new route defaults to, per protocol. It
 * is a store name, not an environment read: the Models page writes the key
 * under it, every request resolves it through the credentials service, and
 * the launching environment is never consulted.
 */
const DEFAULT_API_KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } as const
/** Public API defaults; a gateway endpoint comes from the profile's `baseURL`. */
export const PUBLIC_BASE_URL = 'https://api.openai.com/v1'
export const ANTHROPIC_PUBLIC_BASE_URL = 'https://api.anthropic.com'

/** Environment variables naming a route's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = { openai: 'OPENAI_BASE_URL', anthropic: 'ANTHROPIC_BASE_URL' } as const

/**
 * The well-known catalog routes this plugin serves: providers whose endpoint
 * and protocol are public knowledge, offered by configuration surfaces as
 * one-key setups before any profile exists. Route ids are global across
 * adapter families, so these double as the family's identity on the Models
 * page.
 */
const CATALOG_PROVIDERS: readonly { provider: string; displayName: string }[] = [
  { provider: 'openai', displayName: 'OpenAI' },
  { provider: 'anthropic', displayName: 'Anthropic' },
]

// The wires carry text and (for vision models) image input; the other
// harness modalities have no wire form on these routes.
const MODEL_MODALITIES = ['text', 'image', 'video', 'file'] as const satisfies readonly ModelModality[]

/** One configured provider route; the `providers` dict key IS the route id. */
export interface ProviderProfile {
  /** Display name for selectors and the Models page; defaults to the route key. */
  displayName?: string
  /** Credential reference (a store name) resolved per request; defaults per protocol (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). */
  apiKeyEnv?: string
  /**
   * Wire protocol every model on this route speaks. `openai-completions`
   * (the default — what every OpenAI-compatible gateway serves) and
   * `openai-responses` post the OpenAI wires; `anthropic-messages` posts
   * the Messages wire to `/v1/messages`.
   */
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /**
   * Endpoint base; the protocol's request path is appended. Defaults per
   * protocol to $OPENAI_BASE_URL / $ANTHROPIC_BASE_URL from a trusted layer,
   * then the public API.
   */
  baseURL?: string
  /** Route-level reasoning-effort default (openai protocols); omitted sends no effort field. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Output-cap wire field for this route, openai protocols only (see the README). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Extended-thinking budget in tokens for reasoning models on a Messages route. */
  thinkingBudgetTokens?: number
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
  api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']),
  thinkingBudgetTokens: z.number().step(1).min(1024),
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

/** One resolved route: the serving protocol and that wire's connection facts. */
export type ResolvedProfile =
  | {
    provider: string
    displayName: string
    api: 'openai-completions' | 'openai-responses'
    openai: OpenAIConnectionOptions
  }
  | {
    provider: string
    displayName: string
    api: 'anthropic-messages'
    anthropic: AnthropicConnectionOptions
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

/** A positive safe-integer bound after defaulting, or the failure naming it. */
function safeBound(provider: string, field: string, value: number | undefined, fallback: number): number {
  const bound = value ?? fallback
  if (!Number.isSafeInteger(bound) || bound <= 0) {
    throw new Error(`llm-openai: provider "${provider}" ${field} must be a positive safe integer`)
  }
  return bound
}

/**
 * Resolve every configured route to its serving protocol and that wire's
 * validated connection facts. An omitted dict resolves to the empty, dormant
 * route set.
 * @param providers - configured profiles keyed by route.
 * @param environment - this run's environment layers; a route without its
 *   own baseURL falls back to its protocol's endpoint variable, then public API.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, ProviderProfile>> | undefined,
  environment?: LaunchEnvironmentSnapshot,
): Map<string, ResolvedProfile> {
  const resolved = new Map<string, ResolvedProfile>()
  for (const [provider, source] of Object.entries(providers ?? {})) {
    if (provider.length === 0) throw new Error('llm-openai: provider route names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-openai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-openai: provider "${provider}" has an empty displayName`)
    }
    const api = source.api ?? 'openai-completions'
    const anthropic = api === 'anthropic-messages'
    if (source.thinkingBudgetTokens !== undefined
      && (!Number.isSafeInteger(source.thinkingBudgetTokens) || source.thinkingBudgetTokens < 1024)) {
      throw new Error(`llm-openai: provider "${provider}" thinkingBudgetTokens must be a safe integer of at least 1024`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs
      ?? (anthropic ? ANTHROPIC_STREAM_IDLE_TIMEOUT_MS : DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-openai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = safeBound(provider, 'maxRequestImageBytes', source.maxRequestImageBytes,
      anthropic ? ANTHROPIC_MAX_REQUEST_IMAGE_BYTES : DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    const maxImagesPerRequest = safeBound(provider, 'maxImagesPerRequest', source.maxImagesPerRequest,
      anthropic ? ANTHROPIC_MAX_IMAGES_PER_REQUEST : DEFAULT_MAX_IMAGES_PER_REQUEST)
    const imageOffloadByteQuantum = safeBound(provider, 'imageOffloadByteQuantum', source.imageOffloadByteQuantum,
      anthropic ? ANTHROPIC_IMAGE_OFFLOAD_BYTE_QUANTUM : DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM)
    if (imageOffloadByteQuantum > maxRequestImageBytes) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadByteQuantum must not exceed maxRequestImageBytes`)
    }
    const imageOffloadCountQuantum = safeBound(provider, 'imageOffloadCountQuantum', source.imageOffloadCountQuantum,
      anthropic ? ANTHROPIC_IMAGE_OFFLOAD_COUNT_QUANTUM : DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM)
    if (imageOffloadCountQuantum > maxImagesPerRequest) {
      throw new Error(`llm-openai: provider "${provider}" imageOffloadCountQuantum must not exceed maxImagesPerRequest`)
    }
    const models = resolveModels(provider, source.models)
    const displayName = source.displayName ?? provider
    const retryPolicy = resolveRetryPolicy(source.retryPolicy, `llm-openai: provider "${provider}" retryPolicy`)
    if (anthropic) {
      resolved.set(provider, {
        provider,
        displayName,
        api,
        anthropic: {
          apiKeyEnv: credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV.anthropic),
          baseURL: source.baseURL
            ?? environment?.get(BASE_URL_ENV.anthropic)?.value
            ?? ANTHROPIC_PUBLIC_BASE_URL,
          defaults: {
            reasoningEffort: source.reasoningEffort,
            thinkingBudgetTokens: source.thinkingBudgetTokens,
          },
          // The Messages wire requires the output-cap field, so the route
          // carries the protocol default when the profile declares none.
          maxTokens: source.maxTokens ?? ANTHROPIC_MAX_TOKENS,
          defaultContextWindow: source.defaultContextWindow,
          models: models as unknown as AnthropicCatalogModel[],
          streamIdleTimeoutMs,
          maxRequestImageBytes,
          maxImagesPerRequest,
          imageOffloadByteQuantum,
          imageOffloadCountQuantum,
          retryPolicy,
        },
      })
      continue
    }
    resolved.set(provider, {
      provider,
      displayName,
      api,
      openai: {
        api,
        apiKeyEnv: credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV.openai),
        baseURL: source.baseURL
          ?? environment?.get(BASE_URL_ENV.openai)?.value
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
        retryPolicy,
      },
    })
  }
  return resolved
}

/**
 * The complete resolve step for one openai-protocol route's connection
 * facts, from a raw profile. Programmatic construction may bypass
 * Schemastery normalization, so every default and bound is re-judged here.
 */
export function resolveAdapterOptions(config: ProviderProfile, environment?: LaunchEnvironmentSnapshot): OpenAIConnectionOptions {
  const key = config.displayName ?? 'openai-compatible'
  const resolved = resolveProfiles({ [key]: config }, environment).get(key)
  if (resolved === undefined || resolved.api === 'anthropic-messages') {
    throw new Error(`llm adapter: profile "${key}" vanished during resolution`)
  }
  return resolved.openai
}

/**
 * The complete resolve step for one Messages-protocol route's connection
 * facts, from a raw profile.
 */
export function resolveAnthropicAdapterOptions(
  config: ProviderProfile,
  environment?: LaunchEnvironmentSnapshot,
): AnthropicConnectionOptions {
  const key = config.displayName ?? 'anthropic-compatible'
  const resolved = resolveProfiles({ [key]: { api: 'anthropic-messages', ...config } }, environment).get(key)
  if (resolved === undefined || resolved.api !== 'anthropic-messages') {
    throw new Error(`llm adapter: profile "${key}" vanished during resolution`)
  }
  return resolved.anthropic
}

/**
 * One-shot absorption of a stored `llm-anthropic` section — the two-package
 * era's second namespace — into this namespace. Routes the target does not
 * already hold move across stamped with their protocol; the source section
 * is then emptied through a transient registration, so a route the user
 * later deletes stays deleted.
 * @param settings - the settings service, with this plugin's section installed.
 * @param log - line function for the one diagnostic per outcome.
 */
export async function foldLegacyAnthropicSection(
  settings: LegacyMigrationSettings & {
    register(ns: string, schema: z<unknown>, options: { base: object }): { replace(section: object): Promise<void> }
  },
  log: (line: string) => void,
): Promise<void> {
  const source = settings.rawSection('llm-anthropic')
  if (source === undefined) return
  const stored = source['providers']
  if (typeof stored !== 'object' || stored === null) return
  const target = settings.rawSection('llm-openai')?.['providers']
  const held = typeof target === 'object' && target !== null ? Object.keys(target) : []
  const picked: Record<string, Record<string, unknown>> = {}
  let conflicts = 0
  for (const [route, value] of Object.entries(stored as Record<string, unknown>)) {
    if (held.includes(route)) {
      conflicts += 1
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    // The source section was the Messages adapter's: its routes arrive
    // stamped with the protocol that served them. Model rows written in the
    // old spelling (`input`) map onto this schema's `inputModalities`, the
    // same conversion the pi-ai import performs; rows already in this
    // schema's spelling pass through it unchanged.
    const models = convertLegacyPiAiModels((value as { models?: unknown }).models)
    picked[route] = {
      ...value,
      api: 'anthropic-messages',
      ...models === undefined ? {} : { models },
    }
  }
  if (Object.keys(picked).length === 0) {
    if (conflicts > 0) {
      log(`llm-openai: ${conflicts} stored llm-anthropic route(s) already exist here; leaving the retired section untouched`)
    }
    return
  }
  await settings.update('llm-openai', { providers: picked })
  // Emptying the source needs its namespace registered for one write; the
  // registration is transient boot state and the stored section is what the
  // next boot reads.
  const scope = settings.register('llm-anthropic', z.object({ providers: z.dict(z.object({})).default({}) }) as unknown as z<unknown>, { base: {} })
  await scope.replace({})
  log(`llm-openai: folded ${Object.keys(picked).length} provider route(s) from the retired llm-anthropic section`
    + (conflicts > 0 ? ` (${conflicts} conflicting route(s) kept as-is)` : ''))
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedProfile> | undefined
  /** Resolved routes for the current snapshot, memoized by snapshot identity. */
  const profiles = (): ReadonlyMap<string, ResolvedProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers, launchEnvironmentOf(ctx))
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const resolveApiKey = async (provider: string, profile: ResolvedProfile): Promise<string> => {
    const ref = profile.api === 'anthropic-messages' ? profile.anthropic.apiKeyEnv : profile.openai.apiKeyEnv
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

  const openaiAdapter = new OpenAIAdapter({
    options: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined || profile.api === 'anthropic-messages') {
        throw new LlmError(`llm-openai: route "${provider}" vanished from configuration`, 'NO_ADAPTER')
      }
      return profile.openai
    },
    resolveApiKey: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined || profile.api === 'anthropic-messages') {
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
  const anthropicAdapter = new AnthropicAdapter({
    options: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined || profile.api !== 'anthropic-messages') {
        throw new LlmError(`llm-openai: route "${provider}" vanished from configuration`, 'NO_ADAPTER')
      }
      return profile.anthropic
    },
    resolveApiKey: (provider) => {
      const profile = profiles().get(provider)
      if (profile === undefined || profile.api !== 'anthropic-messages') {
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
   * registration, so a change to either must re-register. One handle per
   * protocol family — each adapter instance serves exactly its family's
   * routes — swapped atomically and sorted by route so a settings document
   * that merely reorders keys is not mistaken for a route change. A dormant
   * (empty) family registers nothing.
   */
  const families: {
    of: (profile: ResolvedProfile) => boolean
    adapter: OpenAIAdapter | AnthropicAdapter
    registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
    registeredFacts: unknown
  }[] = [
    {
      of: profile => profile.api !== 'anthropic-messages',
      adapter: openaiAdapter,
      registration: undefined,
      registeredFacts: undefined,
    },
    {
      of: profile => profile.api === 'anthropic-messages',
      adapter: anthropicAdapter,
      registration: undefined,
      registeredFacts: undefined,
    },
  ]
  const ensureRegistrationFacts = (): void => {
    for (const family of families) {
      const facts = [...profiles().values()].filter(family.of)
        .map(profile => ({
          route: profile.provider,
          displayName: profile.displayName,
          retryPolicy: profile.api === 'anthropic-messages'
            ? profile.anthropic.retryPolicy
            : profile.openai.retryPolicy,
        }))
        .sort((left, right) => left.route.localeCompare(right.route))
      if (deepEqualJson(facts, family.registeredFacts)) continue
      const routes = facts.map(fact => fact.route)
      if (family.registration === undefined) {
        if (routes.length === 0) {
          family.registeredFacts = facts
          continue
        }
        family.registration = ctx.llm.registerAdapter(routes, family.adapter)
      } else {
        family.registration.replace(routes)
      }
      family.registeredFacts = facts
    }
  }
  ensureRegistrationFacts()

  /**
   * The configurable-provider directory: every well-known catalog route
   * (offered from the moment the plugin mounts, dormant or not, so
   * configuration surfaces can adopt it before any route exists), plus every
   * route the current profiles declare. A hand-declared route has no catalog
   * entry, so without this union it would have no settings address and
   * configuration surfaces could neither show nor edit it.
   */
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries: LlmConfigurableProvider[] = []
    const catalogIds = new Set(CATALOG_PROVIDERS.map(entry => entry.provider))
    const declare = (provider: string, displayName: string): void => {
      if (entries.some(entry => entry.provider === provider)) return
      entries.push({
        provider,
        displayName,
        settingsNs: NS,
        settingsPath: ['providers', provider],
        // Membership of the catalog, not of the settings document: a stored
        // profile for a catalog route narrows it without declaring it.
        declared: !catalogIds.has(provider),
      })
    }
    for (const entry of CATALOG_PROVIDERS) declare(entry.provider, entry.displayName)
    for (const [provider, profile] of profiles()) declare(provider, profile.displayName)
    if (deepEqualJson(entries, directoryFacts)) return
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    directoryFacts = entries
  }
  ensureDirectory()

  /** Discovery for the whole namespace: a being-added route has no profile yet. */
  ctx.llm.registerModelDiscovery(NS, (request, signal) => {
    const profile = request.provider === undefined ? undefined : profiles().get(request.provider)
    const anthropic = profile === undefined
      ? request.api === 'anthropic-messages'
      : profile.api === 'anthropic-messages'
    const catalog = profile === undefined
      ? []
      : profile.api === 'anthropic-messages' ? profile.anthropic.models : profile.openai.models
    const wired = { ...request, ...signal === undefined ? {} : { signal } }
    if (profile === undefined) {
      return anthropic
        ? discoverAnthropicModels(wired, [], undefined)
        : discoverModels(wired, [], undefined)
    }
    const resolveKey = () => resolveApiKey(profile.provider, profile).catch(() => undefined)
    return anthropic
      ? discoverAnthropicModels(wired, catalog as unknown as AnthropicCatalogModel[], resolveKey)
      : discoverModels(wired, catalog, resolveKey)
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
    // One-shot upgrade imports, after installSection so the writes' namespace
    // is registered; the resulting change notifications drive registration
    // through the onChange hook above. First the retired pi-ai section, then
    // the two-package era's llm-anthropic section.
    const settings = settingsCtx.settings as unknown as Parameters<typeof migrateLegacyPiAiProfiles>[0]
      & Parameters<typeof foldLegacyAnthropicSection>[0]
    void migrateLegacyPiAiProfiles(
      settings,
      {
        ns: NS,
        accepts: (route: string, profile: LegacyPiAiProfile): boolean =>
          profile.api === 'openai-completions'
          || profile.api === 'openai-responses'
          || profile.api === 'anthropic-messages'
          // No stored protocol means a pi-ai catalog route; the ones the
          // retired catalog served under their own key land here keyed by
          // route, and a hand-declared profile without an endpoint named no
          // wire to serve.
          || (profile.api === undefined && (route === 'openai' || route === 'anthropic' || typeof profile.baseURL === 'string')),
        convert: (route: string, profile: LegacyPiAiProfile) => convertLegacyPiAiProfile(profile, {
          // Catalog routes named no protocol because the catalog was their
          // default; each catalog key's protocol is what the default restores.
          api: typeof profile.api === 'string'
            ? profile.api
            : (route === 'anthropic' ? 'anthropic-messages' : 'openai-completions'),
        }),
      },
      (line) => { ctx.logger.info(line) },
    )
      .then(() => foldLegacyAnthropicSection(settings, (line) => { ctx.logger.info(line) }))
      .catch((error) => {
        ctx.logger.warn('llm-openai: migrating the retired settings sections failed; their routes stay there')
        ctx.logger.warn(error)
      })
  })
}
