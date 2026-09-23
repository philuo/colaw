/**
 * Computer use through the Cua Driver native SDK, run in a child process.
 *
 * The driver used to load into this process. It no longer does: see
 * `driver-host.ts` for why an in-process driver can abort the whole
 * application and what hosting it in a child buys instead.
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import { openDriverHost } from './driver-host.ts'
import type { DriverHost } from './driver-host.ts'
import type {} from '@deepseek-ai/dsh-computer-use'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DesktopPermissionPane, DesktopPermissionStatus } from './types.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/**
 * The namespace the 电脑操控 tab registers, duplicated as a literal because
 * this provider compiles on the Host side, where a cross-package source import
 * is unsafe under project references. The tab's `desktop-settings.ts` owns the
 * spelling; a mismatch fails closed — the provider stays inert — which is the
 * safe direction for a permission-gated surface.
 */
const DESKTOP_SETTINGS_NAMESPACE = 'ui-desktop-control'

/** The one settings face this provider reads: a registered section by name. */
interface DesktopSettingsReader {
  get(namespace: string): { computerUse?: boolean } | undefined
}

export type { DesktopPermissionStatus } from './types.ts'

/**
 * Load the native driver SDK for one probe, deferring the binding to first use
 * so it stays off every boot path. The require names the package (external in
 * every bundle), never a sibling file a bundler would have to emit.
 * @returns the SDK surface carrying the permission probes.
 */
function nativeProbe(): typeof import('@trycua/cua-driver') {
  // oxlint-disable-next-line typescript/no-require-imports -- the deferred native load is deliberate; see the module doc.
  return require('@trycua/cua-driver') as typeof import('@trycua/cua-driver')
}

/** The probe child's program: the TCC state read from a fresh runtime. */
const PROBE_SOURCE = `const { createRequire } = await import('node:module');
const sdk = createRequire(__ROOT__ + '/index.js')('@trycua/cua-driver');
process.stdout.write(JSON.stringify(sdk.currentMacOsPermissionStatus()));`

/** The live drag-guide helper process, if one is showing. */
let guideProcess: ReturnType<typeof spawn> | undefined

/** Terminate the drag-guide helper; a missing or exited process is fine. */
function dismissGuideProcess(): void {
  if (guideProcess === undefined) return
  try { guideProcess.kill() } catch {}
  guideProcess = undefined
}

/** The desktop-permission remote: a status probe plus the guided hand-off. */
export class DesktopPermissionsController extends TypertRemoteService {
  static inject = []

  constructor(ctx: Context) {
    super(ctx, 'desktopPermissions')
  }

  /**
   * Read the host process's TCC state. Runs the native probe on first use;
   * a platform without the native SDK (or a probe failure) reports both as
   * false, which is the conservative answer for a permission surface.
   * @returns the accessibility and screen-recording grant states.
   */
  @Remote
  status(): DesktopPermissionStatus {
    try {
      return nativeProbe().currentMacOsPermissionStatus()
    } catch {
      return { accessibility: false, screenRecording: false }
    }
  }

  /**
   * Reveal Colaw.app in Finder: dragging the app from Finder into the
   * System Settings list is the grant path the floating guide points at.
   */
  @Remote
  revealAppInFinder(): void {
    try {
      // process.execPath lives in Colaw.app/Contents/MacOS; the bundle is
      // three levels up.
      const appDir = dirname(dirname(dirname(process.execPath)))
      // The error callback keeps an `open` failure from crashing the host process.
      execFile('open', ['-R', appDir], () => {})
    } catch {}
  }

