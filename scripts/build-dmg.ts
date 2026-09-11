/**
 * Build the distributable COLAW <version>-arm64.dmg: ad-hoc sign the stable
 * app, assemble a volume whose Finder window is the drag-to-Applications
 * installer (COLAW watermark background, positioned icons), convert to
 * compressed read-only, and sign the image. Electrobun does not provide a DMG
 * builder, so this is the standard hdiutil + Finder-AppleScript flow.
 *
 * Usage: bun scripts/build-dmg.ts   (expects the stable app already packed)
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.cwd()
const app = join(repo, 'apps/electrobun-host/build/stable-macos-arm64/Colaw.app')
if (!existsSync(app)) { console.error('stable app missing — run pnpm run build:app:stable'); process.exit(1) }
type SyncResult = { exitCode: number | null; stdout: Uint8Array }
const sh = (cmd: string, args: string[]): SyncResult =>
  (globalThis as unknown as { Bun: { spawnSync: (c: string[], o?: object) => SyncResult } }).Bun
    .spawnSync([cmd, ...args], { stdout: 'pipe', stderr: 'inherit' })
const Bun_spawn_ignore = (cmd: string, args: string[]): void =>
  (globalThis as unknown as { Bun: { spawnSync: (c: string[], o?: object) => unknown } }).Bun.spawnSync([cmd, ...args])
const spawn = (cmd: string, args: string[]): void => {
  const r = sh(cmd, args)
  if (r.exitCode !== 0 && cmd !== '/usr/bin/hdiutil') { console.error(`${cmd} exited ${String(r.exitCode)}`); process.exit(1) }
}
const version = (JSON.parse(readFileSync(join(app, 'Contents/Resources/version.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
const name = `COLAW ${version}-arm64` // volume label keeps the versioned name
const dist = join(repo, 'apps/electrobun-host/build/stable-macos-arm64')
const stage = join(dist, `${name}-stage`)
const raw = join(dist, `${name}.rw.dmg`)
const final = join(dist, "Colaw.dmg")
// A leftover mount of a previous run (the volume is named identically) makes
// every later step race a busy disk — detach it before touching dist.
const mounted = sh('/usr/bin/hdiutil', ['info', '-plist'])
const mountedText = new TextDecoder().decode(mounted.stdout)
const mountMatch = mountedText.match(new RegExp(`<string>/Volumes/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`))
if (mountMatch !== null) {
  const devNode = mountedText.slice(0, mountMatch.index).match(/\/dev\/disk\d+(s\d+)?(?!.*\/dev\/disk)/s)
  if (devNode !== null) {
    spawn('/usr/bin/hdiutil', ['detach', devNode[0], '-force'])
  }
}
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, '.background'), { recursive: true })

console.log('rendering the installer background…')
spawn('/usr/bin/swift', [join(repo, 'scripts/dmg-background.swift'), join(stage, '.background', 'bg.png')])
copyFileSync(join(app, 'Contents/Resources/AppIcon.icns'), join(stage, '.VolumeIcon.icns'))

// The drop target MUST be the symlink to /Applications: a real folder on
// this read-only volume makes the drag a same-volume move — Finder shows the
// no-entry cursor and the drop silently does nothing.
const applicationsLink = join(stage, 'Applications')
rmSync(applicationsLink, { recursive: true, force: true })
spawn('/bin/ln', ['-s', '/Applications', applicationsLink])
if (!lstatSync(applicationsLink).isSymbolicLink()) {
  console.error('Applications link was not created as a symlink')
  process.exit(1)
}
spawn('/bin/cp', ['-R', app, join(stage, 'Colaw.app')])
// The runtime writes a resource-fork custom icon into the running app
// (setBundleIcon); a sealed bundle must not carry one, so the staged copy is
// stripped and signed — the original app on disk is never touched.
const stagedApp = join(stage, 'Colaw.app')
spawn('/usr/bin/xattr', ['-cr', stagedApp])
console.log('ad-hoc signing the staged app…')
spawn('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp])
spawn('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp])

console.log('creating the volume…')
spawn('/usr/bin/hdiutil', ['create', '-volname', name, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', '-size', '400m', raw])
spawn('/usr/bin/hdiutil', ['attach', raw, '-mountpoint', `/Volumes/${name}`, '-nobrowse'])
console.log('arranging the installer window…')
spawn('/usr/bin/osascript', ['-e', `tell application "Finder"
  tell disk "${name}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {300, 300, 760, 660}
    set viewOptions to icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set background picture of viewOptions to (POSIX file "/Volumes/${name}/.background/bg.png")
    set position of item "Colaw.app" to {135, 190}
    set position of item "Applications" to {330, 190}
    close
    open
  end tell
end tell`])
spawn('/bin/sleep', ['2'])
spawn('/bin/sleep', ['1'])
// First detach normally succeeds; the retry is best-effort (a race here must
// not fail the build after the image is already usable).
spawn('/usr/bin/hdiutil', ['detach', `/Volumes/${name}`, '-force'])
spawn('/usr/bin/hdiutil', ['detach', `/Volumes/${name}`, '-force'])
// The Finder-arrange leaves stale diskimage helper processes holding the
// unmount; they make the convert below fail with "resource temporarily
// unavailable" until killed.
Bun_spawn_ignore('/usr/bin/pkill', ['-9', '-f', 'diskimage'])
spawn('/bin/sleep', ['1'])
console.log('converting to read-only…')
rmSync(final, { force: true })
spawn('/usr/bin/hdiutil', ['convert', raw, '-format', 'UDZO', '-o', final.replace(/\.dmg$/, '.tmp.dmg')])
spawn('/bin/mv', [final.replace(/\.dmg$/, '.tmp.dmg'), final])
spawn('/usr/bin/codesign', ['--force', '--sign', '-', final])
rmSync(raw, { force: true }); rmSync(stage, { recursive: true, force: true })
console.log(`published ${final}`)
