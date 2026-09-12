/**
 * Build the self-contained, fully bundled stable desktop app.
 *
 * 1. Ensures the repository artifacts exist (host/client lib products, web
 *    frontend dist) and runs the Electrobun build (the app shell).
 * 2. Analyzes the runtime closure by composition, not by manifest graphs: the
 *    packer composes the exact entry list the shipped profile mounts (web
 *    template bundles + the Electrobun overlay), then walks the import graph
 *    of those entries and the host entry file through the built lib plane.
 *    Packages no mounted entry or scanned file reaches are never shipped.
 * 3. Bundles every closure package into one minified ESM file per reached
 *    entry point (Bun.build, tree-shaken, comments and whitespace stripped),
 *    with every cross-package import kept external so all packages share one
 *    module plane at `Resources/app/node_modules` — the single-instance
 *    guarantee cordis Symbol keys require.
 * 4. Replaces the Electrobun build's fully-inlined dev main with a bundle
 *    built against the same external plane, so host code and plugin code load
 *    one shared copy of cordis and every other library.
 * 5. Ships runtime data beside the code: each package's non-code files
 *    (bundle patch lists, presets, client browser bundles, the web frontend
 *    dist, native `.node` payloads), plus the install anchor manifest.
 * 6. Audits the artifact: no symlinks, no TypeScript or source maps under
 *    Resources/app, and every bare import of every emitted bundle resolves
 *    inside the app.
 *
 * Resolution is a manual node_modules walk, never Bun's resolver: Bun applies
 * tsconfig `paths` to every resolution style, which would silently flip the
 * analysis onto the src plane. Runtime file references the import scanner
 * cannot see (worker entrypoints addressed through
 * `new URL('./x', import.meta.url)`, packages located via `require.resolve`
 * string literals) are detected by scanning file text and shipped verbatim.
 *
 * Bun only, by fork policy.
 *
 * Usage: `bun scripts/pack-stable-app.ts [--skip-build]`
 * @module scripts/pack-stable-app
 */

import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, initProfile, loadOverlayPatches, loadProfileDirectory } from '../packages/boot/app-boot/src/index.ts'

/**
 * The Bun APIs this bun-only script uses, typed structurally: the repository
 * root face carries no @types/bun, so direct `Bun.*` references would be
 * unsafe-typed under the lint gate.
 */
const bun = (globalThis as unknown as { Bun: {
  build: (options: {
    entrypoints: readonly string[]
    target: 'bun' | 'browser'
    format: 'esm' | 'cjs'
    minify: boolean
    external: readonly string[]
    throw: boolean
  }) => Promise<{
    success: boolean
    logs: Iterable<unknown>
    outputs: readonly { kind: string; path: string; text: () => Promise<string> }[]
  }>
  Transpiler: new (options: { loader: 'ts' | 'js' }) => { scanImports: (code: string) => { path: string }[] }
} }).Bun

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hostDir = join(repoRoot, 'apps', 'electrobun-host')
/** The Hutch devkit projection backing every `electrobun/*` specifier. */
const devkitDir = join(hostDir, '.hutch', 'devkit')
const builtApp = join(hostDir, 'build', 'dev-macos-arm64', 'Colaw-dev.app')
const stableApp = join(hostDir, 'build', 'stable-macos-arm64', 'Colaw.app')
const appResourcesApp = join(stableApp, 'Contents', 'Resources', 'app')
const closureRoot = join(appResourcesApp, 'node_modules')
const installDir = join(appResourcesApp, 'install')
const hostEntry = join(hostDir, 'src', 'bun', 'index.ts')
const cliAnchor = join(repoRoot, 'apps', 'cli', 'package.json')

if ((globalThis as unknown as { Bun?: object }).Bun === undefined) {
  console.error('pack-stable-app: bun only')
  process.exit(1)
}

const skipBuild = process.argv.includes('--skip-build')

/** Concurrency for per-package bundle builds. */
const BUILD_POOL = 8

/** Legacy bare builtin specifiers npm packages still import. */
const LEGACY_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'console', 'constants', 'crypto',
  'diagnostics_channel', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
])

/** One bundled output file: a package entry point compiled to minified ESM. */
interface Unit {
  /** Package name owning the unit. */
  pkg: string
  /** Absolute source file (lib plane, or devkit TypeScript for electrobun). */
  src: string
  /** Output path relative to the package directory, extension normalized to .js. */
  outRel: string
  /**
   * Subpath the runtime imports this unit through when a wildcard export
   * produced it; the emitted manifest gains one exact key per such subpath.
   */
  specSubpath?: string
}

/** A file shipped byte-for-byte (minified when it is code) at its own path. */
interface VerbatimFile {
  pkg: string
  src: string
  outRel: string
}

/** Everything the analysis pass discovered. */
interface Closure {
  /** Every bare specifier any scanned file imports; the externals list. */
  specifiers: Set<string>
  /** Package name → real source directory (one per name or the build fails). */
  packages: Map<string, { dir: string; from: string }>
  /**
   * Package name → specifiers that resolved to a non-primary version from
   * that package's files; those imports are inlined into the package's own
   * bundle instead of staying external, so each importer keeps the version
   * its resolution found.
   */
  offPrimary: Map<string, Set<string>>
  /** Bundled entry-point units, keyed `pkg\0outRel`. */
  units: Map<string, Unit>
  /** Verbatim-shipped files, keyed `pkg\0outRel`. */
  verbatim: Map<string, VerbatimFile>
  /**
   * Bare specifiers no installed package satisfies (optional-dependency
   * fallbacks such as sharp's wasm32 build): kept external and never audited,
   * matching the resolution failure the repository install itself has.
   */
  unresolved: Set<string>
}

function isBuiltin(spec: string): boolean {
  const firstSegment = spec.split('/')[0] ?? spec
  return spec.startsWith('node:') || spec.startsWith('bun:') || LEGACY_BUILTINS.has(firstSegment)
}

function isBare(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('#') && !spec.startsWith('file:')
    && !spec.startsWith('cordis:') && !isBuiltin(spec)
}

/** The package-name root of a possibly-subpathed bare specifier. */
function packageRootName(spec: string): string {
  const segments = spec.split('/')
  return spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? spec
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  const result = (globalThis as unknown as { Bun: { spawnSync: (cmd: readonly string[], options: object) => { exitCode: number | null } } })
    .Bun.spawnSync([command, ...args], { cwd, stdout: 'inherit', stderr: 'inherit', env: environment })
  if (result.exitCode !== 0) {
    console.error(`pack-stable-app: ${command} ${args.join(' ')} exited ${String(result.exitCode)}`)
    process.exit(1)
  }
}