  /**
   * Read the TCC state from a FRESH child process. macOS evaluates TCC per
   * process and the long-running host keeps serving its stale (pre-grant)
   * answer even after the user flips the toggle in System Settings — a new
   * process reads the database's current truth. Slower (~200ms spawn); the
   * grant guide's polling uses this so the pending switch completes the
   * moment the grant lands.
   * @returns the current TCC state, or undefined when the probe child fails.
   */
  /**
   * Show the native drag-guide bar for one pane: the floating helper whose
   * app icon the user drags straight into the System Settings list. The host
   * owns the helper's lifetime — a guide already showing is replaced, and
   * `dismissGrantGuide` ends it when the grant lands or the user gives up.
   * Absent helper binary (non-macOS, no toolchain at pack time) is a no-op:
   * the in-page bar carries the same guidance.
   * @param pane - the privacy pane whose grant is missing.
   * @returns whether the native bar actually spawned; the client hides its
   *   in-page bar only then, keeping it as the fallback.
   */
  @Remote
  showGrantGuide(pane: DesktopPermissionPane): boolean {
    dismissGuideProcess()
    try {
      const helper = join(dirname(dirname(process.execPath)), 'Resources', 'permission-guide')
      if (!existsSync(helper)) return false
      const appBundle = dirname(dirname(dirname(process.execPath)))
      guideProcess = spawn(helper, [appBundle, pane], { detached: true, stdio: 'ignore' })
      guideProcess.unref()
      return true
    } catch {
      return false
    }
  }

  /**
   * End the native drag-guide bar, if showing. The client calls this when a
   * probe sees the grant land (or the user dismisses the guide).
   */
  @Remote
  dismissGrantGuide(): void {
    dismissGuideProcess()
  }

  /**
   * Deep-link System Settings to one privacy pane and re-probe on return.
   *
   * The native SDK only deep-links Screen Recording, so the Accessibility pane
   * rides the system `open` URL — both land on the exact pane the user must
   * toggle, rather than the top-level Privacy page.
   * @param pane - the privacy pane whose grants are missing.
   * @returns the host's TCC state after the Settings window has been asked to open.
   */
  @Remote
  openPermissionPane(pane: DesktopPermissionPane): DesktopPermissionStatus {
    try {
      if (pane === 'accessibility') {
        // The error callback keeps an `open` failure from crashing the host process.
        execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => {})
      } else {
        nativeProbe().openMacOsScreenRecordingSettings()
      }
      return this.status()
    } catch {
      return { accessibility: false, screenRecording: false }
    }
  }

  @Remote
  async statusFresh(): Promise<DesktopPermissionStatus | undefined> {
    try {
      // A fresh process reads the TCC database's CURRENT state; the
      // long-running host keeps answering its stale pre-grant cache.
      const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ['--input-type=module', '--eval', PROBE_SOURCE.replace('__ROOT__', JSON.stringify(packageRoot))], {
          cwd: packageRoot,
          timeout: 8_000,
          maxBuffer: 4 * 1024,
        }, (error, stdout) => {
          if (stdout === '') reject(error ?? new Error('probe produced no output'))
          else resolve(stdout)
        })
      })
      const parsed = JSON.parse(stdout) as DesktopPermissionStatus
      return { accessibility: parsed.accessibility === true, screenRecording: parsed.screenRecording === true }
    } catch {
      // The fresh probe is best-effort: fall back to the in-process answer,
      // which stays correct until macOS's per-process TCC cache expires.
      return this.status()
    }
  }

  /**
   * Restart the app in place: the running process has to be replaced so a
   * freshly granted TCC state (and every other pending change) is read by a
   * clean boot — macOS caches the accessibility trust answer per process, so
   * the granted surface stays dead until the process is new.
   *
   * The relaunch deliberately does NOT happen from this process. Spawning
   * `Contents/MacOS/launcher` here starts a second instance beside a live one,
   * and the two then fight over everything a single instance owns: the
   * webserver port, the profile's storage, and the boot-time single-instance
   * probe that answers a second launch by activating the first and exiting.
   * Whichever side loses, the visible symptom is the same and is exactly the
   * reported one — the app closes and never comes back.
   *
   * Instead a detached shell waits for this pid to disappear and only then
   * hands the bundle to LaunchServices. The new instance therefore never
   * coexists with this one, it is started by launchd rather than as a child of
   * the process being replaced (so the app's own teardown cannot take it down
   * with it, and TCC attributes the launch to the bundle), and `-n` makes the
   * launch independent of when LaunchServices notices this instance quit.
   */
  @Remote
  restartApp(): void {
    // The bundle is three levels above Contents/MacOS; a source run has none,
    // and a relaunch of one is not a thing this remote can do.
    const appBundle = dirname(dirname(dirname(process.execPath)))
    try {
      if (!appBundle.endsWith('.app')) return
      const waiter = `while kill -0 ${String(process.pid)} 2>/dev/null; do sleep 0.2; done; `
        + `exec /usr/bin/open -n ${shellQuote(appBundle)}`
      const child = spawn('/bin/sh', ['-c', waiter], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch {
      // Without a relauncher the app must NOT exit: a restart that cannot come
      // back is a quit, and the user asked for the former.
      return
    }
    // The waiter is armed and watches this pid: leaving is what starts the
    // relaunch, so the exit is the second half of the operation, not a failure.
    setTimeout(() => { process.exit(0) }, 300)
  }
}

/**
 * Quote one path for `/bin/sh`. Single quotes with the standard close-escape
 * keeps a bundle path with spaces, `$`, or a backslash literal.
 * @param value - the path to quote.
 * @returns the path as one shell word.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Cordis plugin identity for the permissions controller. */


/** Cordis plugin identity for the native Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-native'

/** Services required before the native runtime can publish tools. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'settings']

/** The native provider uses the installed SDK's same-process defaults. */
export const Config = Schema.object({})

const ToolCatalog = z.object({
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.unknown().optional(),
  })),
})

