/**
 * Register an {@link AnthropicAdapter} for the `anthropic-compatible` provider
 * route on `ctx.llm`, with connection facts resolved per request instead of
 * frozen at load: the plugin layers its entry config under the optional
 * `llm-anthropic` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * base URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with.
 *
 * The route speaks the Anthropic Messages protocol: the official API and any
 * compatible gateway (custom `baseURL` + credential reference). The route id
 * is deliberately NOT `anthropic` — provider route ids are globally unique
 * across adapters, and pi-ai owns that id.
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
import {
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  AnthropicAdapter,
} from './adapter.ts'
import type { AnthropicCatalogModel, AnthropicConnectionOptions } from './adapter.ts'

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
/**
 * The credentials-store reference this provider resolves. It is a store name,
 * not an environment read: the Models page writes the key under it, every
 * request resolves it through the credentials service, and the launching
 * environment is never consulted.
 */
const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY'
/** The single provider route this plugin owns (NOT `anthropic` — see module doc). */
const PROVIDER = 'anthropic-compatible'

// The Messages API carries text and (for vision models) image input; the
// other harness modalities have no wire form on this route.
const MODEL_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-anthropic` settings-section shape. `maxTokens` defaults to the
 * shipped catalog's own output cap because the Messages API REQUIRES a cap
 * on every request — there is no "omit and let the provider decide".
 */
export interface Config {
  /** Credential reference (a store name) resolved per request; defaults to `ANTHROPIC_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $ANTHROPIC_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Default thinking effort (none sent when omitted); `off` never sends thinking. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Extended-thinking budget in tokens for reasoning models (default 16,384; clamped ≥1024 and below the cap). */
  thinkingBudgetTokens?: number
  /** Default per-request output cap (default 128,000 — the API requires this field). */
  maxTokens?: number
  /** Context capacity used when the selected model declares none; omitted reports no context bound. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to none — declare what the endpoint serves. */
  models?: AnthropicCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated inline base64 image payload per chat request (default 20 MiB). */
  maxRequestImageBytes?: number
  /** Maximum number of represented images per chat request (default 600). */
  maxImagesPerRequest?: number
  /** Base64-byte removal step after the request exceeds its image-byte bound (default 10 MiB). */
  imageOffloadByteQuantum?: number
  /** Image-count removal step after the request exceeds its count bound (default 20). */
  imageOffloadCountQuantum?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
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

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
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

/** Public API default; a gateway endpoint comes from `baseURL`. */
export const PUBLIC_BASE_URL = 'https://api.anthropic.com'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'ANTHROPIC_BASE_URL'

/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedAnthropicOptions = AnthropicConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly AnthropicCatalogModel[] | undefined): AnthropicCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error('llm-anthropic: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-anthropic: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-anthropic: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-anthropic: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-anthropic: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-anthropic: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-anthropic: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    // Widened: a dynamic config update reaches this check without schema validation.
    const systemPromptUpdate: string | undefined = model.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new Error(`llm-anthropic: catalog model "${model.id}" systemPromptUpdate must be "in-history" when present`)
    }
    if (seen.has(model.id)) throw new Error(`llm-anthropic: duplicate catalog model "${model.id}"`)
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
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedAnthropicOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-anthropic: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-anthropic: maxTokens must be a positive safe integer')
  }
  if (config.thinkingBudgetTokens !== undefined
    && (!Number.isSafeInteger(config.thinkingBudgetTokens) || config.thinkingBudgetTokens < 1024)) {
    throw new Error('llm-anthropic: thinkingBudgetTokens must be a safe integer of at least 1024')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-anthropic: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-anthropic: maxRequestImageBytes must be a positive safe integer')
  }
  const maxImagesPerRequest = config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
    throw new Error('llm-anthropic: maxImagesPerRequest must be a positive safe integer')
  }
  const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
    throw new Error('llm-anthropic: imageOffloadByteQuantum must be a positive safe integer')
  }
  if (imageOffloadByteQuantum > maxRequestImageBytes) {
    throw new Error('llm-anthropic: imageOffloadByteQuantum must not exceed maxRequestImageBytes')
  }
  const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
  if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
    throw new Error('llm-anthropic: imageOffloadCountQuantum must be a positive safe integer')
  }
  if (imageOffloadCountQuantum > maxImagesPerRequest) {
    throw new Error('llm-anthropic: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    defaults: {
      reasoningEffort: config.reasoningEffort,
      thinkingBudgetTokens: config.thinkingBudgetTokens,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    maxImagesPerRequest,
    imageOffloadByteQuantum,
    imageOffloadCountQuantum,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-anthropic: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedAnthropicOptions | undefined
  const options = (): ResolvedAnthropicOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-anthropic: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedAnthropicOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-anthropic', ref)
    }
    // Credentials come only from the user-configured store; the launching
    // environment is deliberately not consulted.
    throw new LlmError(
      `llm-anthropic: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ' service (the web Models page writes it)',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new AnthropicAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Anthropic', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}
