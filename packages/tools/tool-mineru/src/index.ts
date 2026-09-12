/**
 * Model-facing document parsing tool backed by the MinerU cloud API
 * (https://mineru.net — Bearer-token 精准解析 flow).
 *
 * One tool: `mineru_parse_document`. A workspace file (scanned or native PDF,
 * image, or Office document) uploads through MinerU's presigned-URL batch
 * flow, the parse is polled to completion, and the extracted `full.md` from
 * the result bundle is written beside the source as `<name>.mineru.md` so the
 * agent's ordinary file tools can read it. The token is product configuration
 * (the composition row), never an environment read.
 *
 * @module @deepseek-ai/dsh-tool-mineru
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-mineru'
/** Service required to publish the tool. */
export const inject = ['tools']

/** Plugin configuration: the MinerU API token (创建于 mineru.net API 管理页). */
export interface Config {
  token: string
}

export const Config: z<Config> = z.object({
  token: z.string().required(),
})

const MINERU_BASE = 'https://mineru.net'
const BATCH_UPLOAD_ENDPOINT = '/api/v4/file-urls/batch'
const BATCH_RESULT_ENDPOINT = '/api/v4/extract-results/batch'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 10 * 60_000
const MAX_FILE_BYTES = 200 * 1024 * 1024
const EXCERPT_CHARS = 1_500

interface MineruBatchResponse {
  readonly code: number
  readonly msg: string
  readonly data?: {
    readonly batch_id?: string
    readonly file_urls?: readonly string[]
  }
}

interface MineruBatchResult {
  readonly code: number
  readonly msg: string
  readonly data?: {
    readonly extract_result?: readonly {
      readonly file_name?: string
      readonly state?: string
      readonly err_msg?: string
      readonly full_zip_url?: string
    }[]
  }
}

/** One headers object for the JSON API calls. */
function apiHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/** One JSON fetch that asserts the MinerU envelope (`code === 0`). */
async function mineruJson<T>(url: string, token: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...apiHeaders(token), ...init.headers } })
  if (!response.ok) {
    throw new Error(`MinerU API HTTP ${String(response.status)}: ${(await response.text()).slice(0, 300)}`)
  }
  const body = await response.json() as T & { code?: number; msg?: string }
  if (body.code !== 0) throw new Error(`MinerU API error ${String(body.code)}: ${body.msg ?? 'unknown'}`)
  return body
}

/** Sleep one poll interval, aborting with the tool signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(resolveSleep, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      rejectSleep(new Error('MinerU parse aborted'))
    }, { once: true })
  })
}

/** Extract `full.md` (any single leading directory) from the result bundle. */
function extractMarkdown(zip: Uint8Array): string {
  const entries = unzipSync(zip)
  const name = Object.keys(entries).find(entry => entry === 'full.md' || entry.endsWith('/full.md'))
  if (name === undefined) {
    throw new Error(`MinerU result bundle has no full.md (entries: ${Object.keys(entries).slice(0, 8).join(', ')})`)
  }
  return new TextDecoder().decode(entries[name])
}

/**
 * Register the MinerU parsing tool.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the product-issued MinerU API token.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mineru_parse_document',
    description: 'Parse a document file (PDF including scans, images, or Office documents) into Markdown with the MinerU cloud service. '
      + 'Use when the user asks to extract, OCR, or convert a document\u0027s text/layout into Markdown, or when a PDF\u0027s text layer is unusable. '
      + 'The parsed Markdown is written next to the source as `<name>.mineru.md`.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative (or absolute) path of the document to parse.' },
      is_ocr: { type: 'boolean', description: 'Force OCR. Defaults to the service\u0027s automatic detection.' },
      language: { type: 'string', description: 'Document language hint, e.g. "ch" (Chinese) or "en" (English).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          excerpt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `MinerU 解析完成，Markdown 已写入 ${value.outputPath}\n\n---\n${value.excerpt}`,
      }],
    },
    timeoutMs: POLL_TIMEOUT_MS + 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const absolute = isAbsolute(args.path) ? args.path : resolve(cwd, args.path)
      const data = await readFile(absolute)
      if (data.byteLength > MAX_FILE_BYTES) {
        throw new Error(`file exceeds MinerU\u0027s ${String(Math.round(MAX_FILE_BYTES / 1024 / 1024))}MB limit: ${args.path}`)
      }
      // 1. Reserve presigned upload URLs (one file → one URL).
      const reserve = await mineruJson<MineruBatchResponse>(
        `${MINERU_BASE}${BATCH_UPLOAD_ENDPOINT}`,
        config.token,
        {
          method: 'POST',
          body: JSON.stringify({
            enable_formula: true,
            enable_table: true,
            ...args.language === undefined ? {} : { language: args.language },
            files: [{
              name: basename(args.path),
              is_ocr: args.is_ocr ?? false,
              data_id: 'mineru-parse',
            }],
          }),
        },
      )
      const uploadUrl = reserve.data?.file_urls?.[0]
      const batchId = reserve.data?.batch_id
      if (uploadUrl === undefined || batchId === undefined) {
        throw new Error('MinerU API returned no upload URL for the file')
      }

      // 2. Upload the raw bytes to the presigned URL (no auth header on purpose).
      const uploaded = await fetch(uploadUrl, {
        method: 'PUT',
        body: data,
        signal: exec.signal,
      })
      if (!uploaded.ok) {
        throw new Error(`MinerU upload failed: HTTP ${String(uploaded.status)}`)
      }

      // 3. Poll the batch result until the single file completes.
      const deadline = Date.now() + POLL_TIMEOUT_MS
      let zipUrl: string | undefined
      while (Date.now() < deadline) {
        if (exec.signal.aborted) throw new Error('MinerU parse aborted')
        const result = await mineruJson<MineruBatchResult>(
          `${MINERU_BASE}${BATCH_RESULT_ENDPOINT}/${encodeURIComponent(batchId)}`,
          config.token,
          { method: 'GET' },
        )
        const entry = result.data?.extract_result?.[0]
        if (entry?.state === 'done' && entry.full_zip_url !== undefined) {
          zipUrl = entry.full_zip_url
          break
        }
        if (entry?.state === 'failed') {
          throw new Error(`MinerU parse failed: ${entry.err_msg ?? 'unknown error'}`)
        }
        await sleep(POLL_INTERVAL_MS, exec.signal)
      }
      if (zipUrl === undefined) throw new Error('MinerU parse timed out')

      // 4. Download the bundle and lift full.md into the workspace.
      const bundle = await fetch(zipUrl, { signal: exec.signal })
      if (!bundle.ok) throw new Error(`MinerU result download failed: HTTP ${String(bundle.status)}`)
      const markdown = extractMarkdown(new Uint8Array(await bundle.arrayBuffer()))
      const outputPath = `${absolute}.mineru.md`
      await writeFile(outputPath, markdown, 'utf8')
      return {
        outputPath: outputPath.startsWith(cwd) ? outputPath.slice(cwd.length + 1) : outputPath,
        excerpt: markdown.slice(0, EXCERPT_CHARS),
      }
    },
  })), 'tool-mineru.register()')
}
