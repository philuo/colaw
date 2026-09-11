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
import { electrobunEventEmitter, type ElectrobunEvent } from 'electrobun/bun/events'
import { installApplicationMenu, onApplicationMenuClicked, type MenuLocale } from './menu.ts'
import {
  setAppearance, setApplicationIcon, systemIsDark, type AppearancePreference,
} from './app-appearance.ts'
import { dshHomePath, migrateLegacyDshHome } from '@deepseek-ai/dsh-home-paths'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadProfile,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

/**
 * The packaged bundle's `Resources/app` dir, when the process runs from one:
 * it carries the overlay patch (config/) and, in self-contained stable
 * installs, the installation closure (install/). Derived from the executable
 * so a moved .app still resolves; source runs have none (undefined).
 */
const BUNDLED_APP_DIR = (() => {
  const candidate = join(dirname(dirname(process.execPath)), 'Resources', 'app')
  return existsSync(join(candidate, 'config', 'electrobun.cordis.patch.yml')) ? candidate : undefined
})()

/**
 * Dev installs resolve the overlay patch from the repository (source of truth
 * while iterating); stable installs read the copy packaged beside the bundle,
 * so the app never depends on the build machine's checkout.
 */
const ELECTROBUN_PATCH = process.env.ELECTROBUN_INSTALL_ROOT_NAME === 'dev'
  ? fileURLToPath(new URL('../config/electrobun.cordis.patch.yml', import.meta.url))
  : BUNDLED_APP_DIR !== undefined && existsSync(join(BUNDLED_APP_DIR, 'config', 'electrobun.cordis.patch.yml'))
    ? join(BUNDLED_APP_DIR, 'config', 'electrobun.cordis.patch.yml')
    : fileURLToPath(new URL('../config/electrobun.cordis.patch.yml', import.meta.url))

const ROOT_CONFIG = '# Electrobun desktop composition root.\n[]\n'
const ROOT_CONFIG_FILENAME = 'electrobun.cordis.yml'

/** File the window frame is remembered in, beside the profile's composition root. */
const WINDOW_STATE_FILENAME = 'window-state.json'

/** Where the window first appears when nothing was remembered. */
const DEFAULT_WINDOW_FRAME = { x: 100, y: 100, width: 1400, height: 900 } as const

/** Frames written while dragging or resizing are coalesced onto this cadence. */
const WINDOW_STATE_WRITE_MS = 400

/** The windowed frame, as persisted between launches. */
interface WindowFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Read the frame the previous launch left behind.
 * @param path - state file to read.
 * @returns the stored frame, or undefined on a first launch or an unreadable file.
 */
function readWindowFrame(path: string): WindowFrame | undefined {
  try {
    const { x, y, width, height } = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowFrame>
    if (typeof x !== 'number' || typeof y !== 'number'
      || typeof width !== 'number' || typeof height !== 'number') return undefined
    return { x, y, width, height }
  } catch {
    // Absent, truncated, or not JSON: a fresh window is the only safe reading.
    return undefined
  }
}

/**
 * Remember a frame for the next launch.
 * @param path - state file to write.
 * @param frame - the windowed frame to store.
 */
function writeWindowFrame(path: string, frame: WindowFrame): void {
  try {
    writeFileSync(path, `${JSON.stringify(frame)}\n`)
  } catch {
    // A frame that cannot be persisted must never take the window down with it.
  }
}

/** Commands the window's own shell sends back through the host. */
const desktopCommands = new Map<string, () => void>()

/** The one capability the host keeps on the dev watcher: stop it at shutdown. */
interface DevWatcher {
  kill: () => void
}

/** The running client-bundle watcher, when this instance started one. */
let devWatcher: DevWatcher | undefined

/**
 * Locate the repository the app was built from. The two runtime shapes sit
 * somewhere below it — a bundled run inside the .app, a source run inside the
 * source tree — and the watcher script exists exactly once, at its root, so
 * walking up from both starts until it appears is the one answer that holds
 * for both.
 * @returns the repository root, or undefined when neither start reaches it.
 */
