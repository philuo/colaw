/**
 * Colaw WKWebView 60fps-cap unlock — dylib build + Mach-O load-command
 * injection. Machine-verified 2026-09-14 on macOS 15.6.1: disabling
 * `PreferPageRenderingUpdatesNear60FPSEnabled` via
 * `-[WKPreferences _setEnabled:forFeature:]` unlocks ProMotion rAF
 * (~60 → ~120fps), and it ONLY takes effect when applied to the
 * WKWebViewConfiguration before `-[WKWebView initWithFrame:configuration:]`
 * runs. Post-creation toggles are inert (fpsprobe2/fpsprobe3), so this
 * swizzles the initializer itself — see apps/electrobun-host/native/
 * colaw-webview-unlock.m.
 *
 * What gets patched, per app:
 *   1. libColawWebviewUnlock.dylib is copied into Contents/MacOS/.
 *   2. An LC_LOAD_DYLIB (@executable_path/…) is added to the Mach-O header
 *      of libNativeWrapper.dylib — the library that loads into the window
 *      process, so the swizzle lands before any webview exists. The dylib's
 *      header has verified slack; no byte-shifting, in-place edit only.
 *   3. Both dylibs are re-signed adhoc (they were linker-signed; editing
 *      invalidates that signature).
 *
 * Scope: the DIRECTLY RUNNABLE app produced by pack-stable-app only.
 * Hutch assembles the official release payload's MacOS shell from a fixed
 * file list — an extra dylib in its release cache is NOT copied into the
 * tar.zst/DMG, so a cache-patched shell would reference a dylib the payload
 * doesn't carry (hard dyld failure). Until upstream Electrobun exposes a
 * shell-file hook, official artifacts stay capped; distribute the runnable
 * app (zip of build/stable-macos-arm64/Colaw.app) instead of the DMG.
 *
 * Escape hatch: COLAW_WEBVIEW_UNLOCK=0 skips everything (idempotent steps
 * also no-op when already applied). Bun only, by fork policy.
 *
 * @module scripts/colaw-webview-unlock
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if ((globalThis as { Bun?: object }).Bun === undefined) {
  console.error('colaw-webview-unlock: bun only')
  process.exit(1)
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hostDir = join(repoRoot, 'apps', 'electrobun-host')
const unlockSource = join(hostDir, 'native', 'colaw-webview-unlock.m')
const unlockBuild = join(hostDir, 'build', 'colaw-webview-unlock.dylib')
const unlockName = 'libColawWebviewUnlock.dylib'
const installName = `@executable_path/${unlockName}`
const wrapperName = 'libNativeWrapper.dylib'

const MH_MAGIC_64 = 0xfeedfacf
const CPU_TYPE_ARM64 = 0x0100000c
const LC_LOAD_DYLIB = 0xc
const LC_SEGMENT_64 = 0x19
const HEADER_SIZE = 32

/** Runtime switch: COLAW_WEBVIEW_UNLOCK=0 disables the whole feature. */
function unlocked(): boolean {
  return process.env.COLAW_WEBVIEW_UNLOCK !== '0'
}

/** Build (or reuse) the swizzle dylib. Cheap: clang on one file, cached by mtime. */
function buildUnlockDylib(): string {
  mkdirSync(join(hostDir, 'build'), { recursive: true })
  const sourceMtime = statSync(unlockSource).mtimeMs
  if (!existsSync(unlockBuild) || statSync(unlockBuild).mtimeMs < sourceMtime) {
    const result = spawnSync('/usr/bin/clang', [
      '-dynamiclib', '-fobjc-arc', '-arch', 'arm64', '-O2',
      '-framework', 'WebKit', '-framework', 'AppKit', '-framework', 'Foundation',
      unlockSource, '-o', unlockBuild,
    ], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`clang build failed (${String(result.status)})`)
  }
  return unlockBuild
}

function readUint32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset)
}

/** Round up to the 8-byte alignment 64-bit load commands require. */
function align8(value: number): number {
  return (value + 7) & ~7
}

