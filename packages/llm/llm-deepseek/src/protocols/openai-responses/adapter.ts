/**
 * `DeepSeekResponsesAdapter`: fetch + SSE against a DeepSeek Responses endpoint,
 * emitting harness StreamChunks. Transport only — connection facts arrive
 * through a thunk resolved once per operation and the bearer token through a
 * per-request resolver, so the registering plugin owns validation, layering and
 * credential policy.
 *
 * It mirrors the chat-completions adapter because both are OpenAI-family wires
 * (bearer auth, the same error-body shape, the same idle watchdog and retry
 * contract), and differs in exactly four places:
 *
 * 1. the request path is `/responses`;
 * 2. the body comes from this directory's `serialize.ts`, which honours the
 *    Responses contract the chat-completions serializer does not (see its
 *    header);
 * 3. the stream is framed by this directory's `sse.ts` and terminated by
 *    `translate.ts`, because this wire has no `data: [DONE]` — the terminal
 *    event is the only proof a response finished;
 * 4. an image may travel as a Files API `file_id` instead of inline base64,
 *    which is what lifts the 32 MiB inline bound for a large image.
 *
 * The plugin-contributed request extensions are deliberately not applied here.
 * That mechanism exists for the chat-completions body, and this endpoint
 * **silently ignores** parameters it does not support — so an extension field
 * would be a no-op that looks like a success.
 *
 * @module dsh-llm-deepseek/openai-responses-adapter
 */

import { attributionHeaders, contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  PreparedAdapterCall,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { catalogModelInfo, modelInfo } from '../../common/model-info.ts'
import { deepSeekImageRequestPricing } from '../../common/request-pricing.ts'
import { FileResolutionFailure, RequestFiles } from '../../common/request-files.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from '../../common/types.ts'
import type { DeepSeekFileStore } from '../../common/file-store.ts'
import { httpErrorCode, prepareRequestImages, providerRetryAfterMs, requestId } from '../chat-completions/adapter.ts'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translateResponses } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** The Responses wire against one configured route. */
export class DeepSeekResponsesAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly config: DeepSeekAdapterOptions & { resolveFiles: () => DeepSeekFileStore }) {
    super()
    this.files = config.resolveFiles()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override imageRequestPricing(_provider: string, model: string): ReturnType<LlmAdapter['imageRequestPricing']> {
    const attachments = this.config.resolveAttachments?.()
    const resolveAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => (
        this.config.resolveImageAccess?.(attachments, ref)
      )
    return deepSeekImageRequestPricing(this.config.options(), model, resolveAccess)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.config.options(), provider, model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: modelInfo(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: DeepSeekConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: an in-flight stream never observes a
    // configuration change, and the key resolves from this same snapshot so an
    // endpoint and the secret sent to it cannot come from different generations.
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      const model = connection.models.find(entry => entry.id === options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(`DeepSeek model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError('DeepSeek image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
      }
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options, watchdog.signal, connection, apiKey, userId, attachments,
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
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
      ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
    }
    const fileConnection = { baseURL: connection.baseURL, apiKey, protocol: connection.protocol }
    const model = connection.models.find(entry => entry.id === options.model)
    const resolveImageAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)
    const imageAccessOptions = resolveImageAccess === undefined ? {} : { resolveImageAccess }
    const requestImages = attachments === undefined || model === undefined
      ? new Map<AttachmentId, RequestImageAttachment>()
      : await prepareRequestImages(options, attachments, model, signal)
    // A Files API reference is tried first: it is what lets a large image past
    // the inline bound, and the fallback below is the same base64 path every
    // other request uses.
    let representation: 'file' | 'base64' = 'file'
    const requestFiles = new RequestFiles(
      this.files, fileConnection, connection.filePolicy, connection.filesApiTimeoutMs, signal, onActivity,
    )
    while (true) {
      requestFiles.beginAttempt()
      let body: WireRequest
      if (attachments === undefined) {
        body = serializeRequest(options, connection.defaults)
      } else if (representation === 'base64') {
        body = await serializeRequestWithImages(options, {
          representation: { kind: 'base64' },
          requestImages,
          ...imageAccessOptions,
          maxRequestImageBytes: connection.maxInlineRequestImageBytes,
          maxImagesPerRequest: connection.maxImagesPerRequest,
          byteQuantum: connection.inlineImageOffloadByteQuantum,
          countQuantum: connection.imageOffloadCountQuantum,
        }, connection.defaults)
      } else {
        try {
          body = await serializeRequestWithImages(options, {
            representation: {
              kind: 'file',
              resolveFileId: (version, _block, location) => requestFiles.resolve(version, location),
            },
            requestImages,
            ...imageAccessOptions,
            maxRequestImageBytes: connection.maxRequestFilesBytes,
            maxImagesPerRequest: connection.maxImagesPerRequest,
            byteQuantum: connection.imageOffloadByteQuantum,
            countQuantum: connection.imageOffloadCountQuantum,
          }, connection.defaults)
        } catch (error: unknown) {
          if (!(error instanceof FileResolutionFailure)) throw error
          representation = 'base64'
          continue
        }
      }

      let response: Response
      try {
        response = await fetch(`${connection.baseURL}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(`DeepSeek API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        let message = `DeepSeek API error (HTTP ${response.status})`
        let providerError: WireError['error']
        const rawResponse = await response.text()
        try {
          const parsed = JSON.parse(rawResponse) as WireError
          providerError = parsed.error
          if (providerError?.message !== undefined && providerError.message.length > 0) message = providerError.message
        } catch {
          // The HTTP status stays authoritative when a gateway returns malformed JSON.
        }
        const detail = [providerError?.code, providerError?.type, providerError?.message]
          .filter((field): field is string => typeof field === 'string')
          .join(' ')
        if (await requestFiles.retry(detail)) continue
        message = requestFiles.errorMessage(response.status, message, detail)
        const delay = providerRetryAfterMs(response.headers.get('retry-after'))
        const id = requestId(response.headers)
        throw new LlmError(message, httpErrorCode(response.status, providerError), {
          cause: new Error(rawResponse.length > 0 ? rawResponse : `DeepSeek HTTP ${response.status}`),
          status: response.status,
          ...delay === undefined ? {} : { providerRetryAfterMs: delay },
          ...id === undefined ? {} : { requestId: id },
        })
      }
      if (!response.body) throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')

      yield* translateResponses(parseSse(response.textStream(), onActivity))
      return
    }
  }
}
