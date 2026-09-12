import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnySearchProvider, parseAnySearchAnswer } from '../src/provider.ts'

afterEach(() => { vi.unstubAllGlobals() })

const ANSWER = [
  '## Search Results (2 results, 1726ms)',
  '',
  '### 1. OpenAI News',
  '- **URL**: https://openai.com/news/',
  '- Stay up to speed on the rapid advancement of AI technology.',
  '',
  '### 2. OpenAI - WSJ Spotlight Coverage, Recent News',
  '- **URL**: https://www.wsj.com/topics/subject/openai',
  '- OpenAI Is the Sole Investor in Its Latest Venture Fund.',
].join('\n')

describe('parseAnySearchAnswer', () => {
  it('parses the tool answer into citeable entries', () => {
    expect(parseAnySearchAnswer(ANSWER)).toEqual([
      {
        url: 'https://openai.com/news/',
        title: 'OpenAI News',
        snippet: '- Stay up to speed on the rapid advancement of AI technology.',
      },
      {
        url: 'https://www.wsj.com/topics/subject/openai',
        title: 'OpenAI - WSJ Spotlight Coverage, Recent News',
        snippet: '- OpenAI Is the Sole Investor in Its Latest Venture Fund.',
      },
    ])
  })

  it('drops sections without a URL instead of inventing one', () => {
    expect(parseAnySearchAnswer('## Search Results\n\n### 1. No link here\n- just text')).toEqual([])
  })
})

describe('AnySearchProvider', () => {
  it('calls the MCP search tool with the query and maps the answer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: ANSWER }] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AnySearchProvider({ endpoint: 'https://api.anysearch.com/mcp', apiKey: 'as_key' })
    expect(provider.available()).toBe(true)

    const result = await provider.search({ query: 'OpenAI latest news', maxResults: 2 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anysearch.com/mcp')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer as_key')
    // The provider always sends a JSON string body: `String(body)` on the
    // BodyInit union would stringify anything else as "[object Object]".
    const body = init.body
    if (typeof body !== 'string') throw new TypeError(`expected a string request body, got ${typeof body}`)
    expect(JSON.parse(body)).toMatchObject({
      jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'search', arguments: { query: 'OpenAI latest news', max_results: 2 } },
    })
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]?.url).toBe('https://openai.com/news/')
    expect(result.content).toContain('## Search Results')
    expect(result.truncated).toBe(false)
  })

  it('resolves the key per search when no literal key is configured', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: ANSWER }] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AnySearchProvider({
      endpoint: 'https://api.anysearch.com/mcp',
      resolveApiKey: () => Promise.resolve('as_from-credentials'),
    })
    await provider.search({ query: 'x' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer as_from-credentials')
  })

  it('is unavailable when the endpoint is not a URL', () => {
    const provider = new AnySearchProvider({ endpoint: 'not a url' })
    expect(provider.available()).toBe(false)
  })
})
