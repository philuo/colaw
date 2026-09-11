/**
 * Watch-build for the web dev loop: rebuilds every artifact the browser reads
 * from a source edit. Reload signaling is not this script's business — the host
 * webserver stat-polls the bundles it serves and broadcasts `rebuilt` frames
 * itself (`dsh web`), so any process that rewrites `lib/client.js` files
 * triggers reloads; this script is merely the convenient way to keep them all
 * rebuilt on source change.
 *
 * Three stages, because the compile shell links built lib products rather than
 * sources: `tsc -b tsconfig.client.json` emits `lib/types` (the tsdown lib
 * entries are that emit, not `src`), tsdown bundles `lib/index.js` and
 * `lib/client.js`, and `vite build` rewrites `apps/web/dist`, which `dsh web`
 * serves. A missing stage does not fail — it silently shows the previous
 * artifact, so an edit appears to do nothing.
 *
 * MUST NOT run concurrently with `pnpm run build`: both write the same
 * `lib/` and `apps/web/dist/` trees.
 *
 * Usage: `bun scripts/dev-web.ts [--poll[=ms]]` — Bun only. Requires one prior
 * `pnpm run build`: every stage is incremental over the previous stage's output
 * and none of them bootstraps a missing tree. `--poll` switches the source
 * watchers to polling (default 500ms): network mounts (weka) deliver no inotify
 * events, so native watching sees the initial build only and never a source
 * change. Polling has to reach tsc too — a native-watching tsc never re-emits
 * `lib/types`, which strands the other two stages on stale input.
 *
 * Each package keeps its own tsdown.config.ts untouched: this script layers
 * `watch` through API-level inline config (tsdown workspace mode fills inline
 * keys under each package's file config, and no package config defines it).
 */
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { build } from 'tsdown'
import type { TsdownBundle } from 'tsdown'
import {
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
} from './client-build-environment.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Client-face type emit feeding every tsdown lib entry in the watch set. */
const CLIENT_TYPE_PROGRAM = 'tsconfig.client.json'

/** Compile-shell workspace whose dist `dsh web` serves. */
const SHELL_PACKAGE = '@deepseek-ai/dsh-web-frontend'

/**
 * Test infrastructure builds through the client preset but never enters the
 * shell's module graph, so it is not a dev-loop artifact.
 */
const TEST_INFRASTRUCTURE_PREFIX = 'packages/test-support/'

/**
 * Sample one local public environment for every long-lived watcher stage.
 * @param root - repository root supplying version and Git metadata.
 * @param environment - watcher launch environment supplying public extensions.
 * @returns process environment shared by tsdown and spawned watcher stages.
 */
export function devWebBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return clientBuildProcessEnvironment(environment, repositoryClientBuildEnvironment(root, environment))
}

/**
 * Discover the watch workspace by declaration: every packages/<group>/<name>
 * whose package.json carries `dsh.client` with platform "web" is a client
 * plugin bundle emitter. Scanned once at startup — a package added while
 * watching means restarting this script.
 * @param root - repository root containing the grouped package directories.
 * @returns workspace-relative plugin package directories.
 */
export function discoverPluginDirs(root = repoRoot): string[] {
  const dirs: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      dsh?: { client?: { platform?: unknown } }
    }
    if (manifest.dsh?.client?.platform === 'web') dirs.push(dirname(manifestPath).split(sep).join('/'))
  }
  return dirs
}

/**
 * Discover the statically linked library packages: the other half of the same
 * partition {@link discoverPluginDirs} takes. A package that builds through the
 * client preset without declaring `dsh.client` has no loader-delivered browser
 * half, so the compile shell links its `lib/index.js` instead — and an edit to
 * its source reaches the browser only once that bundle is rewritten. Deriving
 * the set from the build preset rather than a hand list keeps it correct when
 * dependency sections move around; deriving it from `dependencies` would not,
 * because client packages declare their build inputs as devDependencies.
 * @param root - repository root containing the grouped package directories.
 * @returns workspace-relative library package directories.
 */
export function discoverLibraryDirs(root = repoRoot): string[] {
  const dirs: string[] = []
  for (const configPath of globSync('packages/*/*/tsdown.config.ts', { cwd: root }).sort()) {
    const dir = dirname(configPath).split(sep).join('/')
    if (dir.startsWith(TEST_INFRASTRUCTURE_PREFIX)) continue
    if (!readFileSync(join(root, configPath), 'utf8').includes('tsdown.client.ts')) continue
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
      dsh?: { client?: unknown }
    }
    if (manifest.dsh?.client === undefined) dirs.push(dir)
  }
  return dirs
}

