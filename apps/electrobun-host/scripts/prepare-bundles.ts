/**
 * prepare-bundles.ts — build the self-contained bundle closure for the
 * Electrobun macOS arm64 app.
 *
 * The Cordis runtime loads profile bundles (`@deepseek-ai/dsh-base`,
 * `@deepseek-ai/dsh-web-app`) and their plugin dependencies dynamically by
 * package name at boot time, so the packaged app cannot rely on the repo's
 * node_modules. This script collects the *production* dependency closure of
 * the web profile bundle set and lays it out flat under
 * `.bundle-staging/node_modules`, where the packaged main process's
 * installAnchor can resolve it.
 *
 * Only `dependencies`, `peerDependencies` and `optionalDependencies` are
 * followed — devDependencies (mermaid, oxlint, lefthook, ...) never enter the
 * closure.
 *
 * Bun only. No Node.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_ROOT = dirname(dirname(fileURLToPath(import.meta.url))) // apps/electrobun-host
const REPO_ROOT = dirname(dirname(HOST_ROOT)) // deepseek-harness repo
const STAGING = join(HOST_ROOT, '.bundle-staging')

/** Web profile bundles, per packages/boot/app-boot/src/profile.ts PROFILE_TEMPLATES.web */
const ROOT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.hutch', '.bundle-staging', 'dist-test'])

/** Copyable file/dir names inside a package directory. Everything the package
 * ships that Node can load or read: package.json, lib, dist, config, bin... */
const PACKAGE_KEEP = new Set(['package.json', 'lib', 'dist', 'config', 'bin', 'src', 'types', 'README.md', 'README.zh.md', 'cordis.patch.yml', 'res', 'assets', 'public', 'scripts'])

interface PkgRecord {
  name: string
  dir: string // real (resolved) package directory in the repo node_modules
  version: string
}

/** name -> real workspace directory, built from the pnpm workspace layout. */
function buildWorkspaceMap(): Map<string, string> {
  const map = new Map<string, string>()
  const roots = ['packages', 'apps', 'vendor']
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        const pj = join(full, 'package.json')
        if (existsSync(pj)) {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'))
          if (typeof pkg.name === 'string') map.set(pkg.name, realpathSync(full))
        }
        walk(full)
      }
    }
  }
  for (const root of roots) if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root))
  return map
}

const WORKSPACE_MAP = buildWorkspaceMap()

/** Resolve a package directory from the repo, mirroring Node resolution. */
function resolveRepoPackage(name: string, fromDir: string): string | undefined {
  if (WORKSPACE_MAP.has(name)) return WORKSPACE_MAP.get(name)
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readPackage(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function collectClosure(): Map<string, PkgRecord> {
  const closure = new Map<string, PkgRecord>()
  const queue: Array<{ name: string; fromDir: string }> = ROOT_BUNDLES.map(name => ({ name, fromDir: REPO_ROOT }))

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift()!
    if (closure.has(name)) continue
    const dir = resolveRepoPackage(name, fromDir)
    if (dir === undefined) {
      console.error(`[prepare-bundles] FATAL: cannot resolve ${name} from ${fromDir}`)
      process.exit(1)
    }
    const pkg = readPackage(dir)
    const realDir = realpathSync(dir)
    closure.set(name, { name, dir: realDir, version: pkg.version ?? '0.0.0' })
    const deps = { ...(pkg.dependencies ?? {}) }
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}))
    const peerOptional = new Set(
      Object.entries(pkg.peerDependenciesMeta ?? {})
        .filter(([, meta]) => (meta as any)?.optional === true)
        .map(([name]) => name),
    )
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
      if (peerOptional.has(dep)) continue // optional peers are resolved below with the same skip rule
      deps[dep] = (pkg.peerDependencies as Record<string, string>)[dep]
    }
    for (const dep of Object.keys(deps)) {
      queue.push({ name: dep, fromDir: realDir })
    }
    for (const dep of optional) {
      if (resolveRepoPackage(dep, realDir) !== undefined) {
        queue.push({ name: dep, fromDir: realDir })
      } else {
        // optionalDependencies that were never installed for this platform
        // (e.g. @img/sharp-darwin-x64 on arm64) may be omitted.
        console.warn(`[prepare-bundles] skip optional dep ${dep} (not installed on this platform)`)
      }
    }
    for (const dep of peerOptional) {
      if (resolveRepoPackage(dep, realDir) !== undefined) {
        queue.push({ name: dep, fromDir: realDir })
      } else {
        console.warn(`[prepare-bundles] skip optional peer ${dep} (not installed)`)
      }
    }
  }
  return closure
}