function findRepoRoot(): string | undefined {
  const starts = [process.cwd(), fileURLToPath(new URL('.', import.meta.url))]
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      if (existsSync(join(dir, 'scripts', 'dev-web.ts'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/**
 * Dev builds only: keep the client-bundle watcher (`scripts/dev-web.ts`) running
 * beside the app, so editing any browser plugin's source reaches the running
 * view through the client-hmr chain without repackaging or restart. The
 * watcher's own child stages (tsc, pnpm) need the developer's PATH, which a
 * GUI-launched process does not carry, so it is spawned through the login
 * shell; the watcher itself runs under this app's Bun, addressed by absolute
 * path. `DSH_DEV_WATCH=0` turns the watcher off.
 *
 * @returns resolves once the watcher's initial build pass has finished (its
 * "watching" banner), so the window's first page load reads settled artifacts
 * instead of racing half-written ones — or when the wait gives up.
 */
function startDevWatcher(): Promise<void> {
  if (process.env.ELECTROBUN_INSTALL_ROOT_NAME !== 'dev' || process.env.DSH_DEV_WATCH === '0') return Promise.resolve()
  const repoRoot = findRepoRoot()
  if (repoRoot === undefined) {
    console.error('[electrobun-host] dev-web watcher not started: repository root not found')
    return Promise.resolve()
  }
  const script = join(repoRoot, 'scripts', 'dev-web.ts')
  const child = Bun.spawn({
    // --poll=250: source saves are noticed within a quarter second, which —
    // with the 100ms client-hmr poll on the far side — keeps the perceived
    // save-to-view latency well under half a second.
    cmd: ['/bin/zsh', '-lc', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} --poll=250`],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      // The watcher's own orphan check: a GUI quit may bypass this process's
      // SIGTERM path entirely, so the watcher watches this pid itself.
      DSH_SUPERVISOR_PID: String(process.pid),
    },
  })
  devWatcher = child
  console.log(`[electrobun-host] dev-web watcher started (pid ${String(child.pid)}, repo ${repoRoot})`)
  void child.exited.then((code) => {
    if (code === 0 || devWatcher !== child) return
    console.error(`[electrobun-host] dev-web watcher exited (code ${String(code)}); client edits no longer reach the running view`)
  })
  // The banner is the watcher's own "initial builds done" statement; decoding
  // and forwarding the stream keeps the build log on the host's stdout.
  const WATCHER_READY_TIMEOUT_MS = 120_000
  const banner = 'dev-web: watching'
  return new Promise((resolvePromise) => {
    const decoder = new TextDecoder()
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise()
    }
    const timeout = setTimeout(() => {
      if (settled) return
      console.error('[electrobun-host] dev-web watcher initial build timed out; loading the window anyway')
      settle()
    }, WATCHER_READY_TIMEOUT_MS)
    const pump = async (): Promise<void> => {
      for await (const chunk of child.stdout as unknown as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true })
        process.stdout.write(text)
        if (text.includes(banner)) settle()
      }
      settle()
    }
    void pump()
  })
}

/** Stop the dev watcher; its own stages tear down on the parent's SIGTERM. */
function stopDevWatcher(): void {
  devWatcher?.kill()
  devWatcher = undefined
}

/**
 * Run one command the shell sent from the window.
 *
 * The page has no way to call into the host: the only channel it is given is the
 * preload's `__electrobunSendToHost`, and that emits a *webview event* rather
 * than an RPC message — the SDK's internal bridge dispatches only its own
 * handlers (window moves, webview tags). A command therefore arrives as the
 * payload of a `host-message` event, which is this listener's whole job.
 */
function runWindowCommand(event: ElectrobunEvent<{ detail: unknown }, unknown>): void {
  const command = event.data.detail as { id?: unknown } | null
  if (typeof command?.id !== 'string') return
  desktopCommands.get(command.id)?.()
}

/** Custom event the menu handler fires in the window so the shell runs a command. */
const DESKTOP_COMMAND_EVENT = 'dsh:desktop-command'

/** Namespaces the shell keeps its own preferences in. */
const THEME_NAMESPACE = 'ui-theme'
const LOCALE_NAMESPACE = 'locale'

/** The shell's durable preferences as the native chrome needs them. */
interface ShellPreferences {
  /** Language the application menu is written in. */
  locale: MenuLocale
  /** Appearance selection: an explicit one, or the system's. */
  appearance: AppearancePreference
}

/**
 * Native menu language for a locale selection, or the system's when the shell
 * has none — an unset preference is the browser's to decide, and the browser
 * resolves it from the system.
 */
function menuLocale(preference: unknown): MenuLocale {
  if (preference === 'zh' || preference === 'en') return preference
  const system = new Intl.DateTimeFormat().resolvedOptions().locale
  return system.startsWith('zh') ? 'zh' : 'en'
}

/**
 * Read the shell's preferences from dsh's own settings document.
 *
 * Read structurally rather than through the client packages' types: those
 * schemas belong to the browser scope, and a section the profile has never
 * written is simply absent.
 * @param ctx - Booted dsh context, whose `settings` service holds the document.
 */
function readShellPreferences(ctx: Context): ShellPreferences {
  const settings = ctx.get('settings') as { get: (namespace: string) => unknown } | undefined
  const theme = settings?.get(THEME_NAMESPACE) as { preference?: unknown } | undefined
  const locale = settings?.get(LOCALE_NAMESPACE) as { preference?: unknown } | undefined
  const selection = theme?.preference
  return {
    locale: menuLocale(locale?.preference),
    appearance: selection === 'light' || selection === 'dark' ? selection : 'system',
  }
}

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
  migrateLegacyDshHome()
  const projectDir = dshHomePath('profiles', 'electrobun')
  mkdirSync(projectDir, { recursive: true })
  const rootConfig = join(projectDir, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)

  console.log('[electrobun-host] Booting dsh core (web profile)...')
  const environment = loadLayeredEnv('colaw')
  // Use dsh repo's apps/cli as install anchor so that bundle packages
  // (dsh-base, dsh-web-app) can be resolved from its node_modules.
  // The globally cached @deepseek-ai/dsh package has no node_modules.
  const dshRepoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
  // Dev builds start the client-bundle watcher and let its initial pass finish
  // before the window loads, so the first page reads settled artifacts instead
  // of racing a half-written dist.
  await startDevWatcher()
  // Self-contained stable installs anchor the whole profile at the in-app
  // closure (packaged by scripts/pack-stable-app.ts); dev and source runs
  // resolve through the repository checkout.
  const bundledAnchor = BUNDLED_APP_DIR === undefined ? undefined : join(BUNDLED_APP_DIR, 'install', 'package.json')
  const cliPackageJson = bundledAnchor !== undefined && existsSync(bundledAnchor)
    ? bundledAnchor
    : join(dshRepoRoot, 'apps', 'cli', 'package.json')
  console.log(`[electrobun-host] install anchor: ${cliPackageJson}`)
  const profile = loadProfile('colaw', 'web', cliPackageJson)
  // Self-contained stable installs own their module fallback: client-modules
  // resolves browser plugin packages by name from the loader tree base (the
  // profile directory), whose node_modules walk must reach the in-app closure.
  // Dev and source runs leave the fallback to the repository checkout's own
  // resolution plane.
  if (cliPackageJson === bundledAnchor) {
    await healProfilesModuleFallback({ installAnchor: cliPackageJson, profile })
  }

  // Compose patch layers: bundle layers → profile layer → electrobun overlay
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOverlayPatches('colaw', ELECTROBUN_PATCH),
  ]

  let current: Context | undefined
  const ctx = await boot(
    'colaw',
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

  /** The color scheme the page should paint: an explicit selection is itself,
   * `system` is what macOS is set to right now — read from the system
   * preference, not from this app's pinned effective appearance. */
  const pageAppearanceFor = (appearance: AppearancePreference): 'light' | 'dark' =>
    appearance === 'system' ? (systemIsDark() ? 'dark' : 'light') : appearance

  // Announce the desktop chrome to the client shell. The index URL cannot carry
  // it (browser-auth normalizes the query away), so the host contributes an
  // index-injected global the shell reads before first paint. The resolved
  // color scheme rides along: the webview's `prefers-color-scheme` reports the
  // app-level appearance frozen at launch (re-setting it under live views
  // crashes the process), so a `system` theme preference must not follow the
  // media query in this shell — it follows this host-owned value instead.
  ctx.on('webserver/index-inject', (table: DesktopInjectionRow[]) => {
    table.push({
      kind: 'global',
      name: '__DSH_DESKTOP__',
      value: { chrome: 'darwin', titlebarInset: 32 },
    })
    table.push({
      kind: 'global',
      name: '__DSH_DESKTOP_APPEARANCE__',
      value: pageAppearanceFor(readShellPreferences(ctx).appearance),
    })
  })

  // Create Electrobun window and load the dsh frontend.
  // hiddenInset: transparent title bar with inset native traffic lights, so the
  // web content owns the full window height (the sidebar runs to the top). The
  // y offset already centres the lights on the shell's 40px unified top bar
  // (ui-layout AppFrame TOPBAR_HEIGHT).
  // Restore where the user left the window; a first launch gets the default
  // frame. Passing x/y at all is what pins the window instead of letting the
  // system choose a spot.
  // Bind the native chrome to the saved preferences *before* the window exists.
  //
  // The appearance has to be settled here and nowhere else: AppKit propagates a
  // new one into every view it has, and the webview's view raises an Objective-C
  // exception when it takes one at runtime — an exception that cannot unwind
  // through an FFI call, so it aborts the process (a theme toggle used to kill
  // the app). With no views to walk yet, the same call is safe, and doing it
  // before the first frame means the saved theme is simply there: no flash of
  // the system's appearance, and no icon swap in view.
  const shellPreferences = readShellPreferences(ctx)
  setAppearance(shellPreferences.appearance)

  /** The icon for a preference follows the same resolution as the page
   * appearance: the Dock shows what the current selection asks for. */
  const iconFor = pageAppearanceFor
  const iconPaths: Record<'light' | 'dark', string> = {
    light: fileURLToPath(new URL('../../AppIcon.icns', import.meta.url)),
    dark: fileURLToPath(new URL('../cat5_dark.icns', import.meta.url)),
  }
  let iconInUse: 'light' | 'dark' | undefined
  /** Show the icon the current selection asks for; a matching one is a no-op. */
  const followAppearance = (appearance: AppearancePreference): void => {
    const wanted = iconFor(appearance)
    if (wanted === iconInUse) return
    iconInUse = wanted
    setApplicationIcon(iconPaths[wanted])
  }
  followAppearance(shellPreferences.appearance)

  const windowStatePath = join(projectDir, WINDOW_STATE_FILENAME)
  const rememberedFrame = readWindowFrame(windowStatePath) ?? DEFAULT_WINDOW_FRAME
  const mainWindow = new BrowserWindow({
    title: 'Colaw',
    url: appUrl,
    titleBarStyle: 'hiddenInset',
    trafficLightOffset: { x: 6, y: 7 },
    frame: {
      x: rememberedFrame.x,
      y: rememberedFrame.y,
      width: rememberedFrame.width,
      height: rememberedFrame.height,
    },
  })

  console.log('[electrobun-host] Window created, loading dsh frontend...')
  console.log(`[electrobun-host] Window frame: ${JSON.stringify(mainWindow.getFrame())}`)
  console.log(`[electrobun-host] Window state file: ${windowStatePath}`)

  // A menu command reaches the shell as a window event: the key equivalent is
  // answered by the native menu, so the panel itself never sees the keydown.
  const dispatchCommand = (command: string): void => {
    const view = BrowserView.getById(mainWindow.webviewId)
    if (view === undefined) return
    view.executeJavascript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_COMMAND_EVENT)},`
      + ` { detail: { command: ${JSON.stringify(command)} } }))`,
    )
  }
  onApplicationMenuClicked(dispatchCommand)

  // The icon keeps following the selection for as long as the app runs — the
  // Dock shows it, and the two ways it moves are a settings write from the UI
  // and, while following the system, macOS switching under us. Only the first
  // announces itself, so a slow tick re-reads the selection and shows whatever
  // it now asks for; the settings event is kept only so a toggle does not have to
  // wait for the tick. (The app-level appearance itself is not re-applied here —
  // see the note where it is set before the window.)
  //
  // The page's color scheme follows the same tick: the webview's media query
  // stays pinned to the launch appearance, so the host pushes the resolved
  // scheme into the page (the index-injected global covers the first paint;
  // this push covers every change after it — a settings write or macOS
  // switching under a `system` preference).
  const NATIVE_CHROME_POLL_MS = 2000
  let appliedPreferences: ShellPreferences | undefined
  let pushedAppearance: 'light' | 'dark' | undefined
  const syncNativeChrome = (): void => {
    const next = readShellPreferences(ctx)
    if (appliedPreferences?.locale !== next.locale) installApplicationMenu(next.locale)
    appliedPreferences = next
    followAppearance(next.appearance)
    const pageAppearance = pageAppearanceFor(next.appearance)
    if (pageAppearance === pushedAppearance) return
    pushedAppearance = pageAppearance
    const view = BrowserView.getById(mainWindow.webviewId)
    if (view === undefined) return
    view.executeJavascript(
      `window.__DSH_DESKTOP_APPEARANCE__=${JSON.stringify(pageAppearance)};`
      + "window.dispatchEvent(new Event('dsh:desktop-appearance'))",
    )
  }
  syncNativeChrome()
  const nativeChromeWatch = setInterval(syncNativeChrome, NATIVE_CHROME_POLL_MS)
  ctx.on('settings/updated', syncNativeChrome)

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

  // Zoom — the green button's behaviour, and what macOS itself runs on a
  // title-bar double-click — is what the shell's own double-click toggles.
  // Full screen stays on the menu's ⌃⌘F (the native `toggleFullScreen` role), so
  // the two states never have to share one gesture. The transition reports
  // intermediate frames, so the frame writer is held off until it settles.
  const ZOOM_SETTLE_MS = 400
  let geometryTransition = false
  const toggleWindowZoom = (): void => {
    geometryTransition = true
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    setTimeout(() => {
      geometryTransition = false
      syncFullscreen()
    }, ZOOM_SETTLE_MS)
  }
  desktopCommands.set('toggle-window-zoom', toggleWindowZoom)
  electrobunEventEmitter.on('host-message', runWindowCommand)

  // Remember the frame the user settles on: a drag moves it, an edge drag sizes
  // it, and the next launch opens where they left it. Writes are coalesced —
  // a drag emits at pointer cadence. A zoomed or fullscreen window reports the
  // screen's frame, which is never the size to restore the user to; the zoom
  // transition reports intermediate frames besides. So what is kept is the last
  // frame that was neither, which also means quitting while zoomed still
  // restores the size the user was working at.
  let settledFrame = mainWindow.getFrame()
  const frameIsSettled = (): boolean =>
    !geometryTransition && !mainWindow.isFullScreen() && !mainWindow.isMaximized()
  let frameWriteTimer: ReturnType<typeof setTimeout> | undefined
  const flushWindowFrame = (): void => {
    clearTimeout(frameWriteTimer)
    frameWriteTimer = undefined
    writeWindowFrame(windowStatePath, settledFrame)
  }
  const rememberWindowFrame = (): void => {
    if (!frameIsSettled()) return
    settledFrame = mainWindow.getFrame()
    clearTimeout(frameWriteTimer)
    frameWriteTimer = setTimeout(flushWindowFrame, WINDOW_STATE_WRITE_MS)
  }
  mainWindow.on('resize', rememberWindowFrame)
  mainWindow.on('move', rememberWindowFrame)

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[electrobun-host] Shutting down...')
    // The last drag may still be inside the write window, and the native-chrome
    // tick would hold the event loop open past it.
    flushWindowFrame()
    clearInterval(nativeChromeWatch)
    stopDevWatcher()
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