/**
 * Start the tsdown watch build used by `pnpm run dev:web`.
 * @param root - repository or fixture root passed to tsdown.
 * @param pluginDirs - workspace-relative package directories to watch.
 * @param pollInterval - optional source-watcher polling interval in milliseconds.
 * @returns live bundles after every watcher has completed its initial build.
 */
export async function watchClientPlugins(
  root: string,
  pluginDirs: readonly string[],
  pollInterval?: number,
): Promise<TsdownBundle[]> {
  let resolveInitialBuilds: (() => void) | undefined
  const initialBuilds = new Promise<void>((resolve) => { resolveInitialBuilds = resolve })
  const initialized = new WeakSet<object>()
  const readiness: { expectedBuilds?: number; initializedBuilds: number } = { initializedBuilds: 0 }
  const bundles = await build({
    cwd: root,
    workspace: [...pluginDirs],
    watch: true,
    hooks: {
      'build:done': ({ options }) => {
        if (initialized.has(options)) return
        initialized.add(options)
        readiness.initializedBuilds += 1
        if (
          readiness.expectedBuilds !== undefined
          && readiness.initializedBuilds >= readiness.expectedBuilds
        ) resolveInitialBuilds?.()
      },
    },
    ...pollInterval !== undefined
      ? { inputOptions: { watch: { watcher: { usePolling: true, pollInterval } } } }
      : {},
  })
  readiness.expectedBuilds = bundles.length
  if (readiness.initializedBuilds >= readiness.expectedBuilds) resolveInitialBuilds?.()
  await initialBuilds
  return bundles
}

/**
 * Live watcher processes to terminate when this script is interrupted. Stages
 * register themselves as they start, so the set is complete from the first
 * spawn: an interrupt during a later stage's startup still tears down the
 * earlier ones instead of orphaning them.
 */
const stages: StageHandle[] = []

/**
 * Terminate every registered stage. Each stage leads its own process group, so
 * a group signal reaches the whole descendant tree (`pnpm run watch` and the
 * vite process it spawns); killing the direct child alone orphans grandchildren,
 * which then hold the served artifacts open against the next watcher's builds.
 */
function stopStages(): void {
  for (const stage of stages) stage.kill()
}

/**
 * Spawn one watcher stage, inheriting stdio, registering it for teardown, and
 * failing loud if it ever exits: a dead stage leaves the artifact chain silently
 * stale, which reads as "my edit did nothing" — the one failure this script
 * exists to prevent. Every stage runs under Bun (this fork's only runtime): a
 * command that is itself a JS entry is executed by Bun directly, never through
 * a `#!/usr/bin/env node` bin shim.
 * @param stage - command label used in the exit diagnostic.
 * @param cmd - argv to spawn; argv[0] is the Bun binary.
 * @param cwd - working directory for the stage; defaults to the repo root.
 */
function spawnStage(stage: string, cmd: readonly string[], cwd: string = repoRoot): void {
  // Detached: the stage leads its own process group (see stopStages).
  const child = execa(cmd[0]!, [...cmd.slice(1)], {
    cwd,
    stdio: 'inherit',
    reject: false,
    detached: true,
  })
  const pid = child.pid
  stages.push({
    kill: () => {
      if (pid === undefined) return
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // The group is already gone.
        child.kill()
      }
    },
  })
  void child.then((result) => {
    console.error(`dev-web: ${stage} exited (code ${String(result.exitCode)}); the artifact chain is now stale`)
    // A dead stage means a stale chain either way; stopping the sibling stages
    // before exiting keeps this script's death from leaking running watchers.
    // Signalling this stage's own (already dead) group is harmless.
    stopStages()
    process.exit(1)
  })
}

