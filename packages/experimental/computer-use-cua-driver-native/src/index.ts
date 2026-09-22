/**
 * Computer use through the in-process Cua Driver native SDK and its own tools.
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import type { CuaDriver as NativeDriver } from '@trycua/cua-driver'
import type {} from '@deepseek-ai/dsh-computer-use'
import { execFile } from 'node:child_process'
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

const GUIDANCE = `Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.`

/**
 * Own one native runtime and expose its catalog through the MCP result adapter.
 * Startup failures roll back every registration. Unload removes tools, aborts
 * calls and image admission, awaits settlement and SDK shutdown, then releases computer use.
 * @param ctx - context providing the exclusive registration and tool services.
 * @returns after native import, runtime creation, and tool discovery complete.
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
  let driver: NativeDriver | undefined
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
      if (driver !== undefined) {
        await driver.shutdown()
        driver.uniffiDestroy()
      }
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

  /** The child owns tool registrations; the outer effect owns native teardown. */
  async function mountRuntime(inner: Context): Promise<void> {
    const { CuaDriver } = await import('@trycua/cua-driver')
    lifetime.signal.throwIfAborted()
    // The generated constructor returns its class with an owned binding handle,
    // but declares only CuaDriverLike, which omits uniffiDestroy().
    const activeDriver = driver = CuaDriver.create(undefined) as NativeDriver
    const catalog = ToolCatalog.parse(JSON.parse(await activeDriver.listToolsJson({ signal: lifetime.signal })))
    lifetime.signal.throwIfAborted()
    const names = new Set<string>()
    for (const tool of catalog.tools) {
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
