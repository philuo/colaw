import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'sse'; events: string[]; delayMs?: number }
  /** Frames written verbatim (no implicit `[DONE]`): the Responses wire. */
  | { kind: 'raw-sse'; frames: string[] }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: string[] }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  /** Request URLs (path + query) received, in order. */
  paths: string[]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
  '{"choices":[{"delta":{"content":"hello"}}]}',
  '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Local chat-completions stand-in: replays scripted behaviors per request. */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        requests.push(body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined)
        headers.push(request.headers)
        paths.push(request.url ?? '')
        const behavior = script.shift()
        if (behavior === undefined) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'mock server has no scripted behavior left' } }))
          return
        }
        if (behavior.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delayMs = behavior.kind === 'sse' ? behavior.delayMs : undefined
        if (behavior.kind === 'raw-sse') {
          for (const frame of behavior.frames) response.write(frame)
          response.end()
          return
        }
        const events = behavior.kind === 'close-early' ? behavior.events : [...behavior.events, '[DONE]']
        for (const event of events) {
          if (delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, delayMs))
          response.write(`data: ${event}\n\n`)
        }
        if (behavior.kind === 'close-early') response.destroy()
        response.end()
      })()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'object') {
    return {
      url: `http://127.0.0.1:${(address as { port: number }).port}`,
      requests,
      headers,
      paths,
      script,
      close: () => new Promise(resolve => server.close(() => resolve())),
    }
  }
  throw new Error('mock server listened on a pipe')
}
