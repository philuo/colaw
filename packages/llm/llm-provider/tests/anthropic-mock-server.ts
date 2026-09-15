import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'sse'; frames: Array<{ event: string; data: string }>; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; frames: Array<{ event: string; data: string }> }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textFrames = [
  { event: 'message_start', data: '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}' },
  { event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
  { event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}' },
  { event: 'content_block_stop', data: '{"type":"content_block_stop","index":0}' },
  { event: 'message_delta', data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}' },
  { event: 'message_stop', data: '{"type":"message_stop"}' },
]

/** Local Messages API stand-in: replays scripted behaviors per request. */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        requests.push(body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined)
        headers.push(request.headers)
        const behavior = script.shift()
        if (behavior === undefined) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock server has no scripted behavior left' } }))
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
        const frames = behavior.kind === 'close-early' ? behavior.frames : [...behavior.frames]
        const delayMs = behavior.kind === 'sse' ? behavior.delayMs : undefined
        for (const frame of frames) {
          if (delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, delayMs))
          response.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`)
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
      script,
      close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
    }
  }
  throw new Error('mock server listened on a pipe')
}
