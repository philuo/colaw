/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. Paths and MIME types do not restrict access;
 * the connection service authenticates requests before this handler.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/** Per-request window for open-ended media ranges; players follow up with more ranges. */
const RANGE_WINDOW_BYTES = 4 * 1024 * 1024

/** Parse one `Range: bytes=…` header into an inclusive [start, end] pair. */
function parseByteRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (header === null) return undefined
  // Suffix form: the last N bytes (players read the container tail this way).
  const suffix = /^bytes=-(\d+)$/.exec(header.trim())
  if (suffix !== null) {
    const tail = Number(suffix[1])
    if (tail === 0 || size === 0) return undefined
    const start = Math.max(0, size - tail)
    return { start, end: size - 1 }
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const start = Number(match[1])
  const end = match[2] === '' ? undefined : Number(match[2])
  if (start >= size) return undefined
  return {
    start,
    end: end === undefined ? size - 1 : Math.min(end, size - 1),
  }
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
      // Media players (<video>/<audio>) advertise and probe this before playing.
      'Accept-Ranges': 'bytes',
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const info = await fs.stat(target, request.signal).catch(() => undefined)
    const size = info?.type === 'file' ? info.size : undefined
    const range = parseByteRange(request.headers.get('range'), size ?? Number.MAX_SAFE_INTEGER)
    if (range !== undefined && range !== 'invalid' && size !== undefined) {
      // Bounded window: an open-ended range returns the first window and lets
      // the player follow up, so one seek never buffers the whole media file.
      const end = Math.min(range.end, range.start + RANGE_WINDOW_BYTES - 1)
      const bytes = await fs.readByteRange(target, { offset: range.start, length: end - range.start + 1 }, request.signal)
      return new Response(bytes.slice(), {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': String(bytes.byteLength),
          'Content-Range': `bytes ${String(range.start)}-${String(range.start + bytes.byteLength - 1)}/${String(size)}`,
        },
      })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
  },
}
