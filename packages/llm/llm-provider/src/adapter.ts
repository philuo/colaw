/**
 * `OpenAIAdapter`: fetch + SSE against the OpenAI chat-completions or
 * Responses endpoint (selected per route by the connection's `api`), emitting
 * harness StreamChunks. The adapter is transport-only: connection
 * facts arrive through a thunk resolved once per operation and the bearer
 * token through a per-request resolver, so the registering plugin owns
 * validation, layering, and credential policy. Images ride inline base64
 * data URLs; there is no Files API on this route.
 *
 * @module dsh-llm-provider/adapter
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
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { sseFrames } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MAX_REQUEST_FILE_BYTES, ridesNatively } from './native-media.ts'
import type { NativeAttachmentFamily } from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import { serializeResponsesRequest, serializeResponsesRequestWithImages } from './responses-serialize.ts'
import { translateResponses } from './responses-translate.ts'
import type { ModelWireFacts, RequestDefaults } from './serialize.ts'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type { WireError } from './types.ts'

/** The request modalities chat completions can represent. */
/** One optional model entry advertised by the direct-fetch adapter. */
export interface OpenAICatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's configured cap, when any. */
  maxTokens?: number
  /** The endpoint accepts a `reasoning_effort` field for this model (OpenAI reasoning models). */
  reasoning?: boolean
  /** zai-dialect thinking toggle + `tool_stream` side channel (zai gateways). */
  thinkingFormat?: 'zai'
  zaiToolStream?: boolean
  /** Accepted request modalities; omission is text-only. Chat completions carries only text and image. */
  inputModalities?: ModelModality[]
  /** Total-pixel budget for one deterministic request preview, or the 512-by-512 `low` preset. */
  imagePixelBudget?: number | 'low'
  /** Encoded-byte target for one deterministic request preview; the smallest quality-ladder output is used when no quality fits. */
  imageMaxBytes?: number
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
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface OpenAIConnectionOptions {
  /** Display name of the route these facts belong to (selectors, pickers). */
  displayName: string
  /** Endpoint base; `/chat/completions` is appended (completions protocol). */
  baseURL: string
  /** Wire protocol this route speaks. */
  api: 'openai-completions' | 'openai-responses'
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (effort policy, cap field name). */
  defaults: RequestDefaults
  /** Per-request output cap applied when the request and catalog declare none; `undefined` sends no cap. */
  maxTokens: number | undefined
  /** Context capacity used when the selected model declares none; `undefined` reports no context bound. */
  defaultContextWindow: number | undefined
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly OpenAICatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated inline base64 image payload in one request. */
  maxRequestImageBytes: number
  /** Maximum represented images in one request. */
  maxImagesPerRequest: number
  /** Inline byte bound for each native file/video part on this route. */
  maxRequestFileBytes: number
  /** Base64-byte removal step after the request exceeds its byte bound. */
  imageOffloadByteQuantum: number
  /** Image-count removal step after the request exceeds its count bound. */
  imageOffloadCountQuantum: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link OpenAIAdapter}: the operation-local resolution hooks the plugin owns. */
