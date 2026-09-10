/**
 * Electrobun (Bun runtime) desktop host for deepseek-harness.
 *
 * Boots the dsh web profile directly in the Bun main process (no Node.js,
 * no Electron). dsh's own webserver serves the frontend + JSON-RPC API on
 * TCP loopback; an Electrobun BrowserWindow loads the authenticated URL.
 *
 * @module @deepseek-ai/dsh-electrobun-host
 */

import { BrowserView, BrowserWindow } from 'electrobun/bun'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  loadLayeredEnv,
  loadProfile,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const ELECTROBUN_PATCH = fileURLToPath(new URL('../config/electrobun.cordis.patch.yml', import.meta.url))
const ROOT_CONFIG = '# Electrobun desktop composition root.\n[]\n'
const ROOT_CONFIG_FILENAME = 'electrobun.cordis.yml'

/** Structural subset of the webserver's index-injection rows (no type dependency on it). */
interface DesktopInjectionRow {
  kind: 'global' | 'script' | 'script-src' | 'script-preload' | 'style' | 'html'
  name?: string
  value?: unknown
}

/**
 * Boot dsh core and open the Electrobun window.
 */
async function main(): Promise<void> {
  // Use a dedicated directory as the dsh project/profile root
  const projectDir = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh'), 'profiles', 'electrobun')
  mkdirSync(projectDir, { recursive: true })
  const rootConfig = join(projectDir, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)

  console.log('[electrobun-host] Booting dsh core (web profile)...')
  const environment = loadLayeredEnv('dsh electrobun')
  // Use dsh repo's apps/cli as install anchor so that bundle packages
  // (dsh-base, dsh-web-app) can be resolved from its node_modules.
  // The globally cached @deepseek-ai/dsh package has no node_modules.
  const dshRepoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
  const cliPackageJson = join(dshRepoRoot, 'apps', 'cli', 'package.json')
  const profile = loadProfile('dsh electrobun', 'web', cliPackageJson)

  // Compose patch layers: bundle layers → profile layer → electrobun overlay
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOverlayPatches('dsh electrobun', ELECTROBUN_PATCH),
  ]

  let current: Context | undefined
  const ctx = await boot(
    'dsh electrobun',
    rootConfig,
    structuredClone(patches),
    (hostCtx) => {
      current = hostCtx
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(hostCtx, { args: [], exit: () => {} })
    },
  )
  current = ctx

  // Verify required services
  const webServer = ctx.get('webServer') as { port: number; host: string } | undefined
  const connection = ctx.get('connection') as { authenticatedUrl: (url: string) => string } | undefined
  if (webServer === undefined || connection === undefined) {
    await ctx.fiber.dispose()
    throw new Error('dsh electrobun: webServer or connection service unavailable after boot')
  }

  console.log(`[electrobun-host] dsh core booted, webserver on port ${webServer.port}`)

  // Build the authenticated URL (dsh web requires a token for all requests).
  const baseUrl = `http://127.0.0.1:${webServer.port}`
  const appUrl = connection.authenticatedUrl(baseUrl)
  console.log(`[electrobun-host] App URL: ${appUrl}`)

  // Announce the desktop chrome to the client shell. The index URL cannot carry
  // it (browser-auth normalizes the query away), so the host contributes an
  // index-injected global the shell reads before first paint.
  ctx.on('webserver/index-inject', (table: DesktopInjectionRow[]) => {
    table.push({
      kind: 'global',
      name: '__DSH_DESKTOP__',
      value: { chrome: 'darwin', titlebarInset: 32 },
    })
  })

  // Create Electrobun window and load the dsh frontend.
  // hiddenInset: transparent title bar with inset native traffic lights, so the
  // web content owns the full window height (the sidebar runs to the top). The
  // y offset already centres the lights on the shell's 40px unified top bar
  // (ui-layout AppFrame TOPBAR_HEIGHT).
  const mainWindow = new BrowserWindow({
    title: 'Colaw',
    url: appUrl,
    titleBarStyle: 'hiddenInset',
    trafficLightOffset: { x: 6, y: 7 },
    frame: {
      width: 1400,
      height: 900,
      x: 100,
      y: 100,
    },
  })

  console.log('[electrobun-host] Window created, loading dsh frontend...')

  // macOS fullscreen hides the traffic lights, so the shell's title-bar
  // controls re-anchor. The native window is the only authority — a maximized
  // window covers the screen but is NOT fullscreen — so push its state into the
  // page on every geometry change instead of guessing from the viewport size.
  const syncFullscreen = (): void => {
    const view = BrowserView.getById(mainWindow.webviewId)
    if (view === undefined) return
    const full = mainWindow.isFullScreen()
    view.executeJavascript(
      `window.__DSH_DESKTOP_FULLSCREEN__=${full ? 'true' : 'false'};`
      + "window.dispatchEvent(new Event('dsh:desktop-fullscreen'))",
    )
  }
  mainWindow.on('resize', syncFullscreen)
  mainWindow.on('move', syncFullscreen)

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[electrobun-host] Shutting down...')
    await current?.fiber.dispose()
    current = undefined
    console.log('[electrobun-host] Shutdown complete')
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((error) => {
  console.error('[electrobun-host] Fatal error:', error)
  process.exit(1)
})