/** The runtime target of an exports value: the plain string or its default-ish condition. */
function pickRuntimeTarget(declared: unknown): string | undefined {
  if (typeof declared === 'string') return declared
  if (declared !== null && typeof declared === 'object') {
    const record = declared as Record<string, unknown>
    for (const key of ['default', 'module', 'import', 'require', 'node', 'bun']) {
      const value = pickRuntimeTarget(record[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Mach-O magic numbers (fat, 64-bit LE/BE, thin) in the first four bytes. */
const MACHO_MAGICS = new Set(['0xCAFEBABE', '0xBEBAFECA', '0xFEEDFACF', '0xCFFAEDFE', '0xFEEDFACE', '0xCEFAEDFE'])

/** Whether a shipped file is a Mach-O image; such payloads must stay executable. */
function isMachOImage(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const read = readSync(fd, buffer, 0, 4, 0)
    if (read < 4) return false
    return MACHO_MAGICS.has(`0x${buffer.readUInt32BE(0).toString(16).toUpperCase().padStart(8, '0')}`)
  } finally {
    closeSync(fd)
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A manifest resolution: the target file and whether a wildcard export produced it. */
interface ManifestEntry {
  entry: string
  wildcard: boolean
}

/** Resolve one subpath of an installed package manifest to a real file. */
function entryOfManifest(packageDir: string, manifest: Record<string, unknown>, subpath: string): ManifestEntry | undefined {
  if (subpath === '/package.json') return { entry: join(packageDir, 'package.json'), wildcard: false }
  const key = subpath === '' ? '.' : `.${subpath}`
  const exports = manifest.exports
  if (exports !== null && typeof exports === 'object' && !Array.isArray(exports)) {
    const direct = pickRuntimeTarget((exports as Record<string, unknown>)[key])
    if (direct !== undefined) {
      const entry = resolve(packageDir, direct)
      if (isFile(entry)) return { entry, wildcard: false }
      return undefined
    }
    // Wildcard patterns, longest prefix first; `*` captures the remainder.
    const patterns = Object.keys(exports).filter(pattern => pattern.includes('*')).sort((a, b) => b.length - a.length)
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split('*') as [string, string | undefined]
      if (suffix === undefined) continue
      if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < prefix.length + suffix.length) continue
      const captured = key.slice(prefix.length, key.length - suffix.length)
      if (captured.includes('*') || captured === '') continue
      const declared = pickRuntimeTarget((exports as Record<string, unknown>)[pattern])
      if (declared === undefined || !declared.includes('*')) continue
      const entry = resolve(packageDir, declared.replace('*', captured))
      if (isFile(entry)) return { entry, wildcard: true }
    }
    return undefined
  }
  if (subpath === '') {
    const main = typeof manifest.main === 'string' ? manifest.main : 'index.js'
    for (const candidate of [main, `${main}.js`, join(main, 'index.js'), 'index.js', 'index.ts']) {
      const entry = resolve(packageDir, candidate)
      if (isFile(entry)) return { entry, wildcard: false }
    }
    return undefined
  }
  // No exports map: every file below the package root is a legal subpath.
  const bare = resolve(packageDir, `.${subpath}`)
  if (isFile(bare)) return { entry: bare, wildcard: false }
  if (isDirectory(bare)) {
    for (const candidate of [join(bare, 'index.js'), join(bare, 'index.cjs'), join(bare, 'index.mjs')]) {
      if (isFile(candidate)) return { entry: candidate, wildcard: false }
    }
  }
  return undefined
}

/**
 * Resolve a bare specifier by walking node_modules directories from the
 * importing file — Node's own algorithm, deliberately without Bun's resolver
 * (which applies tsconfig `paths` and would resolve onto the src plane).
 */
function resolveBareFile(spec: string, fromFile: string): { file: string; wildcard: boolean } {
  if (spec === 'electrobun' || spec.startsWith('electrobun/')) return { file: resolveDevkitFile(spec), wildcard: false }
  if (spec.startsWith('#')) return { file: realpathSync(createRequire(fromFile).resolve(spec)), wildcard: false }
  const root = packageRootName(spec)
  const subpath = spec.slice(root.length)
  let dir = dirname(realpathSync(fromFile))
  for (;;) {
    const packageDir = join(dir, 'node_modules', root)
    const manifestPath = join(packageDir, 'package.json')
    if (isFile(manifestPath)) {
      const resolved = entryOfManifest(packageDir, JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>, subpath)
      if (resolved !== undefined) return { file: realpathSync(resolved.entry), wildcard: resolved.wildcard }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`pack-stable-app: cannot resolve ${JSON.stringify(spec)} from ${fromFile} by node_modules walk`)
}

/**
 * The Electrobun SDK lives in the Hutch devkit projection, not in the npm
 * bootstrap package; resolve its specifiers against the devkit manifest.
 */
function resolveDevkitFile(spec: string): string {
  const manifest = JSON.parse(readFileSync(join(devkitDir, 'package.json'), 'utf8')) as Record<string, unknown>
  const subpath = spec === 'electrobun' ? '' : spec.slice('electrobun'.length)
  const resolved = entryOfManifest(devkitDir, manifest, subpath)
  if (resolved === undefined) throw new Error(`pack-stable-app: devkit exports no runtime target for ${JSON.stringify(spec)}`)
  return realpathSync(resolved.entry)
}

/** Nearest enclosing package directory of a file (realpath), preferring a manifest naming `expected`. */
function nearestPackageDir(file: string, expected: string): string {
  let dir = dirname(file)
  let firstSeen: string | undefined
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (isFile(manifestPath)) {
      try {
        const name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }).name
        if (name === expected) return realpathSync(dir)
        if (firstSeen === undefined) firstSeen = realpathSync(dir)
      } catch {
        // An unreadable intermediate manifest cannot own the file; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (firstSeen !== undefined) return firstSeen
  throw new Error(`pack-stable-app: no package manifest encloses ${file}`)
}

/** Extension-probing resolution for relative specifiers inside a package. */
function resolveRelative(spec: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [base]
  const ext = extname(base)
  if (ext === '') {
    // CommonJS relative requires omit the extension: './x' names x.js.
    candidates.push(`${base}.js`, `${base}.cjs`, `${base}.json`, `${base}.node`)
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    candidates.push(`${base.slice(0, -ext.length)}.ts`, `${base.slice(0, -ext.length)}.mts`)
  }
  candidates.push(join(base, 'index.js'), join(base, 'index.ts'))
  for (const candidate of candidates) {
    if (isFile(candidate)) return realpathSync(candidate)
  }
  return undefined
}

/** The profile template the shipped app boots: bundle layers, then entries. */
function composeProfileEntries(): { entries: string[]; bundles: string[] } {
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const temp = mkdtempSync(join(tmpdir(), 'dsh-stable-profile-'))
  try {
    initProfile(temp, bundles)
    const profile = loadProfileDirectory('pack-stable-app', temp, cliAnchor, { userLayer: false })
    const overlay = loadOverlayPatches('pack-stable-app', join(hostDir, 'config', 'electrobun.cordis.patch.yml'))
    const patchLayers = profile.layers.map((layer): PatchOptions[] => layer.patches)
    const composed = composeEntries([...patchLayers, overlay])
    const names: string[] = []
    const visit = (rows: readonly unknown[]): void => {
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const record = row as { name?: unknown; config?: unknown; disabled?: unknown }
        // A disabled row never mounts at runtime (the loader's `disabled`
        // semantics), so its package stays out of the shipped closure too.
        if (record.disabled === true) continue
        if (typeof record.name === 'string' && isBare(record.name)) names.push(record.name)
        if (Array.isArray(record.config)) visit(record.config)
      }
    }
    visit(composed)
    return { entries: names, bundles }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Analyze the runtime closure: seeds → import scan → packages, units, verbatim files. */
function analyzeClosure(entryNames: readonly string[], bundleNames: readonly string[]): Closure {
  const closure: Closure = {
    specifiers: new Set(),
    packages: new Map(),
    offPrimary: new Map(),
    units: new Map(),
    verbatim: new Map(),
    unresolved: new Set(),
  }
  const scanned = new Set<string>()
  const fileQueue: string[] = []

  /** The closure-plane package a file belongs to (the host app included). */
  const importerPkgOf = (file: string): string => {
    if (file.startsWith(hostDir + '/')) return '@deepseek-ai/dsh-electrobun-host'
    const dir = nearestPackageDir(file, '')
    const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
    return typeof name === 'string' ? name : basename(dir)
  }

  /**
   * First resolution of a name owns the root plane; a different directory
   * reached later is a version conflict, recorded so the importing package
   * inlines that specifier instead of importing the root copy.
   */
  const recordResolution = (name: string, dir: string, fromFile: string, via: string): void => {
    const existing = closure.packages.get(name)
    if (existing === undefined) {
      closure.packages.set(name, { dir, from: via })
      return
    }
    if (existing.dir === dir) return
    const importer = importerPkgOf(fromFile)
    const specs = closure.offPrimary.get(importer) ?? new Set<string>()
    specs.add(name)
    closure.offPrimary.set(importer, specs)
  }

  const addUnit = (spec: string, srcFile: string, fromFile: string, wildcard = false): void => {
    const name = packageRootName(spec)
    const dir = nearestPackageDir(srcFile, name)
    recordResolution(name, dir, fromFile, spec)
    let outRel = relative(dir, srcFile)
    if (outRel.startsWith('..')) throw new Error(`pack-stable-app: ${srcFile} escapes its package root ${dir}`)
    let specSubpath: string | undefined
    if (wildcard) {
      // Wildcard-reached files ship where the specifier names them, so the
      // exact key the runtime imports stays stable in the emitted manifest.
      const rest = spec.slice(name.length + 1)
      const sourceExt = extname(srcFile)
      outRel = sourceExt === '.js' || sourceExt === '.mjs' || sourceExt === '.cjs'
        ? `${rest}${sourceExt}`
        : rest
      specSubpath = rest
    }
    for (const ext of ['.ts', '.mts', '.tsx']) {
      if (outRel.endsWith(ext) && !spec.endsWith(outRel)) {
        outRel = `${outRel.slice(0, -ext.length)}.js`
        break
      }
    }
    const key = `${name}\0${outRel}`
    if (!closure.units.has(key)) {
      closure.units.set(key, { pkg: name, src: srcFile, outRel, ...(specSubpath === undefined ? {} : { specSubpath }) })
    }
    fileQueue.push(srcFile)
  }

  const handleSpecifier = (spec: string, fromFile: string): void => {
    if (spec.startsWith('cordis:')) return
    if (!isBare(spec)) {
      const target = spec.startsWith('#')
        ? resolveBareFile(spec, fromFile).file
        : resolveRelative(spec, fromFile)
      if (target !== undefined) fileQueue.push(target)
      return
    }
    closure.specifiers.add(spec)
    let resolved: { file: string; wildcard: boolean }
    try {
      resolved = resolveBareFile(spec, fromFile)
    } catch {
      // An optional dependency the install itself lacks (sharp's wasm32
      // fallback): the runtime meets the same resolution failure it meets
      // today, so keep the specifier external and ship no package for it.
      closure.unresolved.add(spec)
      return
    }
    if (isDirectory(resolved.file)) {
      // A package root reached through an unexported `…/package.json`
      // request; enqueue its root entry instead of the directory.
      const rootSpec = packageRootName(spec)
      addUnit(rootSpec, resolveBareFile(rootSpec, fromFile).file, fromFile)
      return
    }
    if (!/\.(?:js|mjs|cjs|ts|mts|cts|tsx)$/u.test(resolved.file)) {
      // A style or data target reached by import (katex's CSS): the package
      // ships with the file as runtime data, not as a bundled unit.
      const root = packageRootName(spec)
      recordResolution(root, nearestPackageDir(resolved.file, root), fromFile, spec)
      return
    }
    addUnit(spec, resolved.file, fromFile, resolved.wildcard)
  }

  const scanFile = (file: string): void => {
    if (scanned.has(file)) return
    scanned.add(file)
    let code: string
    try {
      code = readFileSync(file, 'utf8')
    } catch {
      return
    }
    const loader = /\.(?:ts|mts|cts|tsx)$/u.test(file) ? 'ts' : 'js'
    try {
      for (const imported of new bun.Transpiler({ loader }).scanImports(code)) {
        handleSpecifier(imported.path, file)
      }
    } catch {
      // Unparseable content (data or binary extension): nothing to follow.
    }
    // Files addressed through string URLs beside the module (worker
    // entrypoints, data anchors) never appear in the import table. The host
    // application itself is not a node_modules package: its references point
    // at the app bundle's own copied files.
    if (code.includes('import.meta.url') && !file.startsWith(hostDir + '/')) {
      for (const match of code.matchAll(/['"`](\.{1,2}\/[^'"`\s]+)['"`]/gu)) {
        const literal = match[1]
        if (literal === undefined) continue
        const target = resolveRelative(literal, file)
        if (target === undefined) continue
        const dir = nearestPackageDir(target, '')
        const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
        if (typeof name !== 'string') continue
        const outRel = relative(dir, target)
        recordResolution(name, dir, file, 'string-url')
        if (!closure.verbatim.has(`${name}\0${outRel}`)) {
          closure.verbatim.set(`${name}\0${outRel}`, { pkg: name, src: target, outRel })
        }
        fileQueue.push(target)
      }
    }
    // Packages located through require.resolve string literals (the frontend
    // dist anchor, native addon platform packages addressed by computed name):
    // `require.resolve('…')` and `createRequire(...).resolve('…')` forms only.
    // A code target grows the unit graph; a manifest or data target ships the
    // package without a root entry (some packages export no `.` at all).
    for (const match of code.matchAll(/(?:require\s*\.\s*resolve|\)\s*\.\s*resolve)\(\s*['"]([@a-zA-Z][^'"]*)['"]/gu)) {
      const spec = match[1]
      if (spec === undefined || !isBare(spec)) continue
      closure.specifiers.add(spec)
      let resolved: { file: string; wildcard: boolean } | undefined
      try {
        resolved = resolveBareFile(spec, file)
      } catch {
        closure.unresolved.add(spec)
        continue
      }
      if (/\.(?:js|mjs|cjs|ts|mts|cts|tsx)$/u.test(resolved.file)) {
        addUnit(spec, resolved.file, file, resolved.wildcard)
      } else {
        const root = packageRootName(spec)
        recordResolution(root, nearestPackageDir(resolved.file, root), file, spec)
      }
    }
    // Product-namespace package names appearing as plain string literals
    // (BACKEND_PACKAGES tables, surface registries): the Loader mounts them
    // by name at runtime, so every @deepseek-ai/* literal in scanned code
    // seeds the closure the same way a YAML row does.
    for (const match of code.matchAll(/['"`](@deepseek-ai\/[a-z0-9-._~]+(?:\/[a-z0-9-._~]+)*)['"`]/gu)) {
      const spec = match[1]
      if (spec === undefined) continue
      closure.specifiers.add(spec)
      try {
        const resolved = resolveBareFile(spec, file)
        if (statSync(resolved.file).isFile() && /\.(?:js|mjs|cjs|ts|mts|cts|tsx)$/u.test(resolved.file)) {
          addUnit(spec, resolved.file, file, resolved.wildcard)
        } else {
          recordResolution(packageRootName(spec), nearestPackageDir(resolved.file, packageRootName(spec)), file, spec)
        }
      } catch {
        closure.unresolved.add(spec)
      }
    }

    // Platform-qualified packages addressed through template literals
    // (`@vscode/ripgrep-${process.platform}-${arch}`, the flock binding):
    // the import graph cannot see a computed name, so the installed
    // darwin-arm64 variant is seeded as a data package — its payload is a
    // binary (bin/rg, bin/*.node), never an import entry.
    for (const match of code.matchAll(/`([@a-z0-9/._]+)-\$\{[^}]*platform[^}]*\}[^`]*`/gu)) {
      const prefix = match[1]
      if (prefix === undefined) continue
      const variant = `${prefix}-darwin-arm64`
      closure.specifiers.add(variant)
      try {
        const manifest = resolveBareFile(`${variant}/package.json`, file).file
        recordResolution(variant, dirname(manifest), file, 'computed platform package')
      } catch {
        closure.unresolved.add(variant)
      }
    }

    // CommonJS require calls in built .cjs workers reference the shared plane
    // too. A relative require inside a bundled CJS entry is the module's own
    // conditional dispatch (zod's v3/v4 switch): the bundler cannot inline
    // it, so the target ships verbatim beside the unit like a worker file.
    for (const match of code.matchAll(/(?<![.\w$])require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      const spec = match[1]
      if (spec === undefined) continue
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolveRelative(spec, file)
        if (target === undefined) continue
        const dir = nearestPackageDir(target, '')
        const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
        if (typeof name !== 'string') continue
        const outRel = relative(dir, target)
        recordResolution(name, dir, file, 'cjs-require')
        if (!closure.verbatim.has(`${name}\0${outRel}`)) {
          closure.verbatim.set(`${name}\0${outRel}`, { pkg: name, src: target, outRel })
        }
        fileQueue.push(target)
        continue
      }
      handleSpecifier(spec, file)
    }
  }

  for (const name of [...entryNames, ...bundleNames]) {
    closure.specifiers.add(name)
    addUnit(name, resolveBareFile(name, cliAnchor).file, cliAnchor)
  }
  fileQueue.push(hostEntry)
  // Two data-declared surfaces the import graph never sees, seeded per
  // package and iterated to a fixpoint (a discovered package may declare
  // more of its own):
  // - Loader rows in shipped YAML (preset compositions) name plugins that
  //   mount by name at session scope.
  // - Non-wildcard exports subpaths are the package's public surface:
  //   conventions resolve them by name at runtime (typert-loader discovers
  //   `./typert` type graphs and skips packages whose export is absent —
  //   silently, with the type graph left empty), and any config or SDK
  //   import may name the rest. Code targets become units of their own.
  const declared = new Set<string>()
  const declaredPluginNames = (pkgDir: string): string[] => {
    const names = new Set<string>()
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (PRUNE_DIR_NAMES.has(entry.name)) continue
          walk(join(dir, entry.name))
          continue
        }
        if (!entry.isFile() || !/\.(?:ya?ml)$/u.test(entry.name)) continue
        if (entry.name.startsWith('README.') || entry.name.endsWith('.i18n.yaml')) continue
        const text = readFileSync(join(dir, entry.name), 'utf8')
        for (const match of text.matchAll(/name:\s*['"]?(@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+[^'"\s,}]*)/gu)) {
          const root = packageRootName(match[1] ?? '')
          if (isBare(root)) names.add(root)
        }
      }
    }
    walk(pkgDir)
    return [...names]
  }
  const declaredExportSpecs = (pkgDir: string, manifest: Record<string, unknown>): string[] => {
    const name = manifest.name
    const exports = manifest.exports
    if (typeof name !== 'string' || exports === null || typeof exports !== 'object' || Array.isArray(exports)) return []
    // A browser-bundle package's node-plane surface has no runtime consumer:
    // the browser reaches it through the client bundle family and the
    // Vite-built shell, so seeding its subpaths would pull browser-only
    // dependency trees (shiki languages, katex, pdf workers) into the app.
    const dsh = manifest.dsh
    const browserDeclared = dsh !== null && typeof dsh === 'object' && (dsh as Record<string, unknown>).client !== undefined
    const specs: string[] = []
    for (const [key, value] of Object.entries(exports as Record<string, unknown>)) {
      if (key === '.' || key === './package.json' || key.includes('*')) continue
      const target = pickRuntimeTarget(value)
      if (target === undefined || !target.startsWith('./')) continue
      if (!/\.(?:js|mjs|cjs|ts|mts|cts|tsx)$/u.test(target)) continue
      if (!isFile(resolve(pkgDir, target))) continue
      // `./typert` is the typert-loader's host-side convention and stays
      // seeded even for browser-declared packages: the gateway's wire
      // descriptors (parameter wires, cancellation) come from that manifest,
      // and a silently skipped one degrades every RPC of the package to
      // signature derivation — mismatched argument fields and a lost abort
      // signal. The package's other subpaths keep the browser exclusion.
      if (browserDeclared && key !== './typert') continue
      specs.push(`${name}${key.slice(1)}`)
    }
    return specs
  }
  /** Every runtime file of a CommonJS package: it ships whole, so its whole
   * require graph belongs in the closure, not just the entry's chain (the
   * full/light variants and lazy util trees pull deps the entry never names). */
  const commonJSPackageFiles = (pkgDir: string): string[] => {
    const files: string[] = []
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (isTestTreeDir(entry.name) || PRUNE_DIR_NAMES.has(entry.name)) continue
          walk(join(dir, entry.name))
          continue
        }
        if (entry.isFile() && /\.(?:js|cjs)$/u.test(entry.name)) files.push(join(dir, entry.name))
      }
    }
    walk(pkgDir)
    return files
  }
  for (let settled = false; !settled;) {
    for (let next = fileQueue.shift(); next !== undefined; next = fileQueue.shift()) scanFile(next)
    settled = true
    for (const pkg of [...closure.packages.keys()]) {
      if (declared.has(pkg)) continue
      declared.add(pkg)
      const record = closure.packages.get(pkg)
      if (record === undefined) continue
      const manifestPath = join(record.dir, 'package.json')
      const packageManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      const seeds = [
        ...declaredPluginNames(record.dir),
        ...declaredExportSpecs(record.dir, packageManifest),
      ]
      for (const spec of seeds) {
        closure.specifiers.add(packageRootName(spec))
        addUnit(spec, resolveBareFile(spec, manifestPath).file, manifestPath)
        settled = false
      }
      if (packageManifest.type !== 'module') {
        for (const file of commonJSPackageFiles(record.dir)) fileQueue.push(file)
      }
    }
  }
  return closure
}

/** Bundle one unit with the whole-plane externals; returns the output text or undefined on failure. */
async function buildUnit(entry: string, target: 'bun' | 'browser', format: 'esm' | 'cjs', externals: readonly string[]): Promise<string | undefined> {
  const result = await bun.build({
    entrypoints: [entry],
    target,
    format,
    minify: true,
    external: [...externals],
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(`  bun-build: ${String(log)}`)
    return undefined
  }
  const artifact = result.outputs.find(output => output.kind === 'entry-point')
  return artifact === undefined ? undefined : await artifact.text()
}

/** Names required through require() calls inside a built browser bundle. */
function clientBundleExternals(code: string): string[] {
  const names = new Set<string>()
  for (const match of code.matchAll(/(?<![.\w$])require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    const spec = match[1]
    if (spec !== undefined && isBare(spec)) names.add(spec)
  }
  return [...names]
}

/** Externals for one package's builds: the whole plane minus its conflicts. */
function externalsFor(closure: Closure, pkg: string): string[] {
  const conflicts = closure.offPrimary.get(pkg)
  if (conflicts === undefined) return [...closure.specifiers]
  return [...closure.specifiers].filter(spec => !conflicts.has(packageRootName(spec)))
}

/** Runtime-kept declaration blocks of a package manifest. */
interface ShippedManifestParts {
  dsh?: unknown
  clientRel?: string
}

const PRUNE_DIR_NAMES = new Set(['node_modules', 'tests', 'test', '__tests__', 'coverage', '.git', '.github',
  '.yarn', '.bin', '.circleci', 'benchmark', 'benchmarks', 'bench', 'example', 'examples', 'install'])

/** Directory names an npm package may carry that only its own tests load. */
function isTestTreeDir(name: string): boolean {
  return PRUNE_DIR_NAMES.has(name) || name.endsWith('-test') || name.endsWith('-tests')
}

function prunedFileName(name: string): boolean {
  return name === 'package.json' || name === '.DS_Store' || name === 'test.js' || name === 'test.mjs'
    || name.startsWith('README.') || name.startsWith('CHANGELOG.') || name === 'LICENSE' || name === 'LICENCE'
    || name.startsWith('tsconfig') || name.endsWith('.tsbuildinfo') || name.endsWith('.i18n.yaml')
    || name.endsWith('.bench.js') || name.endsWith('.bench.mjs')
    || name.endsWith('.fixture.js') || name.endsWith('.fixtures.js') || name.endsWith('.fixture.mjs')
}

/** Runtime data files of one package: everything except code the units replace. */
function packageDataFiles(
  pkg: string,
  pkgDir: string,
  manifest: Record<string, unknown>,
  unitOutRels: ReadonlySet<string>,
  verbatimOutRels: ReadonlySet<string>,
  keepAllCode = false,
): { files: string[]; parts: ShippedManifestParts } {
  const files: string[] = []
  const skipDirs = new Set(PRUNE_DIR_NAMES)
  if (pkg === 'electrobun') {
    skipDirs.add('go-sdk')
    skipDirs.add('rust-sdk')
    skipDirs.add('zig-sdk')
  }
  const parts: ShippedManifestParts = {}
  if (manifest.dsh !== null && manifest.dsh !== undefined && typeof manifest.dsh === 'object') {
    parts.dsh = manifest.dsh
    const exports = manifest.exports
    const client = (manifest.dsh as Record<string, unknown>).client
    if (client !== undefined && exports !== null && typeof exports === 'object') {
      const declared = pickRuntimeTarget((exports as Record<string, unknown>)['./client'])
      if (declared !== undefined) parts.clientRel = relative(pkgDir, resolve(pkgDir, declared))
    }
  }

  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || isTestTreeDir(entry.name)) continue
        // A package's own TypeScript sources ship only when a unit's output
        // sits among them (exact-file subpath imports keep their name); the
        // rule is the package root's src only — npm trees keep runtime CJS
        // under build/src and must not be caught by it.
        if (!keepAllCode && relBase === '' && entry.name === 'src' && ![...unitOutRels, ...verbatimOutRels].some(outRel => outRel.startsWith('src/'))) continue
        // The web frontend's dist ships without its self-contained preview build.
        if (pkg === '@deepseek-ai/dsh-web-frontend' && rel === 'dist/preview') continue
        walk(join(dir, entry.name), rel)
        continue
      }
      if (!entry.isFile() || prunedFileName(entry.name)) continue
      const ext = extname(entry.name)
      if (ext === '.map' || entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts') || entry.name.endsWith('.d.cts')) continue
      // The web frontend's published payload is its dist tree alone, shipped
      // wholesale (its Vite build is the artifact; nothing else is payload).
      if (pkg === '@deepseek-ai/dsh-web-frontend') {
        if (rel.startsWith('dist/')) files.push(rel)
        continue
      }
      if (ext === '.ts' || ext === '.tsx') continue
      if (!keepAllCode && (ext === '.js' || ext === '.mjs' || ext === '.cjs')) {
        // Unit bundles and verbatim files are written by their own passes; a
        // raw data copy here would overwrite minified output with source.
        // The client bundle family is the one code path the data copy owns
        // (its entry point is minified in the copy loop).
        const isClientFamily = parts.clientRel !== undefined && rel.startsWith('lib/client')
        if (!isClientFamily) continue
      }
      files.push(rel)
    }
  }
  walk(pkgDir, '')
  if (parts.clientRel !== undefined) files.push(parts.clientRel)
  return { files: [...new Set(files)], parts }
}

/** Emit one shipped package: bundles, verbatim files, data files, manifest. */
async function emitPackage(pkg: string, pkgDir: string, closure: Closure, manifest: Record<string, unknown>): Promise<void> {
  const outDir = join(closureRoot, ...pkg.split('/'))
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const unitOutRels = new Set([...closure.units.values()].filter(unit => unit.pkg === pkg).map(unit => unit.outRel))
  const verbatimOutRels = new Set([...closure.verbatim.values()].filter(file => file.pkg === pkg).map(file => file.outRel))
  const externals = externalsFor(closure, pkg)

  // The Electrobun devkit projection ships whole, as TypeScript, exactly as
  // `electrobun dev` runs it. Its native layer (proc/native.ts) registers
  // process-global FFI callbacks and a module-singleton event emitter; one
  // bundled unit per exports subpath would inline that layer into every unit,
  // so the webview's event dispatch would fire one copy's emitter while the
  // host listens on another's — every webview→host event (the title-bar
  // double-click command among them) silently lost while the SDK-internal
  // paths (window drag) kept working. The Bun main process executes the
  // devkit's TypeScript natively, so the projection needs no build step.
  if (pkgDir === devkitDir) {
    emitDevkitPackage(pkgDir, outDir)
    return
  }

  // A CommonJS package ships as-is. Bundling it to ESM would drop its named
  // exports (Bun's CJS→ESM output carries only `default`), breaking every
  // `import { x } from 'cjs-pkg'` at load; and stamping the emitted manifest
  // `type: module` would mislabel its files as ESM. Node's own interop reads
  // the original CJS correctly, so the tree and manifest are copied verbatim
  // (pruned of docs and test trees like everything else).
  if (manifest.type !== 'module') {
    emitCommonJSPackage(pkg, pkgDir, outDir, manifest)
    return
  }

  for (const unit of [...closure.units.values()].filter(unit => unit.pkg === pkg)) {
    const text = await buildUnit(unit.src, 'bun', 'esm', externals)
    if (text === undefined) {
      console.error(`pack-stable-app: bundling ${pkg} entry ${unit.outRel} failed`)
      process.exit(1)
    }
    const destination = join(outDir, ...unit.outRel.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text)
  }
  for (const file of closure.verbatim.values()) {
    if (file.pkg !== pkg) continue
    // A unit's bundled output is authoritative; a verbatim record naming the
    // same path (zod's re-export shims) must not overwrite it with raw source.
    if (unitOutRels.has(file.outRel)) continue
    const destination = join(outDir, ...file.outRel.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    // Verbatim means verbatim: these files are reached through string URLs
    // and conditional dispatch (zod's v3/v4 switch, protobufjs' lazy util),
    // and re-bundling them — especially CJS through the ESM pass, which
    // drops named exports — breaks exactly the interop Node performs on the
    // original. Minification is not worth that correctness edge.
    copyFileSync(file.src, destination)
    if (isMachOImage(destination)) chmodSync(destination, 0o755)
  }

  const { files, parts } = packageDataFiles(pkg, pkgDir, manifest, unitOutRels, verbatimOutRels)
  const clientRel = parts.clientRel
  for (const rel of files) {
    const destination = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    if (clientRel !== undefined && rel === clientRel) {
      const source = join(pkgDir, ...rel.split('/'))
      const code = readFileSync(source, 'utf8')
      const minified = await buildUnit(source, 'browser', 'esm', clientBundleExternals(code))
      // The browser build injects the build machine's absolute __filename;
      // ship an empty string instead of leaking the checkout path.
      const sanitized = (minified ?? code).replace(
        /var __filename="[^"]*"/gu,
        'var __filename=""',
      )
      writeFileSync(destination, sanitized)
      continue
    }
    const sourceFile = join(pkgDir, ...rel.split('/'))
    copyFileSync(sourceFile, destination)
    if (isMachOImage(destination)) chmodSync(destination, 0o755)
  }

  const shipped: Record<string, unknown> = {
    name: pkg,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    type: 'module',
    private: true,
  }
  const dependencies: Record<string, string> = {}
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const declared = manifest[field]
    if (declared !== null && typeof declared === 'object') Object.assign(dependencies, declared)
  }
  if (Object.keys(dependencies).length > 0) shipped.dependencies = dependencies
  if (parts.dsh !== undefined) shipped.dsh = parts.dsh
  const exports = manifest.exports
  const shippedRels = new Set<string>([...unitOutRels, ...verbatimOutRels, ...files])
  const rootUnit = unitOutRels.has('lib/index.js') ? 'lib/index.js' : [...unitOutRels][0]
  if (exports !== null && exports !== undefined && typeof exports === 'object' && !Array.isArray(exports)) {
    const rewritten: Record<string, string> = { './package.json': './package.json' }
    for (const [key, declared] of Object.entries(exports as Record<string, unknown>)) {
      if (key.includes('*')) {
        const prefix = (key.split('*')[0] ?? '').slice(2)
        if ([...shippedRels].some(rel => rel.startsWith(prefix))) rewritten[key] = `./${prefix}*`
        continue
      }
      const target = pickRuntimeTarget(declared)
      if (target === undefined) continue
      const rel = relative(pkgDir, resolve(pkgDir, target))
      const normalized = rel.replace(/\.(?:ts|mts|tsx)$/u, '.js')
      if (unitOutRels.has(rel) || unitOutRels.has(normalized)) rewritten[key] = `./${unitOutRels.has(rel) ? rel : normalized}`
      else if (shippedRels.has(rel)) rewritten[key] = `./${rel}`
    }
    // One exact key per wildcard-reached unit: the emitted layout places
    // those files where the importing specifier names them.
    for (const unit of closure.units.values()) {
      if (unit.pkg !== pkg || unit.specSubpath === undefined) continue
      const subpath = unit.specSubpath.replace(/^\/+/u, '')
      rewritten[`./${subpath}`] = `./${unit.outRel}`
    }
    if (clientRel !== undefined) rewritten['./client'] = `./${clientRel}`
    if (rootUnit !== undefined && rewritten['.'] === undefined) rewritten['.'] = `./${rootUnit}`
    shipped.exports = rewritten
  } else if (rootUnit !== undefined) {
    shipped.main = rootUnit
  }
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(shipped, undefined, 2)}\n`)
}

/**
 * Ship the Hutch devkit projection verbatim: its manifest (whose exports name
 * the TypeScript entries) plus the `api/` runtime tree, minus its own test
 * files. Nothing is bundled — see {@link emitPackage} for why the projection
 * must stay one module graph — and the Bun main process executes the
 * TypeScript directly, exactly as the dev loop does.
 */
function emitDevkitPackage(pkgDir: string, outDir: string): void {
  copyFileSync(join(pkgDir, 'package.json'), join(outDir, 'package.json'))
  const apiDir = join(pkgDir, 'api')
  const walk = (dir: string, rel: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...rel, entry.name])
        continue
      }
      if (!entry.isFile()) continue
      if (/\.(?:test|spec)\.tsx?$/u.test(entry.name)) continue
      const outRel = [...rel, entry.name].join('/')
      const destination = join(outDir, 'api', outRel)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(dir, entry.name), destination)
    }
  }
  walk(apiDir, [])
}

/**
 * Ship one CommonJS package verbatim: the published tree (pruned like every
 * other data copy, binaries kept executable) and the source manifest's own
 * main/exports/type, so Node's CJS↔ESM interop reads it exactly as upstream
 * installs do.
 */
function emitCommonJSPackage(pkg: string, pkgDir: string, outDir: string, manifest: Record<string, unknown>): void {
  const { files } = packageDataFiles(pkg, pkgDir, manifest, new Set<string>(), new Set<string>(), true)
  for (const rel of files) {
    const destination = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(pkgDir, ...rel.split('/')), destination)
    if (isMachOImage(destination)) chmodSync(destination, 0o755)
  }
  // The client bundle family never applies here (client packages are ESM
  // plugins), but a code walk that skipped plain .js outside lib/ would drop
  // the CJS runtime files this path exists to keep.
  // The source manifest ships untouched: consumers read fields beyond the
  // resolution set (sharp's libvips detection reads the platform package's
  // `config` block), and rewriting it is one more chance to drop one.
  copyFileSync(join(pkgDir, 'package.json'), join(outDir, 'package.json'))
}

/** Bundle the host main as a bytecode-cached CJS unit and place it as the app's
 * bun entry. Two properties matter:
 *
 * - The electrobun devkit is inlined (its only runtime importer is this entry,
 *   so a single copy is singleInstance-safe — the verbatim-shipment rule
 *   exists to stop the packager's per-subpath units from duplicating
 *   `proc/native.ts` across many files). Inlining removes a 73-file
 *   TypeScript transpile from every launch; bytecode removes the parse.
 * - The `.jsc` sidecar must be generated by the exact Bun the app ships
 *   (JSC bytecode is version-locked; a mismatch silently falls back to
 *   parsing the adjacent source, so pin to the dev app's bundled runtime).
 * `@deepseek-ai/*` stays external: the plugin tree shares those module
 * instances (cordis above all), and a host-bundled second copy would break
 * that sharing. */
async function emitHostBundle(closure: Closure): Promise<void> {
  const externals = externalsFor(closure, '@deepseek-ai/dsh-electrobun-host')
    .filter(spec => packageRootName(spec) !== 'electrobun')
  const outDir = join(appResourcesApp, 'bun')
  mkdirSync(outDir, { recursive: true })
  const appBun = join(repoRoot, 'apps', 'electrobun-host', 'build', 'dev-macos-arm64', 'Colaw-dev.app', 'Contents', 'MacOS', 'bun')
  const devkit = join(repoRoot, 'apps', 'electrobun-host', '.hutch', 'devkit')
  run(appBun, [
    join(repoRoot, 'scripts', 'build-host-bytecode.ts'), dirname(hostEntry), outDir, devkit,
    ...externals,
  ], repoRoot)
  for (const artifact of ['index.js', 'index.js.jsc']) {
    if (!existsSync(join(outDir, artifact))) {
      console.error(`pack-stable-app: host bundle artifact missing: ${artifact}`)
      process.exit(1)
    }
  }
}

function ensureBuilds(): void {
  // No dist guard: on a clean checkout (CI) the vite build at the end of this
  // sequence creates apps/web/dist itself; --skip-build still requires a
  // previous full pass to have left the artifacts behind.
  if (skipBuild) {
    if (!isDirectory(join(repoRoot, 'apps', 'web', 'dist'))) {
      console.error('pack-stable-app: --skip-build needs a previous full build (apps/web/dist is missing)')
      process.exit(1)
    }
    return
  }
  // The repo tracks only the two .icns files; the devkit's mac build wants an
  // .iconset, so derive it from the dark icns (the bundle icon) on every full
  // build. With --skip-build the previous derivation under build/ is reused.
  const derivedIconset = join(repoRoot, 'apps', 'electrobun-host', 'build', 'cat5-dark.iconset')
  rmSync(derivedIconset, { recursive: true, force: true })
  run('/usr/bin/iconutil', ['-c', 'iconset', join(repoRoot, 'apps', 'electrobun-host', 'cat5_light.icns'), '-o', derivedIconset], repoRoot)
  run(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.host.json'], repoRoot)
  run(process.execPath, [join(repoRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--env.DSH_BUILD_FACE', 'host'], repoRoot)
  // Client bundles build from the client face's compiled lib, never src.
  run(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.client.json'], repoRoot)
  run(process.execPath, [join(repoRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--env.DSH_BUILD_FACE', 'client'], repoRoot)
  run(process.execPath, [join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], join(repoRoot, 'apps', 'web'))
}

/** Publish the freshly built dev app as the stable shell (still code-free). */
function publishStableApp(): void {
  if (!existsSync(builtApp)) {
    console.error(`pack-stable-app: built app was not produced at ${builtApp}`)
    process.exit(1)
  }
  rmSync(dirname(stableApp), { recursive: true, force: true })
  mkdirSync(dirname(stableApp), { recursive: true })
  ;(function copyTree(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name)
      const destinationPath = join(destination, entry.name)
      if (entry.isSymbolicLink()) {
        symlinkSync(readlinkSync(sourcePath), destinationPath)
      } else if (entry.isDirectory()) {
        copyTree(sourcePath, destinationPath)
      } else if (entry.isFile()) {
        copyFileSync(sourcePath, destinationPath)
      }
    }
  })(builtApp, stableApp)
  rewriteDevMarkers()
  rewriteIconLayout()
}

/**
 * The icon layout ships exactly two icons at the Resources level: the
 * bundle's default AppIcon.icns (light) that Info.plist names, and
 * AppIconDark.icns for the runtime dark switch. The copies the config left
 * under app/ are surplus — the light one IS AppIcon, the dark one moves up.
 */
function rewriteIconLayout(): void {
  const resources = join(stableApp, 'Contents', 'Resources')
  const appDir = join(resources, 'app')
  const dark = join(appDir, 'cat5_dark.icns')
  if (existsSync(dark)) {
    renameSync(dark, join(resources, 'AppIconDark.icns'))
  }
  for (const surplus of ['cat5_light.icns', 'cat5_dark.icns']) {
    const path = join(appDir, surplus)
    if (existsSync(path)) rmSync(path)
  }
}

/**
 * The stable app is a copy of the dev build; its dev markers must not ship.
 * The Electrobun SDK derives its install-root name from the channel, and the
 * host treats a dev root as license to start the repository's dev watcher —
 * a stable channel keeps the app off the build machine's checkout.
 */
function rewriteDevMarkers(): void {
  const infoPlist = join(stableApp, 'Contents', 'Info.plist')
  writeFileSync(infoPlist, readFileSync(infoPlist, 'utf8').replace('<string>Colaw-dev</string>', '<string>Colaw</string>'))
  const versionJson = join(stableApp, 'Contents', 'Resources', 'version.json')
  const version = JSON.parse(readFileSync(versionJson, 'utf8')) as Record<string, unknown>
  // The Updater keys releases off this hash (manifest comparison, `{prefix}-{hash}.patch`
  // discovery); it must be content-stable and match /^[a-z0-9]{1,13}$/. The
  // update server root comes from the build environment; empty disables checks.
  const contentHash = createHash('sha256')
  ;(function hashTree(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      const identity = statSync(path)
      contentHash.update(entry)
      if (identity.isDirectory()) hashTree(path)
      else contentHash.update(readFileSync(path))
    }
  })(stableApp)
  const updateBaseUrl = process.env.COLAW_UPDATE_BASE_URL ?? ''
  writeFileSync(versionJson, `${JSON.stringify({
    ...version,
    name: 'Colaw',
    channel: 'stable',
    hash: contentHash.digest('hex').slice(0, 12),
    baseUrl: updateBaseUrl,
  })}\n`)
  const buildJson = join(stableApp, 'Contents', 'Resources', 'build.json')
  const build = JSON.parse(readFileSync(buildJson, 'utf8')) as Record<string, unknown>
  writeFileSync(buildJson, `${JSON.stringify({ ...build, buildEnvironment: 'stable' })}\n`)
}

/**
 * Verify the artifact: no symlinks or source files under Resources/app, and
 * every bare import of every emitted bundle resolves inside the app's plane.
 */
function auditApp(closure: Closure): void {
  const offending: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        offending.push(`symlink ${path} -> ${readlinkSync(path)}`)
        continue
      }
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.isFile()) {
        // Product packages keep their runtime TypeScript (loader-mounted by
        // name through string references; Bun executes it natively), and the
        // Electrobun devkit ships its TypeScript projection whole for the
        // same reason — the Bun main process executes it, and bundling it
        // would split its process-global native layer across units.
        const productSource = (path.includes(`${sep}node_modules${sep}@deepseek-ai${sep}`) && path.includes(`${sep}src${sep}`))
          || path.includes(`${sep}node_modules${sep}electrobun${sep}api${sep}`)
        if (/\.(?:ts|tsx|map)$/u.test(entry.name) && !productSource) offending.push(`source artifact ${path}`)
        if (entry.name.startsWith('tsconfig') || entry.name.startsWith('README.')) offending.push(`metadata ${path}`)
      }
    }
  }
  walk(appResourcesApp)

  const resolvable = (spec: string, fromDir: string): boolean => {
    const name = packageRootName(spec)
    let dir = fromDir
    while (dir.startsWith(appResourcesApp)) {
      if (isFile(join(dir, 'node_modules', name, 'package.json'))) return true
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
    return false
  }
  const missing = new Set<string>()
  const bundleFiles: string[] = [join(appResourcesApp, 'bun', 'index.js')]
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
        // Conditional build variants Node never resolves under the app's
        // conditions (browser/native overrides of a node entry).
        if (/\.(?:browser|native)\.[cm]?js$/u.test(entry.name)) continue
        bundleFiles.push(path)
      }
    }
  }
  collect(closureRoot)
  for (const file of bundleFiles) {
    let imports: { path: string }[] = []
    try {
      imports = new bun.Transpiler({ loader: 'js' }).scanImports(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const imported of imports) {
      if (isBare(imported.path) && !closure.unresolved.has(imported.path) && !resolvable(imported.path, dirname(file))) {
        missing.add(`${imported.path} (from ${relative(stableApp, file)})`)
      }
    }
  }
  if (offending.length > 0 || missing.size > 0) {
    for (const line of offending.slice(0, 10)) console.error(`pack-stable-app: ${line}`)
    for (const key of [...missing].slice(0, 10)) console.error(`pack-stable-app: unresolved import ${key}`)
    console.error(`pack-stable-app: audit failed (${String(offending.length)} artifact issues, ${String(missing.size)} unresolved imports)`)
    process.exit(1)
  }
  if (closure.unresolved.size > 0) {
    console.log(`pack-stable-app: unshipped optional imports: ${[...closure.unresolved].sort().join(', ')}`)
  }
  console.log(
    `pack-stable-app: closure ${String(closure.packages.size)} packages, ${String(closure.units.size)} units, `
    + `${String(closure.verbatim.size)} verbatim files`,
  )
}

function reportSize(): void {
  const sizeOf = (dir: string): number => {
    let bytes = 0
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) bytes += statSync(path).size
      }
    }
    walk(dir)
    return bytes
  }
  const total = sizeOf(stableApp)
  const modules = sizeOf(join(appResourcesApp, 'node_modules'))
  const install = sizeOf(installDir)
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  console.log(`pack-stable-app: published ${stableApp}`)
  console.log(`pack-stable-app: shell ${mb(total - modules - install)}, node_modules ${mb(modules)}, install ${mb(install)}`)
  console.log(`pack-stable-app: app size ${mb(total)}`)
}

/** Copy the packed payload out of the build tree before the official stable build replaces it. */
function stageStableApp(): void {
  const stagingRoot = process.env.COLAW_PACK_STAGING
  if (stagingRoot === undefined || stagingRoot === '') return
  const stagedApp = join(stagingRoot, 'Colaw.app')
  rmSync(stagedApp, { recursive: true, force: true })
  mkdirSync(stagingRoot, { recursive: true })
  cpSync(stableApp, stagedApp, { recursive: true })
  console.log(`pack-stable-app: staged ${stagedApp}`)
}

async function main(): Promise<void> {
  ensureBuilds()
  run(
    process.execPath,
    [join(hostDir, 'node_modules', 'electrobun', 'bin', 'electrobun.cjs'), 'build'],
    hostDir,
    { ...process.env, COLAW_PACK_BOOTSTRAP: '1' },
  )

  publishStableApp()

  const { entries: entryNames, bundles: bundleNames } = composeProfileEntries()
  console.log(`pack-stable-app: profile composes ${String(entryNames.length)} plugin entries over ${String(bundleNames.length)} bundles`)
  const closure = analyzeClosure(entryNames, bundleNames)

  rmSync(closureRoot, { recursive: true, force: true })
  rmSync(installDir, { recursive: true, force: true })
  mkdirSync(closureRoot, { recursive: true })
  mkdirSync(installDir, { recursive: true })

  const packageNames = [...closure.packages.keys()].sort()
  let cursor = 0
  while (cursor < packageNames.length) {
    const batch = packageNames.slice(cursor, cursor + BUILD_POOL)
    await Promise.all(batch.map(async (pkg) => {
      const record = closure.packages.get(pkg)
      if (record === undefined) throw new Error(`pack-stable-app: package ${pkg} left the closure during emission`)
      const { dir } = record
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
      await emitPackage(pkg, dir, closure, manifest)
    }))
    cursor += BUILD_POOL
    console.log(`pack-stable-app: packaged ${String(Math.min(cursor, packageNames.length))}/${String(packageNames.length)}`)
  }

  const cliManifest = JSON.parse(readFileSync(cliAnchor, 'utf8')) as { version?: string }
  const installDependencies: Record<string, string> = {}
  for (const pkg of packageNames) {
    const record = closure.packages.get(pkg)
    if (record === undefined) throw new Error(`pack-stable-app: package ${pkg} left the closure during emission`)
    const version = (JSON.parse(readFileSync(join(record.dir, 'package.json'), 'utf8')) as { version?: string }).version
    installDependencies[pkg] = typeof version === 'string' ? version : '0.0.0'
  }
  writeFileSync(join(installDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: typeof cliManifest.version === 'string' ? cliManifest.version : '0.0.0',
    private: true,
    type: 'module',
    dependencies: installDependencies,
  }, undefined, 2)}\n`)

  await emitHostBundle(closure)
  auditApp(closure)
  reportSize()
  stageStableApp()
}

await main()
