/**
 * The LOCAL one-shot stable packaging chain: everything CI's colaw-release
 * workflow does on a macOS arm64 runner, in the same order, ending with a
 * freshly cleared build/stable-macos-arm64 that holds the new Colaw.app and
 * Colaw.dmg.
 *
 * Stages (mirroring .github/workflows/colaw-release.yml exactly):
 *   1. scripts/pack-stable-app.ts — the product closure; publishes
 *      build/stable-macos-arm64/Colaw.app (wiping the directory first) and
 *      stages it under COLAW_PACK_STAGING.
 *   2. `electrobun build --env=stable` — the OFFICIAL release identity: the
 *      shell, version.json hash, and the release artifact set under
 *      apps/electrobun-host/artifacts/ (DMG, tar.zst, update.json).
 *   3. scripts/build-dmg.ts — copies the official drag-to-Applications DMG
 *      beside the app as build/stable-macos-arm64/Colaw.dmg.
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
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  const entries = readdirSync(stableDir).filter(name => name !== '.DS_Store')
  console.log(`pack-stable-release: ${stableDir}`)
  for (const name of entries) {
    const stat = statSync(join(stableDir, name))
    console.log(`  ${stat.isDirectory() ? 'dir ' : 'file'} ${name}${stat.isDirectory() ? '' : ` (${Math.round(stat.size / 1024 / 1024)} MiB)`}`)
  }
}

const environment: NodeJS.ProcessEnv = { ...process.env, COLAW_PACK_STAGING: PACK_STAGING }

run(
  'stage 1/3 — product closure (pack-stable-app)',
  process.execPath,
  ['scripts/pack-stable-app.ts'],
  repoRoot,
  environment,
)
run(
  'stage 2/3 — official stable identity (electrobun build --env=stable)',
  process.execPath,
  [join('.', 'node_modules', 'electrobun', 'bin', 'electrobun.cjs'), 'build', '--env=stable'],
  hostDir,
  environment,
)
run(
  'stage 3/3 — stage the install image (build-dmg)',
  process.execPath,
  ['scripts/build-dmg.ts'],
  repoRoot,
  environment,
)

report()
