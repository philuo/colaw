/**
 * `AnthropicAdapter`: fetch + SSE against the Anthropic Messages endpoint,
 * emitting harness StreamChunks. The adapter is transport-only: connection
 * facts arrive through a thunk resolved once per operation and the API key
 * through a per-request resolver, so the registering plugin owns validation,
 * layering, and credential policy. Images ride inline base64 sources; there
 * is no Files API on this route.
 *
 * @module dsh-llm-provider/anthropic-adapter
 */

import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  PreparedAdapterCall,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  SystemPromptUpdate,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseSse } from './anthropic-sse.ts'
import { translate } from './anthropic-translate.ts'
import { serializeRequest, serializeRequestWithImages, resolveRequestImageTarget } from './anthropic-serialize.ts'
import { ridesNatively } from './native-media.ts'
import type { NativeAttachmentFamily } from '@deepseek-ai/dsh-llm'
import type { ModelWireFacts, RequestDefaults } from './anthropic-serialize.ts'
import type { WireError } from './anthropic-types.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface AnthropicCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model (the Messages API requires a cap on every request). */
  maxTokens?: number
  /**
   * The model accepts extended thinking (`thinking` on the wire). The
   * settings-mapped catalog defaults this to `true`; set `false` for a model
   * the endpoint would refuse the field on.
   */
  reasoning?: boolean
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /**
   * `'in-history'` declares that the endpoint reads the latest `system`
   * message at any position of the conversation as the complete effective
   * system prompt; omission means only a leading system message is read.
   */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation.
 */
export interface AnthropicConnectionOptions {
  /** Display name of the route these facts belong to (selectors, pickers). */
  displayName: string
  /** Endpoint base; `/v1/messages` is appended. */
  baseURL: string
  /** Credential reference of this same resolution, resolved per request. */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (effort policy, thinking budget). */
  defaults: RequestDefaults
  /** Output cap applied when the request and catalog declare none. */
  maxTokens: number
  /** Context capacity used when the selected model declares none; `undefined` reports no context bound. */
  defaultContextWindow: number | undefined
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly AnthropicCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Inline byte bound for each native file part on this route. */
  maxRequestFileBytes: number
  /** Maximum accumulated inline base64 image payload in one request. */
  maxRequestImageBytes: number
  /** Maximum represented images in one request. */
  maxImagesPerRequest: number
  /** Base64-byte removal step after the byte bound is exceeded. */
  imageOffloadByteQuantum: number
  /** Image-count removal step after the count bound is exceeded. */
  imageOffloadCountQuantum: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link AnthropicAdapter}: the operation-local resolution hooks the plugin owns. */
export interface AnthropicAdapterOptions {
  /** Validated connection facts for one provider route; called once per operation with the route name. */
  options: (provider: string) => AnthropicConnectionOptions
  /**
   * Resolve the API key for the connection facts of one request. The route
   * name and snapshot are passed in — never re-read. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (provider: string, connection: AnthropicConnectionOptions) => Promise<string>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default output cap (the shipped Anthropic catalog's own per-model cap). */
export const ANTHROPIC_MAX_TOKENS = 128_000
/** Default bound on accumulated inline base64 image payload in one request. */
export const ANTHROPIC_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum represented images in one request. */
export const ANTHROPIC_MAX_IMAGES_PER_REQUEST = 600
/** Deterministic base64-byte removal step after the byte bound is exceeded. */
export const ANTHROPIC_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Deterministic image-count removal step after the count bound is exceeded. */
export const ANTHROPIC_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** Default total-pixel budget for one deterministic request preview. */
export const ANTHROPIC_REQUEST_IMAGE_PIXEL_BUDGET = 640_000
/** The 512-by-512 `low` request-preview pixel preset. */
export const ANTHROPIC_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Default encoded-byte target for one deterministic request preview. */
export const ANTHROPIC_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
/** Extended thinking is binary on the wire; harness `max` maps to `high`. */
const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'A small thinking budget.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The full thinking budget; harness `max` also maps here.',
  },
] as const

function collectImageRefs(
  content: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of content) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareRequestImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  signal: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const projected = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, resolveRequestImageTarget(ref), signal),
  ))
  return new Map(orderedRefs.map((ref, index) => (
    [ref.attachmentId, projected[index] as RequestImageAttachment]
  )))
}

