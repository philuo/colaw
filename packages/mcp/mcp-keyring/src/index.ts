/**
 * Mount built-in remote MCP servers with keys from the credentials store.
 *
 * `dsh-mcp-client` takes its bearer headers as static composition config, so
 * a server key must never be written into a composition file. This row owns
 * the product's built-in services instead: it names each server's endpoint
 * and the credential reference its key lives under, resolves the reference
 * through the credentials store at startup, and mounts one mcp-client
 * instance per server with the resolved `Authorization` header. A missing
 * key still mounts the server — the tools appear and fail at call time with
 * the provider's own 401 — so entering a key in Settings can never be a
 * boot-blocking event. Re-entered keys apply on the next app start (the
 * mount-time header is static by transport design); MinerU's per-call tool
 * picks its key up live.
 *
 * @module @deepseek-ai/dsh-mcp-keyring
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name. */
export const name = 'mcp-keyring'

/** The credentials store the server keys resolve through. */
export const inject = ['credentials']

/** One built-in remote MCP server. The endpoint is public knowledge; the key never is. */
export interface KeyringServer {
  /** Stable namespace for tool names (`mcp__<serverName>__<tool>`). */
  serverName: string
  /** MCP streamable-HTTP endpoint. */
  url: string
  /** Credential reference the bearer token resolves from (e.g. `PKULAW_API_KEY`). */
  credentialRef: string
}

/** Plugin configuration: the built-in servers this deployment ships. */
export interface Config {
  servers: KeyringServer[]
  /** Per-tool-call timeout forwarded to every mounted server (default 180s). */
  toolCallTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  servers: z.array(z.object({
    serverName: z.string().required(),
    url: z.string().required(),
    credentialRef: z.string().required(),
  })),
  toolCallTimeoutMs: z.number().default(180_000),
})

/**
 * Mount one mcp-client instance per configured server.
 * @param ctx - plugin context carrying the credentials store.
 * @param config - the built-in server list.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const server of config.servers) {
    const resolved = await ctx.credentials.resolve(refOf(server.credentialRef)).catch(() => undefined)
    ctx.plugin(mcpClient, {
      serverName: server.serverName,
      transport: 'streamable-http',
      url: server.url,
      headers: resolved === undefined ? {} : { Authorization: `Bearer ${resolved.value}` },
      toolCallTimeoutMs: config.toolCallTimeoutMs ?? 180_000,
      failOnStartupError: false,
    })
  }
}

/** Brand the string into a CredentialRef; the brand is compile-time only. */
function refOf(ref: string): Parameters<Context['credentials']['resolve']>[0] {
  return ref as Parameters<Context['credentials']['resolve']>[0]
}
