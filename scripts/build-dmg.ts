/**
 * Stage the official Electrobun installer, restyled as Colaw's drag-to-
 * Applications window. Hutch's DMG stays the content source of truth — the
 * shipped Colaw.app must byte-match the official update chain — so this step
 * never touches the app inside: it re-opens the image read-write, adds the
 * volume's Finder presentation only (the COLAW watermark background and the
 * positioned icon row), and re-emits the compressed image under the stable
 * release filename.
 *
 * Usage: bun scripts/build-dmg.ts
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.cwd()
const source = join(repo, 'apps/electrobun-host/artifacts/macos-arm64-Colaw.dmg')
const destination = join(repo, 'apps/electrobun-host/build/stable-macos-arm64/Colaw.dmg')
const work = join(repo, 'apps/electrobun-host/build/stable-macos-arm64/colaw-restyle.rw.dmg')
const volume = 'Colaw'

if (!existsSync(source)) {
  console.error(`official Electrobun DMG missing: ${source}`)
  process.exit(1)
}
mkdirSync(join(repo, 'apps/electrobun-host/build/stable-macos-arm64'), { recursive: true })

type SyncResult = { exitCode: number | null; stdout: Uint8Array }
const sh = (cmd: string, args: readonly string[]): SyncResult =>
  (globalThis as unknown as { Bun: { spawnSync: (c: string[], o?: object) => SyncResult } }).Bun
    .spawnSync([cmd, ...args], { stdout: 'pipe', stderr: 'inherit' })
const must = (cmd: string, args: readonly string[]): void => {
  const result = sh(cmd, args)
  if (result.exitCode !== 0) {
    console.error(`${cmd} ${args.join(' ')} exited ${String(result.exitCode)}`)
    process.exit(1)
  }
}
const ignore = (cmd: string, args: readonly string[]): void => {
  (globalThis as unknown as { Bun: { spawnSync: (c: string[], o?: object) => unknown } }).Bun
    .spawnSync([cmd, ...args])
}
const sleep = (seconds: string): void => { must('/bin/sleep', [seconds]) }

// A leftover mount of any earlier styled run occupies the fixed mountpoint
// and makes the attach below race a busy disk; free it best-effort first.
ignore('/usr/bin/hdiutil', ['detach', `/Volumes/${volume}`, '-force'])

rmSync(work, { force: true })
console.log('re-opening the official image read-write…')
must('/usr/bin/hdiutil', ['convert', source, '-format', 'UDRW', '-o', work])
must('/usr/bin/hdiutil', ['attach', work, '-mountpoint', `/Volumes/${volume}`, '-nobrowse'])

console.log('rendering the installer background…')
must('/bin/mkdir', ['-p', `/Volumes/${volume}/.background`])
must('/usr/bin/swift', [join(repo, 'scripts/dmg-background.swift'), `/Volumes/${volume}/.background/bg.png`])

console.log('arranging the installer window…')
// Offscreen window, closed at the end, never re-opened: the arrangement
// lands in the volume's .DS_Store while nothing draws on the build machine's
// screen. (The classic open-close-open recipe re-opens the window to force
// Finder to commit view options; the offscreen bounds plus the update call
// commit them without any visible window.)
must('/usr/bin/osascript', ['-e', `tell application "Finder"
  tell disk "${volume}"
    open
    set bounds of container window to {-2200, -2200, -1740, -1855}
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set viewOptions to icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 54
    set background picture of viewOptions to (POSIX file "/Volumes/${volume}/.background/bg.png")
    set position of item "Colaw.app" to {70, 187}
    set position of item "Applications" to {312, 187}
    update without registering applications
    set bounds of container window to {300, 300, 760, 645}
    close
  end tell
end tell`])
sleep('2')
sleep('1')
// Finder sometimes ejects the volume itself while committing the window
// arrangement; only detach when it is still mounted, and never fail here —
// the convert below reads the image file either way.
const info = sh('/usr/bin/hdiutil', ['info', '-plist'])
if (new TextDecoder().decode(info.stdout).includes(`/Volumes/${volume}`)) {
  ignore('/usr/bin/hdiutil', ['detach', `/Volumes/${volume}`, '-force'])
  ignore('/usr/bin/pkill', ['-9', '-f', 'diskimage'])
  ignore('/usr/bin/hdiutil', ['detach', `/Volumes/${volume}`, '-force'])
}
sleep('1')

console.log('converting to the compressed image…')
rmSync(destination, { force: true })
must('/usr/bin/hdiutil', ['convert', work, '-format', 'ULFO', '-o', destination])
must('/usr/bin/codesign', ['--force', '--sign', '-', destination])
rmSync(work, { force: true })
console.log(`published ${destination}`)