export interface OpenAIAdapterOptions {
  /** Validated connection facts for one provider route; called once per operation with the route name. */
  options: (provider: string) => OpenAIConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * route name and snapshot are passed in — never re-read — so the key can
   * only ever come from the same resolution as the endpoint it is sent to.
   * Throws `LlmError` `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (provider: string, connection: OpenAIConnectionOptions) => Promise<string>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default bound on accumulated inline base64 image payload in one request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
export { DEFAULT_MAX_REQUEST_FILE_BYTES }
/** Default maximum represented images in one request. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Deterministic base64-byte removal step after the byte bound is exceeded. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Deterministic image-count removal step after the count bound is exceeded. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** Default total-pixel budget for one deterministic request preview. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 640_000
/** The 512-by-512 `low` request-preview pixel preset. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Default encoded-byte target for one deterministic request preview. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
/** OpenAI's reasoning vocabulary tops out at `high`; harness `max` maps there on the wire. */
const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The strongest OpenAI reasoning level; harness `max` also maps here.',
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

/** The `ImageRequestPolicy` one catalog model selects for its request previews. */
export function resolveRequestImagePolicy(model: OpenAICatalogModel): { maxPixels: number; maxBytes: number } {
  const maxPixels = model.imagePixelBudget === 'low'
    ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
    : model.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  return {
    maxPixels,
    maxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
}

/**
 * Resolve the exact request target for one attachment on this route: the
 * aspect-preserving projection of the source onto the policy's pixel budget,
 * carrying the encoded-byte budget the quality ladder targets. The attachment
 * seam takes resolved target dimensions, so the pixel budget is applied here
 * rather than inside the encoder.
 * @param ref - provider-independent attachment reference carrying the source size.
 * @param policy - route-owned pixel and byte policy.
 * @returns the seam's target dimensions and byte budget.
 */
export function resolveRequestImageTarget(
  ref: Pick<ImageAttachmentRef, 'width' | 'height'>,
  policy: { maxPixels: number; maxBytes: number },
): ImageRequestTarget {
  return {
    ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
    maxBytes: policy.maxBytes,
  }
}

async function prepareRequestImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  model: OpenAICatalogModel,
  signal: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const policy = resolveRequestImagePolicy(model)
  const orderedRefs = [...refs.values()]
  const projected = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, resolveRequestImageTarget(ref, policy), signal),
  ))
  return new Map(orderedRefs.map((ref, index) => (
    [ref.attachmentId, projected[index] as RequestImageAttachment]
  )))
}

function modelInfo(provider: string, model: OpenAICatalogModel): LlmModelInfo {
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
  const value = headers.get('x-request-id')
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
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The OpenAI chat-completions `LlmAdapter`. One instance serves every model
 * name it was registered under (the harness model name IS the wire model
 * name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class OpenAIAdapter extends LlmAdapter {
  constructor(private readonly config: OpenAIAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // One adapter serves every provider family, so the label is the route's
    // own display name (zai-coding-cn, openai, …) — never a vendor brand.
    try {
      return { id: provider, name: this.config.options(provider).displayName }
    } catch {
      // A route that vanished from configuration keeps its id as the label.
      return { id: provider, name: provider }
    }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.config.options(provider).retryPolicy
  }

  /**
   * Both OpenAI wires carry documents; only chat completions carries motion
   * pictures — GLM's and DashScope's `video_url` parts live on that protocol,
   * and the Responses API has no video input.
   */
  override nativeAttachments(provider: string, _model: string): readonly NativeAttachmentFamily[] {
    return this.config.options(provider).api === 'openai-responses' ? ['document'] : ['video', 'document']
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
    connection: OpenAIConnectionOptions,
    provider: string,
    model: string,
  ): LlmResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    const defaultMaxTokens = configured?.maxTokens ?? connection.maxTokens
    return {
      // An uncatalogued endpoint is safely treated as text-only and
      // non-reasoning. Declaring unverified capabilities would let the host
      // persist input that the endpoint may reject on every later turn.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
      ...configured?.reasoning === true
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

  private wireFactsFor(connection: OpenAIConnectionOptions, model: string): ModelWireFacts | undefined {
    const configured = connection.models.find(entry => entry.id === model)
    return configured === undefined ? undefined : { reasoning: configured.reasoning === true }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options(provider)
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: streamOptions => this.streamWithConnection(streamOptions, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options(options.provider))
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: OpenAIConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const model = connection.models.find(entry => entry.id === options.model)
    const families = this.nativeAttachments(options.provider, options.model)
    const mediaOptions = { families }
    // A file rides natively only where assembly keeps it: this route's wire
    // carries the family AND the model declares the matching modality.
    const nativeFiles = options.messages.some(message => message.content.some(block => (
      block.type === 'file' && ridesNatively(mediaOptions, block.attachment)
    )))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `OpenAI model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    if (hasImages || nativeFiles) {
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          hasImages
            ? 'OpenAI image conversion requires the durable attachment service.'
            : 'OpenAI native file conversion requires the durable attachment service.',
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
          `OpenAI stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('OpenAI request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`OpenAI API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('OpenAI stream consumer stopped')
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
    connection: OpenAIConnectionOptions,
    apiKey: string,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    const model = connection.models.find(entry => entry.id === options.model)
    const wireFacts = this.wireFactsFor(connection, options.model)
    const resolveImageAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)
    // Native media (images, or files the runtime kept) needs the async path;
    // a request with neither keeps the synchronous text-only conversion.
    const native = attachments === undefined
      ? undefined
      : {
        attachments,
        families: this.nativeAttachments(options.provider, options.model),
        maxBytes: connection.maxRequestFileBytes,
      }
    let body
    if (attachments === undefined || native === undefined) {
      body = connection.api === 'openai-responses'
        ? serializeResponsesRequest(options, connection.defaults, wireFacts)
        : serializeRequest(options, connection.defaults, wireFacts)
    } else {
      const requestImages = await prepareRequestImages(options, attachments, model ?? {
        id: options.model,
        inputModalities: ['image'],
      }, signal)
      const images = {
        requestImages,
        ...resolveImageAccess === undefined ? {} : { resolveImageAccess },
        maxRequestImageBytes: connection.maxRequestImageBytes,
        maxImagesPerRequest: connection.maxImagesPerRequest,
        byteQuantum: connection.imageOffloadByteQuantum,
        countQuantum: connection.imageOffloadCountQuantum,
      }
      body = connection.api === 'openai-responses'
        ? await serializeResponsesRequestWithImages(options, images, connection.defaults, wireFacts)
        : await serializeRequestWithImages(options, images, connection.defaults, wireFacts, native)
    }

    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    let response: Response
    try {
      response = await fetch(connection.api === 'openai-responses'
        ? `${connection.baseURL}/responses`
        : `${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `OpenAI API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `OpenAI API error (HTTP ${response.status})`
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
        cause: new Error(rawResponse.length > 0 ? rawResponse : `OpenAI HTTP ${response.status}`),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('OpenAI API returned no response body', 'EMPTY_RESPONSE')
    }

    // The Responses wire terminates on its completed/incomplete event, not a
    // [DONE] sentinel, so its payloads come straight off the shared framer;
    // translateResponses owns the terminal contract.
    yield* connection.api === 'openai-responses'
      ? translateResponses(dataPayloads(response.textStream(), onActivity))
      : translate(parseSse(response.textStream(), onActivity))
  }
}

/** Yield every frame's data payload; terminal-event contracts belong to the consumer. */
async function* dataPayloads(
  stream: ReadableStream<string>,
  onActivity: () => void,
): AsyncGenerator<string> {
  for await (const frame of sseFrames(stream, onActivity)) {
    yield frame.data
  }
}
