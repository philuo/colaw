/**
 * The two macOS behaviours Electrobun leaves unbound: the application's
 * appearance, and the image macOS shows as its icon.
 *
 * The window's chrome — title bar, traffic lights, the menu bar's own tint — is
 * drawn by AppKit, so the shell's theme cannot reach it through CSS; and the
 * running app's icon is a runtime property, not a bundle one, which is why a
 * second icon cannot simply be shipped alongside the first. Both are reached the
 * way the native wrapper itself reaches AppKit: `objc_msgSend` over Bun's FFI.
 *
 * Every call here is main-thread-only, which is where Bun runs this app's
 * JavaScript: Electrobun's Bun main process is the process's main thread, and
 * every value that crosses the boundary is an opaque `id`.
 *
 * @module @deepseek-ai/dsh-electrobun-host/bun/app-appearance
 */

import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { platform } from 'node:process'

/** The appearance selections the shell offers. */
export type AppearancePreference = 'light' | 'dark' | 'system'

/** The two AppKit appearance names a forced selection maps to. */
const DARK_APPEARANCE = 'NSAppearanceNameDarkAqua'
const LIGHT_APPEARANCE = 'NSAppearanceNameAqua'

/** Reading `UTF8String` off a name yields '…DarkAqua' for the dark appearance. */
const DARK_NAME_MARKER = 'Dark'

/** A null `id`, which is both "no argument" and how a selection is cleared. */
const NIL = null

/**
 * One `objc_msgSend` binding per argument shape. The exported symbol is a single
 * variadic function, so each signature needs its own `dlopen` — a binding's key
 * has to be the real symbol name, and the key is what fixes the signature.
 */
interface Bindings {
  classOf: (name: string) => Pointer | null
  selector: (name: string) => Pointer
  send: (receiver: Pointer | null, selector: Pointer) => Pointer | null
  sendText: (receiver: Pointer | null, selector: Pointer, text: string) => Pointer | null
  sendObject: (receiver: Pointer | null, selector: Pointer, argument: Pointer | null) => Pointer | null
  sendObjectVoid: (receiver: Pointer | null, selector: Pointer, argument: Pointer | null) => void
  sendTwoObjectsVoid: (
    receiver: Pointer | null, selector: Pointer,
    first: Pointer | null, second: Pointer | null,
  ) => void
  textOf: (receiver: Pointer | null, selector: Pointer) => string | null
}

const OBJC = '/usr/lib/libobjc.A.dylib'

let bindings: Bindings | undefined
let unavailable = false

/** Open the Objective-C runtime, or report that this platform has no AppKit. */
function open(): Bindings | undefined {
  if (bindings !== undefined || unavailable) return bindings
  if (platform !== 'darwin') {
    unavailable = true
    return undefined
  }
  try {
    const core = dlopen(OBJC, {
      objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    })
    const noArgs = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    })
    const oneText = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
    })
    const oneObject = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    })
    const oneObjectVoid = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    })
    const textResult = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.cstring },
    })
    const twoObjectsVoid = dlopen(OBJC, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    })
    bindings = {
      classOf: name => core.symbols.objc_getClass(name),
      selector: name => core.symbols.sel_registerName(name),
      send: noArgs.symbols.objc_msgSend as Bindings['send'],
      sendText: oneText.symbols.objc_msgSend as Bindings['sendText'],
      sendObject: oneObject.symbols.objc_msgSend as Bindings['sendObject'],
      sendObjectVoid: oneObjectVoid.symbols.objc_msgSend as Bindings['sendObjectVoid'],
      sendTwoObjectsVoid: twoObjectsVoid.symbols.objc_msgSend as Bindings['sendTwoObjectsVoid'],
      textOf: textResult.symbols.objc_msgSend as Bindings['textOf'],
    }
  } catch (error) {
    unavailable = true
    console.warn(`[electrobun-host] native appearance unavailable: ${String(error)}`)
    return undefined
  }
  return bindings
}

/** The running `NSApplication`, or null outside an AppKit app. */
function application(api: Bindings): Pointer | null {
  const cls = api.classOf('NSApplication')
  if (cls === null) return null
  return api.send(cls, api.selector('sharedApplication'))
}

/** An autoreleased `NSString` for one path or name. */
function text(api: Bindings, value: string): Pointer | null {
  const cls = api.classOf('NSString')
  if (cls === null) return null
  return api.sendText(cls, api.selector('stringWithUTF8String:'), value)
}

/**
 * Run one AppKit interaction.
 *
 * These calls are an enhancement, not a dependency: a runtime that cannot reach
 * AppKit — or an AppKit that refuses a call — must cost the app its themed chrome
 * and nothing else, so the first failure retires the binding for the process
 * instead of failing the boot that asked for it.
 */