/** DeepSeek's function-name alphabet and maximum length are protocol constants. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** A tool name this module is willing to spell into a YAML policy file. */
const POLICY_TOOL_NAME = /^[a-z0-9_]+$/u

/**
 * The upstream tools this provider exposes, and the ones it withholds.
 *
 * The split exists because one upstream tool ends the host process.
 * `invoke_menu` raises a window through AppKit's `-[NSWindow
 * makeKeyAndOrderFront:]`, which macOS asserts to the main thread, and the
 * driver calls it from its own tokio worker: the assertion reaches
 * `__pthread_kill` and SIGTRAP-aborts everything. The crash report
 * `bun-2026-09-23-132012.ips` names `platform_macos::tools::invoke_menu::
 * focus_exact_window` on the `cua-driver-abi` thread, and no JS can intercept
 * it — `try`/`catch` never runs and a `tools/execute` middleware never resumes.
 *
 * Withholding is therefore the control, applied twice: this list keeps a
 * withheld tool off the model's tool surface, and the same split is written into
 * a permission policy that the native runtime enforces at its own registry
 * boundary, before any platform action runs. The native check is the load
 * bearing one — a recorded trajectory replaying a tool name still crosses it —
 * and it is deny-by-default, so a catalog that grows cannot widen the surface
 * without an edit here.
 */
const EXPOSED_TOOLS: readonly string[] = Object.freeze([
  'list_apps',
  'list_windows',
  'get_window_state',
  'verify_state',
  'launch_app',
  'kill_app',
  'bring_to_front',
  'set_window_frame',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'scroll',
  'clipboard_read',
  'clipboard_write',
  'get_screen_size',
  'get_desktop_state',
  'get_cursor_position',
  'move_cursor',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'get_agent_cursor_state',
  'check_permissions',
  'health_report',
  'get_config',
  'set_config',
  'get_accessibility_tree',
  'zoom',
  'page',
  'get_browser_state',
  'browser_prepare',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_dialog',
  'browser_set_input_files',
  'browser_download',
  'browser_pointer',
  'start_recording',
  'stop_recording',
  'get_recording_state',
  'install_ffmpeg',
  'start_session',
  'escalate_session',
  'get_session',
  'list_sessions',
  'get_session_state',
  'end_session',
])

