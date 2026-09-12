/**
 * The LOCAL one-shot stable packaging chain: everything CI's colaw-release
 * workflow does on a macOS arm64 runner, in the same order, ending with a
 * freshly cleared build/stable-macos-arm64 that holds a DIRECTLY RUNNABLE
 * Colaw.app and the official Colaw.dmg.
 *
 * Stages (mirroring .github/workflows/colaw-release.yml):
 *   1. scripts/pack-stable-app.ts — the product closure; publishes
 *      build/stable-macos-arm64/Colaw.app (wiping the directory first) and
 *      stages that runnable app under COLAW_PACK_STAGING.
 *   2. `electrobun build --env=stable` — the OFFICIAL release identity: the
 *      shell, version.json hash, and the release artifact set under
 *      apps/electrobun-host/artifacts/ (DMG, tar.zst, update.json). This
 *      step replaces the directory's app with the DISTRIBUTION form — a
 *      self-extracting launcher over a hash-named Resources/<hash>.tar.zst
 *      payload — which is right inside the DMG but wrong for direct local
 *      use: the launcher shows its extraction window whenever the payload
 *      hash changed since the last launch, and every repack changes it.
 *   3. Restore the staged stage-1 app over the directory's copy, so
 *      build/stable-macos-arm64/Colaw.app is the full-payload,
 *      launch-without-extraction form again.
 *   4. scripts/build-dmg.ts — copies the official drag-to-Applications DMG
 *      beside it as build/stable-macos-arm64/Colaw.dmg. The DMG keeps the
 *      official self-extracting app: that form is the one the updater and
 *      fresh installs expect.
 *
 * Remote isolation: COLAW_UPDATE_BASE_URL stays unset unless the caller
 * exports it, so a local build bakes an empty update feed (version.json
 * baseUrl ""), never reads or writes the GitHub release assets, and computes
 * no delta patches — the repository's CI release flow owns the published
 * feed. Export COLAW_UPDATE_BASE_URL explicitly to bake a real feed into a
 * local build.
 *
 * Bun only, by fork policy (every child is the Bun binary running a JS
 * entry; see scripts/pack-stable-app.ts for the same guard).
 *
 * Usage: `bun scripts/pack-stable-release.ts`
 * @module scripts/pack-stable-release
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hostDir = join(repoRoot, 'apps', 'electrobun-host')
const stableDir = join(hostDir, 'build', 'stable-macos-arm64')

if ((globalThis as { Bun?: object }).Bun === undefined) {
  console.error('pack-stable-release: bun only — run as `bun scripts/pack-stable-release.ts` (never node/tsx)')
  process.exit(1)
}

/** Local staging root the packer fills and the official build's hook merges. */
const PACK_STAGING = process.env.COLAW_PACK_STAGING ?? '/tmp/pack-staging'

function run(label: string, command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): void {
  console.log(`pack-stable-release: ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: environment })
  if (result.status !== 0) {
    console.error(`pack-stable-release: ${label} exited ${String(result.status)}`)
    process.exit(1)
  }
}

/** The two artifacts this chain exists to produce, with sizes. */
function report(): void {
  for (const name of ['Colaw.app', 'Colaw.dmg']) {
    const path = join(stableDir, name)
    if (!existsSync(path)) {
      console.error(`pack-stable-release: expected artifact missing: ${path}`)
      process.exit(1)
    }
  }
  if (!existsSync(join(stableDir, 'Colaw.app', 'Contents', 'Resources', 'main.js'))) {
    console.error('pack-stable-release: directory app is not the directly runnable form (Resources/main.js missing)')
    process.exit(1)
  }
  const entries = readdirSync(stableDir).filter(name => name !== '.DS_Store')
  console.log(`pack-stable-release: ${stableDir}`)
  for (const name of entries) {
    const stat = statSync(join(stableDir, name))
    console.log(`  ${stat.isDirectory() ? 'dir ' : 'file'} ${name}${stat.isDirectory() ? '' : ` (${Math.round(stat.size / 1024 / 1024)} MiB)`}`)
  }
}

const environment: NodeJS.ProcessEnv = { ...process.env, COLAW_PACK_STAGING: PACK_STAGING }
const stagedApp = join(PACK_STAGING, 'Colaw.app')

run(
  'stage 1/4 — product closure (pack-stable-app)',
  process.execPath,
  ['scripts/pack-stable-app.ts'],
  repoRoot,
  environment,
)
run(
  'stage 2/4 — official stable identity (electrobun build --env=stable)',
  process.execPath,
  [join('.', 'node_modules', 'electrobun', 'bin', 'electrobun.cjs'), 'build', '--env=stable'],
  hostDir,
  environment,
)

// The official build just replaced the directory app with the
// self-extracting distribution form; restore the runnable staged copy so the
// local artifact opens with no extraction step.
console.log('pack-stable-release: stage 3/4 — restore the directly runnable app over the directory copy')
if (!existsSync(join(stagedApp, 'Contents', 'Resources', 'app'))) {
  console.error(`pack-stable-release: staged runnable app missing: ${stagedApp}`)
  process.exit(1)
}
rmSync(join(stableDir, 'Colaw.app'), { recursive: true, force: true })
cpSync(stagedApp, join(stableDir, 'Colaw.app'), { recursive: true })

run(
  'stage 4/4 — stage the install image (build-dmg)',
  process.execPath,
  ['scripts/build-dmg.ts'],
  repoRoot,
  environment,
)

report()
