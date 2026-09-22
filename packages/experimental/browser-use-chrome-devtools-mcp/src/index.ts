/** Chromium inspection and automation through the pinned Chrome DevTools MCP server. @module */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

/** Cordis identity for the Chrome DevTools MCP browser provider. */
export const name = 'experimental-browser-use-chrome-devtools-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'settings']

/**
 * The namespace the 电脑操控 tab registers, duplicated as a literal because
 * this provider resolves on the Host side, where a cross-package source import
 * is unsafe under project references. The tab's `desktop-settings.ts` owns the
 * spelling; a mismatch fails closed — the provider stays inert — which is the
 * safe direction for a gated surface.
 */
const DESKTOP_SETTINGS_NAMESPACE = 'ui-desktop-control'

/** The one settings face this provider reads: a registered section by name. */
interface DesktopSettingsReader {
  get(namespace: string): { browserUse?: boolean } | undefined
}

/** Fixed Chromium launch or existing-browser attachment settings. */
export type Config = BrowserMcpConfig

/** Validate the launch or attachment configuration before activation. */
export const Config: typeof BrowserMcpConfig = BrowserMcpConfig

/**
 * Expose Chrome DevTools' upstream catalog through one MCP process per live Session.
 * Attached browsers remain externally owned; the server disables usage statistics.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  validateBrowserMcpConfig(config)
  // The 电脑操控 tab owns the gate: with Browser_use off this provider mounts
  // inertly — no MCP server for any Session, no browser, no tools.
  //
  // The read belongs here, in `apply`, and deliberately not in the profile
  // row's `disabled` expression: `EntryGroup.update` creates the row's
  // siblings through one `Promise.all`, so a `disabled` expression is
  // evaluated before the tab's own `apply` can register the namespace, and the
  // row would fail closed for the whole process. `inject` is what orders them
  // — it holds this `apply` until the `settings` service exists, by which time
  // the tab (which needs nothing but `settings`) has registered.
  const settings = ctx.get('settings') as unknown as DesktopSettingsReader | undefined
  if (settings?.get(DESKTOP_SETTINGS_NAMESPACE)?.browserUse !== true) return
  const cli = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
  const args = [cli, '--no-usage-statistics']
  if (config.mode === 'attach') {
    args.push(/^wss?:/u.test(config.endpoint) ? '--ws-endpoint' : '--browser-url', config.endpoint)
  } else {
    args.push('--isolated', `--headless=${String(config.headless)}`)
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  mountSessionMcp(ctx, {
    name: 'chrome-devtools-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