/** The LC_LOAD_DYLIB bytes for @executable_path/<unlockName>, or null if present already. */
function unlockLoadCommand(buffer: Buffer): { bytes: Buffer; cmdsize: number } | 'present' {
  const ncmds = readUint32(buffer, 16)
  const sizeofcmds = readUint32(buffer, 20)
  const pathBytes = Buffer.from(`${installName}\0`, 'utf8')
  const cmdsize = align8(24 + pathBytes.length)
  let offset = HEADER_SIZE
  for (let index = 0; index < ncmds; index++) {
    const cmd = readUint32(buffer, offset)
    const size = readUint32(buffer, offset + 4)
    if (cmd === LC_LOAD_DYLIB && size >= 24) {
      const existing = buffer.subarray(offset + 24, offset + size)
      const pathEnd = existing.indexOf(0)
      if (pathEnd > 0 && existing.subarray(0, pathEnd).toString('utf8') === installName) return 'present'
    }
    offset += size
  }
  if (offset !== HEADER_SIZE + sizeofcmds) {
    throw new Error(`load commands end (${offset}) != header end (${HEADER_SIZE + sizeofcmds})`)
  }
  const bytes = Buffer.alloc(cmdsize)
  bytes.writeUInt32LE(LC_LOAD_DYLIB, 0)
  bytes.writeUInt32LE(cmdsize, 4)
  bytes.writeUInt32LE(24, 8) // name.offset
  bytes.writeUInt32LE(1, 12) // timestamp
  bytes.writeUInt32LE(0, 16) // current_version
  bytes.writeUInt32LE(0, 20) // compatibility_version
  pathBytes.copy(bytes, 24)
  return { bytes, cmdsize }
}

/**
 * Add the unlock LC_LOAD_DYLIB to a Mach-O in place. Fails hard on any
 * structural surprise — callers must never ship a half-patched binary.
 * Returns 'injected' | 'already' | throws.
 */
function injectLoadCommand(path: string): 'injected' | 'already' {
  const buffer = readFileSync(path)
  if (readUint32(buffer, 0) !== MH_MAGIC_64 || readUint32(buffer, 4) !== CPU_TYPE_ARM64) {
    throw new Error(`${path}: not a little-endian arm64 Mach-O`)
  }
  const command = unlockLoadCommand(buffer)
  if (command === 'present') return 'already'
  const ncmds = readUint32(buffer, 16)
  const sizeofcmds = readUint32(buffer, 20)
  const cmdsEnd = HEADER_SIZE + sizeofcmds

  // Self-heal: an earlier rollback (before the removal zeroing was fixed) can
  // leave OUR command's bytes stranded just past cmdsEnd with the header
  // counters already reverted. Detect that exact leftover — our unique install
  // name inside a trailing LC_LOAD_DYLIB — and scrub it, otherwise nothing
  // real would ever be overwritten below.
  const orphanCmd = readUint32(buffer, cmdsEnd)
  const orphanSize = readUint32(buffer, cmdsEnd + 4)
  if (orphanCmd === LC_LOAD_DYLIB && orphanSize >= 24 && orphanSize <= 4096) {
    const payload = buffer.subarray(cmdsEnd + 24, cmdsEnd + orphanSize)
    const pathEnd = payload.indexOf(0)
    if (pathEnd > 0 && payload.subarray(0, pathEnd).toString('utf8') === installName) {
      buffer.fill(0, cmdsEnd, cmdsEnd + orphanSize)
    }
  }

  // Slack check: the gap between the load commands and the first file-backed
  // segment must be real padding (zeros) and large enough. libNativeWrapper
  // has ~1 MiB of linker padding; a main executable with code in the gap
  // (e.g. the launcher) would fail here — never shift bytes.
  const gap = buffer.subarray(cmdsEnd, cmdsEnd + command.cmdsize)
  if (gap.some(byte => byte !== 0)) throw new Error(`${path}: no zero padding after load commands`)
  let offset = HEADER_SIZE
  let slack = Number.MAX_SAFE_INTEGER
  for (let index = 0; index < ncmds; index++) {
    const cmd = readUint32(buffer, offset)
    const size = readUint32(buffer, offset + 4)
    if (cmd === LC_SEGMENT_64) {
      const fileoff = Number(buffer.readBigUInt64LE(offset + 40))
      const filesize = Number(buffer.readBigUInt64LE(offset + 48))
      if (filesize > 0 && fileoff >= cmdsEnd) slack = Math.min(slack, fileoff - cmdsEnd)
    }
    offset += size
  }
  if (slack < command.cmdsize) throw new Error(`${path}: header slack ${slack} < ${command.cmdsize}`)

  gap.fill(0)
  command.bytes.copy(buffer, cmdsEnd)
  buffer.writeUInt32LE(ncmds + 1, 16)
  buffer.writeUInt32LE(sizeofcmds + command.cmdsize, 20)
  writeFileSync(path, buffer)
  return 'injected'
}