function modelInfo(provider: string, model: AnthropicCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('request-id') ?? headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status === 529) return 'SERVER'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The Anthropic Messages `LlmAdapter`. One instance serves every model name
 * it was registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class AnthropicAdapter extends LlmAdapter {
  constructor(private readonly config: AnthropicAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    try {
      return { id: provider, name: this.config.options(provider).displayName }
    } catch {
      return { id: provider, name: provider }
    }
  }

  /**
   * The Messages protocol carries documents (`document` blocks, base64
   * sources) and has no video input at all, so motion pictures stay on the
   * harness's handle-text projection for this route.
   */
  override nativeAttachments(_provider: string, _model: string): readonly NativeAttachmentFamily[] {
    return ['document']
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.config.options(provider).retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options(provider).models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfoFor(this.config.options(provider), provider, model))
  }

  private modelInfoFor(
    connection: AnthropicConnectionOptions,
    provider: string,
    model: string,
  ): LlmResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    if (configured === undefined) {
      // An uncatalogued endpoint is safely treated as text-only and
      // non-reasoning. Declaring unverified capabilities would let the host
      // persist input that the endpoint may reject on every later turn.
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        ...connection.defaultContextWindow === undefined ? {} : { context: { contextWindow: connection.defaultContextWindow } },
        ...connection.maxTokens === undefined ? {} : { defaultMaxTokens: connection.maxTokens },
      }
    }
    const contextWindow = configured.contextWindow ?? connection.defaultContextWindow
    const defaultMaxTokens = configured.maxTokens ?? connection.maxTokens
    return {
      ...modelInfo(provider, configured),
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      ...configured.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
      ...configured.reasoning === true
        ? {
          reasoning: {
            efforts: REASONING_EFFORTS,
            ...connection.defaults.reasoningEffort === undefined ? {} : {
              defaultEffort: connection.defaults.reasoningEffort === 'max'
                ? HIGH_REASONING_EFFORT
                : connection.defaults.reasoningEffort === 'low'
                  ? LOW_REASONING_EFFORT
                  : connection.defaults.reasoningEffort === 'off'
                    ? OFF_REASONING_EFFORT
                    : HIGH_REASONING_EFFORT,
            },
          },
        }
        : {},
    }
  }

  private wireFactsFor(connection: AnthropicConnectionOptions, model: string): ModelWireFacts | undefined {
    const configured = connection.models.find(entry => entry.id === model)
    return configured === undefined
      ? undefined
      : { reasoning: configured.reasoning === true, maxTokens: configured.maxTokens }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options(provider)
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options(options.provider))
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: AnthropicConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request.
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const families = this.nativeAttachments(options.provider, options.model)
    const nativeFiles = options.messages.some(message => message.content.some(block => (
      block.type === 'file' && ridesNatively({ families }, block.attachment)
    )))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      const model = connection.models.find(entry => entry.id === options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `Anthropic model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    if (hasImages || nativeFiles) {
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          hasImages
            ? 'Anthropic image conversion requires the durable attachment service.'
            : 'Anthropic native file conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const apiKey = await this.config.resolveApiKey(options.provider, connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Anthropic stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Anthropic request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Anthropic API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Anthropic stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: AnthropicConnectionOptions,
    apiKey: string,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    const wireFacts = this.wireFactsFor(connection, options.model)
    const resolveImageAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)
    let body
    const native = attachments === undefined
      ? undefined
      : {
        attachments,
        families: this.nativeAttachments(options.provider, options.model),
        maxBytes: connection.maxRequestFileBytes,
      }
    if (attachments === undefined || native === undefined) {
      body = serializeRequest(options, connection.defaults, wireFacts)
    } else {
      const requestImages = await prepareRequestImages(options, attachments, signal)
      body = await serializeRequestWithImages(options, {
        requestImages,
        ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
        maxRequestImageBytes: connection.maxRequestImageBytes,
        maxImagesPerRequest: connection.maxImagesPerRequest,
        byteQuantum: connection.imageOffloadByteQuantum,
        countQuantum: connection.imageOffloadCountQuantum,
      }, connection.defaults, wireFacts)
    }

    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/v1/messages`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Anthropic API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `Anthropic API error (HTTP ${response.status})`
      let providerError: WireError['error']
      const rawResponse = await response.text()
      try {
        const parsed = JSON.parse(rawResponse) as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // The HTTP status remains authoritative when a gateway returns malformed JSON.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        cause: new Error(rawResponse.length > 0 ? rawResponse : `Anthropic HTTP ${response.status}`),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('Anthropic API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.textStream(), onActivity))
  }
}