/** Copy one package's loadable files from the repo to the staging layout.
 * Every entry is copied except nested node_modules (the layout is flat). */
function copyPackage(pkg: PkgRecord, stagingModules: string): void {
  const targetDir = join(stagingModules, pkg.name)
  mkdirSync(targetDir, { recursive: true })
  const entries = readdirSync(pkg.dir)
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const src = join(pkg.dir, entry)
    const dst = join(targetDir, entry)
    if (existsSync(dst)) continue
    if (lstatSync(src).isSymbolicLink() || lstatSync(src).isFile()) {
      cpSync(src, dst, { recursive: true, force: true })
    } else {
      copyTreeSkipNodeModules(src, dst)
    }
  }
}

/** Recursive copy that skips any nested node_modules (keeps the layout flat). */
function copyTreeSkipNodeModules(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    if (entry === 'node_modules') continue
    const src = join(srcDir, entry)
    const dst = join(dstDir, entry)
    const st = lstatSync(src)
    if (st.isSymbolicLink()) {
      cpSync(src, dst, { recursive: true })
    } else if (st.isDirectory()) {
      copyTreeSkipNodeModules(src, dst)
    } else {
      cpSync(src, dst, { force: true })
    }
  }
}

/** Verify every closure package resolves from the staging root. */
function verifyClosure(stagingModules: string, closure: Map<string, PkgRecord>): void {
  const missing: string[] = []
  for (const name of closure.keys()) {
    if (!existsSync(join(stagingModules, name, 'package.json'))) missing.push(name)
  }
  if (missing.length > 0) {
    console.error(`[prepare-bundles] FATAL: staging closure missing ${missing.length} packages:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
  // Spot-check that each package still has its main entry loadable by Bun.
  let checked = 0
  const entryCandidates = (entry: string): string[] => {
    if (/\.(?:js|cjs|mjs|json|node)$/.test(entry)) return [entry]
    return [entry, `${entry}.js`, `${entry}.cjs`, `${entry}.mjs`, `${entry}.json`, `${entry}.node`]
  }
  for (const pkg of closure.values()) {
    const main = join(stagingModules, pkg.name, 'package.json')
    const meta = JSON.parse(readFileSync(main, 'utf8'))
    const entry = meta.main ?? meta.exports?.import ?? meta.exports?.require
    if (typeof entry === 'string' && !entryCandidates(entry).some(c => existsSync(join(stagingModules, pkg.name, c)))) {
      console.warn(`[prepare-bundles] WARN ${pkg.name}: declared entry ${entry} missing in staging`)
    } else {
      checked++
    }
  }
  console.log(`[prepare-bundles] closure verified: ${closure.size} packages, ${checked} entries present`)
}

function main(): void {
  console.log(`[prepare-bundles] roots: ${ROOT_BUNDLES.join(', ')}`)
  const t0 = Date.now()
  const closure = collectClosure()
  console.log(`[prepare-bundles] closure size: ${closure.size} packages (${Date.now() - t0}ms)`)

  rmSync(STAGING, { recursive: true, force: true })
  const stagingModules = join(STAGING, 'node_modules')
  mkdirSync(stagingModules, { recursive: true })

  for (const pkg of closure.values()) {
    copyPackage(pkg, stagingModules)
  }

  // Anchor package.json for the packaged installAnchor resolution.
  writeFileSync(
    join(STAGING, 'package.json'),
    JSON.stringify({ name: 'dsh-electrobun-bundles', version: '0.0.0', private: true }, null, 2),
  )

  verifyClosure(stagingModules, closure)

  const sizeMB = Math.round((du(STAGING) / 1024 / 1024) * 10) / 10
  console.log(`[prepare-bundles] staged ${closure.size} packages -> ${STAGING} (${sizeMB}MB, ${Date.now() - t0}ms)`)
}

function du(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = lstatSync(full)
    if (st.isDirectory()) total += du(full)
    else total += st.size
  }
  return total
}

main()