/** Withheld tools: the name to the reason it is out. Also denied by the policy. */
const WITHHELD_TOOLS: ReadonlyMap<string, string> = new Map([
  ['invoke_menu', 'raises a window off the main thread and SIGTRAP-aborts the host process'],
  ['replay_trajectory', 're-dispatches tool names read from a recorded directory, which would reach a withheld tool'],
])

/**
 * The permission policy the native runtime enforces, generated from the split
 * above. `deny` is evaluated before `allow` in the engine, so a withheld name
 * stays withheld even if it were ever added to the allow list by mistake.
 * @returns the policy as YAML.
 */
function policyYaml(): string {
  const lines = ['allow:', '  tools:']
  for (const tool of EXPOSED_TOOLS) lines.push(`    - ${tool}`)
  lines.push('deny:', '  tools:')
  for (const tool of WITHHELD_TOOLS.keys()) lines.push(`    - ${tool}`)
  return `${lines.join('\n')}\n`
}

/**
 * Write the policy and point the native runtime at it.
 *
 * The engine reads `CUA_DRIVER_POLICY_FILE` when a runtime starts, so setting
 * the variable immediately before `create()` is what arms it — measured against
 * 0.28.0, where a denied call comes back as `user policy: tool 'invoke_menu' is
 * explicitly denied` while the process stays alive. The file is rewritten on
 * every mount so the runtime can never load a stale or edited copy, and it lives
 * in the per-user private temp directory with owner-only permissions.
 *
 * A failure here aborts the mount on purpose. Carrying on without the policy
 * would behave exactly like the unguarded build while silently dropping the
 * guarantee, which is the one outcome this mechanism exists to prevent.
 * @returns the absolute policy path the runtime was pointed at.
 */
function armPermissionPolicy(): string {
  for (const tool of [...EXPOSED_TOOLS, ...WITHHELD_TOOLS.keys()]) {
    if (!POLICY_TOOL_NAME.test(tool)) throw new Error(`Cua Driver tool "${tool}" cannot be written into a policy file`)
  }
  const directory = join(tmpdir(), 'colaw-cua-policy')
  const path = join(directory, 'policy.yaml')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(path, policyYaml(), { mode: 0o600 })
  process.env.CUA_DRIVER_POLICY_FILE = path
  return path
}

const GUIDANCE = `Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry — it names the way through, so pass delivery_mode:"foreground" rather than reaching for another tool. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work. Application-menu invocation is not part of this tool surface: resolving a menu path reaches AppKit's window-raise path from the driver's own worker thread, where macOS asserts and aborts the whole host process, so reach a window's menu commands through its own controls or a keyboard equivalent instead. delivery_mode:"foreground" is what briefly fronts a window, and it restores the previous frontmost afterwards.`

/**
 * Own one hosted driver and expose its catalog through the MCP result adapter.
 * Startup failures roll back every registration. Unload removes tools, aborts
 * calls and image admission, awaits settlement and child shutdown, then
 * releases computer use.
 * @param ctx - context providing the exclusive registration and tool services.
 * @returns after the child starts, the runtime is created, and tool discovery completes.
 */
