/**
 * `AnySearchProvider`: a `WebSearchProvider` backed by the AnySearch MCP
 * endpoint (a stateless JSON-RPC `tools/call` of its `search` tool). The tool
 * answers with one text block of markdown-shaped results, which is parsed into
 * citeable sources and also carried verbatim as the result `content`.
 * @module @deepseek-ai/dsh-web-search-anysearch/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { McpRequest, McpResponse } from './types.ts'

/** Stable id this provider registers under; the web seam selects it by name. */
export const ANYSEARCH_PROVIDER_ID = 'anysearch'

/** Default AnySearch MCP endpoint (the whole JSON-RPC exchange is one POST). */
export const ANYSEARCH_DEFAULT_ENDPOINT = 'https://api.anysearch.com/mcp'

/** The MCP tool this provider calls. */
const SEARCH_TOOL = 'search'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies defaults). */
export interface AnySearchProviderOptions {
  /** AnySearch API key, or empty when the key resolves per search. */
  apiKey?: string
  /** Resolves the key per search (the credentials seam); wins over `apiKey`. */
  resolveApiKey?: () => Promise<string>
  /** The MCP endpoint URL. */
  endpoint: string
}

/** One parsed result entry of the tool's markdown answer. */
export interface AnySearchEntry {
  url: string
  title?: string
  snippet?: string
}

/**
 * Parse the tool's markdown answer into citeable entries.
 *
 * The format is the tool's own contract: one `### <n>. <title>` heading per
 * entry, a `- **URL**: <url>` line beneath it, and any further lines are that
 * entry's snippet. Text outside any entry (the results banner, trailing
 * guidance) is not an entry and is dropped here — it rides the result's
 * `content` verbatim instead, so nothing the tool said is lost.
 */
export function parseAnySearchAnswer(markdown: string): AnySearchEntry[] {
  const entries: AnySearchEntry[] = []
  const sections = markdown.split(/^### /m).slice(1)
  for (const section of sections) {
    const lines = section.split('\n')
    const heading = lines[0]?.trim() ?? ''
    const title = heading.replace(/^\d+\.\s*/, '').trim()
    let url: string | undefined
    const snippetLines: string[] = []
    for (const line of lines.slice(1)) {
      const match = /^-\s*\*\*URL\*\*:\s*(\S+)\s*$/u.exec(line)
      if (match !== null) {
        url = match[1]
        continue
      }
      if (line.trim().length > 0) snippetLines.push(line.trim())
    }
    if (url === undefined) continue
    entries.push({
      url,
      ...title.length > 0 ? { title } : {},
      ...snippetLines.length > 0 ? { snippet: snippetLines.join(' ') } : {},
    })
  }
  return entries
}

/**
 * The AnySearch-backed search provider. The endpoint is stateless, so one
 * HTTP call is one search; the key may be a literal or resolve per search
 * through the credentials seam (the settings card writes it there).
 */
export class AnySearchProvider implements WebSearchProvider {
  readonly id = ANYSEARCH_PROVIDER_ID

  constructor(private readonly options: AnySearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.endpoint)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await this.resolveKey(signal)
    const body: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: SEARCH_TOOL,
        arguments: {
          query: request.query,
          ...request.maxResults !== undefined ? { max_results: request.maxResults } : {},
        },
      },
    }

    let response: Response
    try {
      response = await fetch(this.options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`AnySearch search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `AnySearch API error (HTTP ${status})`
      try {
        const parsed = await response.json() as { error?: { message?: string }; message?: string }
        const detail = parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let payload: McpResponse
    try {
      payload = await response.json() as McpResponse
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`AnySearch returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (payload.error !== undefined) {
      throw new WebError(`AnySearch tool error: ${payload.error.message}`, 'WEB_PROVIDER_ERROR')
    }
    if (payload.result?.isError === true) {
      throw new WebError(`AnySearch tool failed: ${payload.result.content?.[0]?.text ?? 'unknown error'}`, 'WEB_PROVIDER_ERROR')
    }

    const markdown = payload.result?.content?.find(block => block.type === 'text')?.text ?? ''
    const entries = parseAnySearchAnswer(markdown)
    const sources: WebSearchSource[] = entries.map(entry => ({
      url: entry.url,
      ...entry.title !== undefined ? { title: entry.title } : {},
      ...entry.snippet !== undefined ? { snippet: entry.snippet } : {},
    }))
    // The tool's whole answer rides `content` verbatim: it is the generated
    // search context, and parsing is best-effort over the tool's own format.
    return { ...markdown.length > 0 ? { content: markdown } : {}, sources, truncated: false }
  }

  /** The literal key wins; otherwise the key resolves per search. */
  private async resolveKey(signal?: AbortSignal): Promise<string> {
    const resolved = await abortable(this.options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    if (resolved !== undefined && resolved.length > 0) return resolved
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) return this.options.apiKey
    throw new WebError(
      'AnySearch search has no API key; store it through the credentials service'
      + ' (the settings web-search card writes it), or set a literal "apiKey" in the'
      + ' web-search-anysearch config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Race a promise against caller cancellation. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