/** The only capability this script needs from a live watcher process. */
interface StageHandle {
  readonly kill: () => void
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  // Bun only, by fork policy: the stages below are Bun's own binary executing
  // JS entries directly. Under Node the entry either crashes (tsx's module
  // hooks on Node 24) or silently re-introduces node-shebang children.
  const bun = (globalThis as { Bun?: { readonly version: string } }).Bun
  if (bun === undefined) {
    console.error('dev-web: bun only — run as `bun scripts/dev-web.ts --poll` (never node/tsx)')
    process.exit(1)
  }
  const buildEnvironment = devWebBuildEnvironment(repoRoot, process.env)
  for (const name of Object.keys(process.env)) {
    if (name === CLIENT_BUILD_PROFILE_SELECTOR || name.startsWith('DSH_CLIENT_')) {
      Reflect.deleteProperty(process.env, name)
    }
  }
  for (const [name, value] of Object.entries(buildEnvironment)) {
    if (name.startsWith('DSH_CLIENT_') && value !== undefined) process.env[name] = value
  }

  const pluginDirs = discoverPluginDirs()
  const libraryDirs = discoverLibraryDirs()
  if (pluginDirs.length === 0) {
    console.error('dev-web: no dsh.client (platform "web") packages found under packages/')
    process.exit(1)
  }
  if (libraryDirs.length === 0) {
    console.error('dev-web: no client-preset library packages found under packages/ — the compile shell links their lib products, so an empty set means the discovery predicate is stale')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const pollArg = args.find(a => a === '--poll' || a.startsWith('--poll='))
  if (args.some(a => a !== pollArg)) {
    console.error('dev-web: usage: bun scripts/dev-web.ts [--poll[=ms]]')
    process.exit(1)
  }
  const pollInterval = pollArg === undefined ? undefined : Number(pollArg.split('=')[1] ?? '500')
  if (pollInterval !== undefined && (!Number.isInteger(pollInterval) || pollInterval <= 0)) {
    console.error(`dev-web: invalid --poll interval "${pollArg ?? ''}"`)
    process.exit(1)
  }

  // Registered before any stage starts: `stages` is read at signal time, so an
  // interrupt during tsdown's initial builds still kills whatever is running.
  process.once('SIGINT', stopStages)
  process.once('SIGTERM', stopStages)

  // Supervised runs (the Electrobun dev app) must die with their parent: a GUI
  // quit can terminate the host without any signal this process would see, and
  // an orphaned watcher keeps rewriting artifacts nobody serves. A dead parent
  // reparents this process, so polling ppid is the exact check.
  const supervisorPid = Number(process.env.DSH_SUPERVISOR_PID)
  if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
    const orphanWatch = setInterval(() => {
      if (process.ppid !== supervisorPid) {
        clearInterval(orphanWatch)
        stopStages()
        process.exit(0)
      }
    }, 2_000)
  }

  // tsc has no polling interval flag, so `--poll` selects its fixed-interval
  // watchers rather than an interval. Dropping that translation leaves tsc
  // natively watching on a network mount where inotify never fires: it stops
  // re-emitting lib/types, and the two later stages then rebuild forever from
  // stale input without printing anything. Bun executes TypeScript's JS entry
  // directly — the node-shebang bin shim is exactly what this fork forbids.
  spawnStage(`tsc -b ${CLIENT_TYPE_PROGRAM} --watch`, [
    process.execPath, join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-b', CLIENT_TYPE_PROGRAM, '--watch', '--preserveWatchOutput',
    ...pollInterval !== undefined
      ? ['--watchFile', 'fixedPollingInterval', '--watchDirectory', 'fixedPollingInterval']
      : [],
  ])

  // tsdown's initial builds are awaited before the dist watcher starts so vite's
  // first build reads current lib bundles rather than whatever the last full
  // build left. Its own watch then covers later lib rewrites — those files are
  // in its module graph.
  await watchClientPlugins(repoRoot, [...pluginDirs, ...libraryDirs], pollInterval)
  // Vite's JS entry is executed by Bun directly (no node bin shim), from the
  // shell package's own directory: the vite root is its working directory —
  // `resolve.dedupe` resolves react from that root, so running vite from
  // anywhere but apps/web silently switches which react copy the bundle gets.
  spawnStage('vite build --watch', [
    process.execPath, join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'),
    'build', '--watch', '--no-emptyOutDir',
  ], join(repoRoot, 'apps', 'web'))

  console.log(
    `dev-web: watching ${String(pluginDirs.length)} dsh.client plugin packages`
    + ` and ${String(libraryDirs.length)} statically linked library packages`
    + (pollInterval !== undefined ? ` (polling ${String(pollInterval)}ms)` : '')
    + `, plus tsc -b ${CLIENT_TYPE_PROGRAM} and the ${SHELL_PACKAGE} dist build:\n  `
    + [...pluginDirs, ...libraryDirs].join('\n  '),
  )
}