export async function apply(ctx: Context): Promise<void> {
  // The permission remote mounts unconditionally: the 电脑操控 tab needs an
  // accurate TCC answer BEFORE the user turns Computer_use on, which is
  // exactly when the gated provider below is not mounted. The Service base
  // constructor registers the instance as `desktopPermissions` on `ctx` — an
  // explicit provide here would be a duplicate registration and throw.
  new DesktopPermissionsController(ctx)
  // The 电脑操控 tab owns the gate: with the switch off this provider mounts
  // inertly — no native runtime, no tools, no prompt section. Turning it on
  // takes effect from the next session; turning it off stops new use without
  // touching any macOS permission the user has granted.
  const settings = ctx.get('settings') as unknown as DesktopSettingsReader | undefined
  const enabled = settings?.get(DESKTOP_SETTINGS_NAMESPACE)?.computerUse === true
  if (!enabled) return
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let driver: DriverHost | undefined
  // Cordis announces disposal before it awaits asynchronous plugin startup.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort()
  }, { global: true })
  let ready: Promise<void> = Promise.resolve()
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-native'))
    yield async () => {
      lifetime.abort()
      // apply() reports startup failure; teardown still owns its native handle.
      await ready.catch(() => {})
      await Promise.allSettled(pending)
      // The child owns the driver handle, so closing it is one operation:
      // shutdown settles what is still in flight and reaps the process.
      if (driver !== undefined) await driver.shutdown()
    }
    const child = ctx.plugin({
      name: 'computer-use-cua-driver-native-runtime',
      inject: ['tools', 'systemPrompt'],
      apply: mountRuntime,
    })
    yield child.dispose
    ready = Promise.resolve(child).then(() => {})
  }, 'computer-use-cua-driver-native.runtime')
  try {
    await ready
  } catch (error) {
    await dispose()
    throw error
  }

  /** The child owns tool registrations; the outer effect owns child teardown. */
  async function mountRuntime(inner: Context): Promise<void> {
    // The policy has to be in place before the driver process exists: the
    // engine reads the variable once, when a runtime starts, and the child
    // inherits it from this process's environment.
    armPermissionPolicy()
    lifetime.signal.throwIfAborted()
    const activeDriver = driver = openDriverHost()
    const catalog = ToolCatalog.parse(JSON.parse(await activeDriver.listToolsJson({ signal: lifetime.signal })))
    lifetime.signal.throwIfAborted()
    // A tool in neither list is a decision nobody has made. The dependency is
    // pinned, so this can only fire on a deliberate upgrade — and failing the
    // mount is the fail-closed direction for a surface whose worst case is
    // killing the host.
    const exposed = new Set(EXPOSED_TOOLS)
    const unclassified = catalog.tools.filter(tool => !exposed.has(tool.name) && !WITHHELD_TOOLS.has(tool.name))
    if (unclassified.length > 0) {
      throw new Error(`Cua Driver tools have no exposure decision: ${unclassified.map(tool => tool.name).join(', ')}`)
    }
    const names = new Set<string>()
    for (const tool of catalog.tools) {
      if (WITHHELD_TOOLS.has(tool.name)) continue
      const publicName = `cua_driver_native__${tool.name}`
      if (!TOOL_NAME.test(publicName)) {
        throw new Error(`Cua Driver tool "${tool.name}" exceeds the supported function-name format`)
      }
      if (names.has(publicName)) throw new Error(`Cua Driver listed tool "${tool.name}" more than once`)
      names.add(publicName)
      const definition = createMcpToolDefinition(inner, {
        name: publicName,
        rawName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        async call(args, execution) {
          const combined = AbortSignal.any([execution.signal, lifetime.signal])
          combined.throwIfAborted()
          const result = await activeDriver.callTool(tool.name, JSON.stringify(args), { signal: combined })
          combined.throwIfAborted()
          return JSON.parse(result.rawJson) as unknown
        },
      })
      inner.tools.register(definition)
    }
    inner.on('tools/execute', async (exec, next) => {
      if (!names.has(exec.name)) return next()
      const upstream = exec.signal
      exec.signal = AbortSignal.any([upstream, lifetime.signal])
      const operation = Promise.resolve().then(next)
      pending.add(operation)
      try {
        return await operation
      } finally {
        pending.delete(operation)
        exec.signal = upstream
      }
    })
    inner.systemPrompt.section({
      name: 'computer-use:cua-driver-native',
      order: inner.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: GUIDANCE,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The desktop-permission remote: host-process TCC state and the Settings deep-link. */
    desktopPermissions: DesktopPermissionsController
  }
}
