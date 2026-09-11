/**
 * Wire types for the AnySearch MCP endpoint (`POST {endpoint}` with JSON-RPC
 * `tools/call`). Types only — no runtime code. The endpoint is stateless: a
 * single `tools/call` carries the whole exchange, and the search tool answers
 * with one text block of markdown-shaped results.
 *
 * @module @deepseek-ai/dsh-web-search-anysearch/types
 */

/** JSON-RPC 2.0 request envelope for the MCP endpoint. */
export interface McpRequest {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: {
    name: 'search'
    arguments: { query: string; max_results?: number }
  }
}

/** JSON-RPC error envelope (best-effort; fields vary by failure). */
export interface McpError {
  jsonrpc: '2.0'
  id: number | null
  error: { code: number; message: string }
}

/** One content block of a tool answer. AnySearch answers with text only. */
export interface McpContentBlock {
  type: 'text'
  text: string
}

/** JSON-RPC success envelope for `tools/call`. */
export interface McpResponse {
  jsonrpc: '2.0'
  id: number
  result?: {
    content?: McpContentBlock[]
    isError?: boolean
  }
  error?: { code: number; message: string }
}