function attempt<T>(fallback: T, action: (api: Bindings, app: Pointer) => T): T {
  const api = open()
  if (api === undefined) return fallback
  try {
    const app = application(api)
    if (app === null) return fallback
    return action(api, app)
  } catch (error) {
    unavailable = true
    console.warn(`[electrobun-host] native appearance disabled: ${String(error)}`)
    return fallback
  }
}

/**
 * Force the application's appearance, or hand it back to the system.
 *
 * Forcing it also pins what the webview reports for `prefers-color-scheme`, so
 * the page and the chrome can never disagree about which theme is on.
 * @param preference - The shell's appearance selection.
 */
export function setAppearance(preference: AppearancePreference): void {
  attempt(undefined, (api, app) => {
    if (preference === 'system') {
      api.sendObjectVoid(app, api.selector('setAppearance:'), NIL)
      return undefined
    }
    const cls = api.classOf('NSAppearance')
    if (cls === null) return undefined
    const name = preference === 'dark' ? DARK_APPEARANCE : LIGHT_APPEARANCE
    const appearance = api.sendObject(cls, api.selector('appearanceNamed:'), text(api, name))
    api.sendObjectVoid(app, api.selector('setAppearance:'), appearance)
    return undefined
  })
}

/**
 * Whether macOS itself is set to the dark appearance.
 *
 * The app-level appearance is frozen at launch (re-setting it under live views
 * crashes the webview), so `effectiveAppearance` keeps answering the forced
 * value all session. The system's own setting is a different question, answered
 * by the `AppleInterfaceStyle` preference: present and containing "Dark" for
 * Dark Mode, absent for Light. This is the value a `system` theme preference
 * must follow while the app-level appearance stays pinned.
 */
export function systemIsDark(): boolean {
  return attempt(false, (api) => {
    const cls = api.classOf('NSUserDefaults')
    if (cls === null) return false
    const defaults = api.send(cls, api.selector('standardUserDefaults'))
    if (defaults === null) return false
    const style = api.textOf(
      api.sendObject(defaults, api.selector('stringForKey:'), text(api, 'AppleInterfaceStyle')),
      api.selector('UTF8String'),
    )
    return style !== null && style.includes(DARK_NAME_MARKER)
  })
}

/**
 * Show the image at `path` as the running application's icon.
 * @param path - Absolute path to an `.icns` (or any image `NSImage` reads).
 */
export function setApplicationIcon(path: string): void {
  attempt(undefined, (api, app) => {
    const cls = api.classOf('NSImage')
    if (cls === null) return undefined
    const allocated = api.send(cls, api.selector('alloc'))
    if (allocated === null) return undefined
    const image = api.sendObject(allocated, api.selector('initWithContentsOfFile:'), text(api, path))
    // A missing file is the one failure that is a packaging mistake rather than
    // a platform difference, so it is worth saying out loud.
    if (image === null) {
      console.warn(`[electrobun-host] app icon not found: ${path}`)
      return undefined
    }
    api.sendObjectVoid(app, api.selector('setApplicationIconImage:'), image)
    return undefined
  })
}

/**
 * Whether the app is frontmost right now — the signal that the user clicked
 * the Dock (or Launchpad) tile. A hidden window is not shown by macOS on
 * reopen, so the host watches this flip and shows it itself.
 * @returns true when the application is active; false outside AppKit.
 */
export function applicationIsActive(): boolean {
  const api = open()
  if (api === undefined) return false
  const app = application(api)
  if (app === null) return false
  const result = api.send(app, api.selector('isActive'))
  // A BOOL returns its register widened; a null pointer reads as false.
  return result !== null && Number(result) !== 0
}

/**
 * The Finder/Launchpad/at-rest-Dock icon: `NSWorkspace setIcon:forFile:`
 * writes the image into the bundle's resource-fork extended attribute, which
 * every file-facing surface prefers over the CFBundleIconFile — without
 * touching the bundle contents (the code signature stays sealed). The custom
 * icon is lost when the bundle is replaced (an update, a rebuild) and is
 * re-applied by the next launch's followAppearance.
 * @param iconPath - The themed icns to pin.
 * @param bundlePath - This app's own .app directory.
 * @returns true when the workspace accepted the icon.
 */
export function setBundleIcon(iconPath: string, bundlePath: string): boolean {
  return attempt(false, (api) => {
    const imageClass = api.classOf('NSImage')
    if (imageClass === null) return false
    const allocated = api.send(imageClass, api.selector('alloc'))
    if (allocated === null) return false
    const image = api.sendObject(allocated, api.selector('initWithContentsOfFile:'), text(api, iconPath))
    if (image === null) return false
    const workspaceClass = api.classOf('NSWorkspace')
    if (workspaceClass === null) return false
    const workspace = api.send(workspaceClass, api.selector('sharedWorkspace'))
    if (workspace === null) return false
    const file = text(api, bundlePath)
    if (file === null) return false
    // options:0 reads as a null pointer — zero is the no-options value.
    api.sendTwoObjectsVoid(workspace, api.selector('setIcon:forFile:options:'), image, file)
    return true
  })
}