function resignAdhoc(path: string): void {
  const result = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', path], { stdio: 'pipe' })
  if (result.status !== 0) {
    throw new Error(`codesign failed for ${path}: ${result.stderr.toString().trim()}`)
  }
}

/** Patch one directory that holds the runtime shell's MacOS binaries. */
function patchShellDir(macosDir: string, label: string): boolean {
  const wrapper = join(macosDir, wrapperName)
  if (!existsSync(wrapper)) {
    console.warn(`webview-unlock: ${label} has no ${wrapperName}; skipping (${macosDir})`)
    return false
  }
  copyFileSync(buildUnlockDylib(), join(macosDir, unlockName))
  const injected = injectLoadCommand(wrapper)
  resignAdhoc(join(macosDir, unlockName))
  if (injected === 'injected') resignAdhoc(wrapper)
  console.log(`webview-unlock: ${label} ${injected === 'already' ? 'already patched' : 'patched'}`)
  return true
}

/**
 * Unlock one .app: copy the dylib into Contents/MacOS and hook
 * libNativeWrapper.dylib. Returns false when skipped (env) or the shell
 * layout is unexpected — never a hard failure, packaging must proceed.
 */
export function applyWebviewUnlockSync(appPath: string): boolean {
  if (!unlocked()) {
    console.log('webview-unlock: disabled via COLAW_WEBVIEW_UNLOCK=0')
    return false
  }
  try {
    return patchShellDir(join(appPath, 'Contents', 'MacOS'), appPath)
  } catch (error) {
    console.warn(`webview-unlock: ${appPath} skipped: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Undo an injected unlock LC_LOAD_DYLIB (symmetric in-place removal within
 * the padding slack), restoring the shell dylib for pristine official
 * builds. Returns 'removed' | 'absent'.
 */
export function removeUnlockLoadCommand(path: string): 'removed' | 'absent' {
  const buffer = readFileSync(path)
  if (readUint32(buffer, 0) !== MH_MAGIC_64 || readUint32(buffer, 4) !== CPU_TYPE_ARM64) {
    throw new Error(`${path}: not a little-endian arm64 Mach-O`)
  }
  const ncmds = readUint32(buffer, 16)
  const sizeofcmds = readUint32(buffer, 20)
  let offset = HEADER_SIZE
  let found: { offset: number; size: number } | undefined
  for (let index = 0; index < ncmds; index++) {
    const cmd = readUint32(buffer, offset)
    const size = readUint32(buffer, offset + 4)
    if (cmd === LC_LOAD_DYLIB && size >= 24) {
      const existing = buffer.subarray(offset + 24, offset + size)
      const pathEnd = existing.indexOf(0)
      if (pathEnd > 0 && existing.subarray(0, pathEnd).toString('utf8') === installName) {
        found = { offset, size }
      }
    }
    offset += size
  }
  if (found === undefined) return 'absent'
  const oldEnd = HEADER_SIZE + sizeofcmds
  buffer.writeUInt32LE(ncmds - 1, 16)
  buffer.writeUInt32LE(sizeofcmds - found.size, 20)
  // Shift the bytes after the removed command left over it, then zero the
  // exact vacated range [oldEnd - found.size, oldEnd). The zero range must be
  // computed independently of the shift: when the removed command is the LAST
  // one (our case — we always append), the shifted span is empty and only an
  // explicit zero of [found.offset, oldEnd) would do; overlapping zero ranges
  // must never cover the shifted data.
  buffer.copy(buffer, found.offset, found.offset + found.size, oldEnd)
  buffer.fill(0, oldEnd - found.size, oldEnd)
  writeFileSync(path, buffer)
  resignAdhoc(path)
  return 'removed'
}

if (import.meta.main) {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('usage: bun scripts/colaw-webview-unlock.ts </path/to/Colaw.app>')
    process.exit(1)
  }
  applyWebviewUnlockSync(target)
}
