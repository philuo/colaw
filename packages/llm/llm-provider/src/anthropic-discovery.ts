/**
 * Answering "which models can this endpoint serve?" for the configuration
 * surface's "fetch available models" action (protocol evidence: pi-ai
 * 0.85.1's discovery, adapted to the dedicated OpenAI chat-completions
 * route).
 *
 * A draft naming this route without a baseURL is answered from the
 * user-configured catalog with no network call. Anything else is
 * interrogated over the wire at `GET {root}/v1/models?limit=1000` with
 * `x-api-key` plus the pinned `anthropic-version` — the listing the official
 * endpoint and Anthropic-protocol gateways publish. The root is the base
 * without trailing slashes and without one trailing `/v1` segment: gateway
 * documentation publishes both spellings of the same root. The parser accepts the
 * standard `data` array and the enriched `models` map some gateways expose;
 * entries without a usable id are skipped rather than failing the rest.
 *
 * Nothing here is stored: the request carries a draft the user is still
 * editing, and the reply is candidate metadata the surface offers for
 * adoption. `settings.yaml` remains the only thing that decides what a route
 * serves.
 *
 * @module dsh-llm-provider/anthropic-discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** Largest model-list reply accepted; the endpoint is user-typed, so the ceiling holds on bytes actually read. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported model-listing reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listing. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  maxTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/anthropic` keeps its segments; one trailing
 * `/v1` is normalized away because the listing path appends its own.
 */
function listingUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=1000`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. The accumulated
 * total is what actually enforces the bound, because a server that
 * under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {
      // Cancel after a drained read is cleanup; the reply is already decided.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one model-listing reply. The standard `data` array takes precedence
 * when both supported formats are present; an enriched `models` map uses each
 * property key as the endpoint-facing id. Entries without a usable id are
 * skipped rather than failing the whole interrogation.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    listed = (data as readonly unknown[]).map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: LlmDiscoveredModel[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/** Accept one probe key, or refuse it before the header is built. */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft endpoint for the models it advertises. A draft that
 * names this route and no baseURL is answered from the user-configured
 * catalog (the same rows listModels reports); a baseURL is interrogated over
 * the wire with the one-shot key from the form, falling back to the caller's
 * stored-credential resolver.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param catalog - the route's user-configured rows, for the no-network path.
 * @param storedApiKey - lazy stored-credential resolution for the named route.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the endpoint refuses, fails, or answers with
 *   something that is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  catalog: readonly LlmDiscoveredModel[],
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.provider !== undefined && (request.baseURL === undefined || request.baseURL.length === 0)) {
    // A route this adapter owns is answered from its configured catalog: the
    // rows carry capacities no listing endpoint reports, and no network call
    // is spent re-asking what settings already decide.
    if (catalog.length > 0) return catalog.map(model => ({ ...model }))
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `model discovery needs a baseURL: provider "${request.provider ?? ''}" has no configured models to list`,
      'DISCOVERY_FAILED',
    )
  }
  const url = listingUrl(request.baseURL)
  const supplied = request.apiKey ?? (storedApiKey === undefined ? undefined : await storedApiKey())
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    const headers = new Headers({ accept: 'application/json' })
    headers.set('anthropic-version', '2023-06-01')
    if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
