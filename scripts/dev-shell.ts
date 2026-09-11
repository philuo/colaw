/**
 * Shell dev watcher: rebuilds the Electrobun dev app and restarts it whenever
 * the desktop shell's own sources change.
 *
 * The shell — window, native chrome, boot composition, and this watcher's
 * sibling the dev-web watcher — cannot hot-swap in the way client plugins do
 * (the client-hmr chain swaps browser plugin bundles in place; the shell owns
 * the process those bundles run in), so its edit loop is compile-and-restart.
 * This script makes that loop automatic: save → graceful quit → `electrobun
 * build` → relaunch, keeping the developer's edit-see-fix cycle to a few
 * seconds without any manual packaging.
 *
 * Bun only, by fork policy (see scripts/dev-web.ts for the same guard). Watch
 * targets are the shell's sources and its build inputs; the frontend plugin
 * tree is deliberately NOT watched here — those edits ride the client-hmr
 * chain (`pnpm run dev:web`, auto-started by the dev app itself) and must not
 * trigger a full app restart.
 *
 * Usage: `bun scripts/dev-shell.ts` from the repository root.
 * @module scripts/dev-shell
 */
import { existsSync, watch } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const hostDir = join(repoRoot, 'apps', 'electrobun-host')
const launcher = join(hostDir, 'build', 'dev-macos-arm64', 'Colaw-dev.app', 'Contents', 'MacOS', 'launcher')
const electrobunCli = join(hostDir, 'node_modules', 'electrobun', 'bin', 'electrobun.cjs')

/** Watch roots, relative to the host package: everything the build consumes. */
const WATCH_TARGETS = ['src', 'config', 'electrobun.config.ts']

/** Coalesce a burst of editor writes (or a branch switch) into one rebuild. */
const DEBOUNCE_MS = 400

/** Grace time for the app's own teardown after a quit request. */
const QUIT_WAIT_MS = 4_000

if ((globalThis as { Bun?: object }).Bun === undefined) {
  console.error('dev-shell: bun only — run as `bun scripts/dev-shell.ts` (never node/tsx)')
  process.exit(1)
}
if (!existsSync(launcher)) {
  console.error(`dev-shell: no dev app at ${launcher} — run one initial build first (cd apps/electrobun-host && ./node_modules/.bin/electrobun build)`)
  process.exit(1)
}

let rebuilding = false
let pending = false

/** Quit a running dev app, then hard-stop anything the graceful quit missed. */
async function stopApp(): Promise<void> {
  await execa('osascript', ['-e', 'tell application "Colaw-dev" to quit'], { reject: false, timeout: QUIT_WAIT_MS })
  const deadline = Date.now() + QUIT_WAIT_MS
  while (Date.now() < deadline && isAppRunning()) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  }
  if (isAppRunning()) {
    spawnSync('pkill', ['-9', '-f', 'Colaw-dev.app/Contents/MacOS'])
  }
}

/** True while any Colaw-dev process (launcher or Bun main) is still alive. */
function isAppRunning(): boolean {
  return spawnSync('pgrep', ['-f', 'Colaw-dev.app/Contents/MacOS']).status === 0
}

/** Rebuild the dev app bundle and relaunch it detached from this watcher. */
async function rebuildAndRestart(): Promise<void> {
  console.log('dev-shell: change detected — rebuilding the shell…')
  await stopApp()
  const build = await execa(process.execPath, [electrobunCli, 'build'], { cwd: hostDir, reject: false })
  if (build.exitCode !== 0) {
    console.error(`dev-shell: build failed (code ${String(build.exitCode)}); fix the error and save to retry`)
    console.error(build.stderr)
    return
  }
  // node:child_process spawn, not execa: the launcher must outlive this
  // watcher (detached), and execa's Bun-facing result promise exposes no
  // unref to detach it with.
  const child = spawn(launcher, [], { detached: true, stdio: 'ignore' })
  child.unref()
  console.log('dev-shell: rebuilt and relaunched')
}

/** Queue one rebuild-and-restart; bursts collapse into a single cycle. */
function requestRestart(): void {
  if (rebuilding) {
    pending = true
    return
  }
  rebuilding = true
  void rebuildAndRestart().catch((error: unknown) => {
    console.error('dev-shell: rebuild-and-restart cycle failed:', error)
  }).finally(() => {
    rebuilding = false
    if (pending) {
      pending = false
      requestRestart()
    }
  })
}

/** Collapse an editor's multi-file save burst into one debounce window. */
let debounceTimer: ReturnType<typeof setTimeout> | undefined
function scheduleRestart(): void {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    requestRestart()
  }, DEBOUNCE_MS)
}

for (const target of WATCH_TARGETS) {
  const targetPath = join(hostDir, target)
  if (!existsSync(targetPath)) continue
  watch(targetPath, { recursive: true }, () => { scheduleRestart() })
}

console.log(`dev-shell: watching ${WATCH_TARGETS.join(', ')} under ${hostDir}`)
console.log('dev-shell: save a shell source to rebuild and restart the dev app (Ctrl+C to stop watching)')
