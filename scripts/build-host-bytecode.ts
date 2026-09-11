// Builds the host entry as a bytecode-cached CJS bundle. This runs under the
// app's bundled Bun, not the machine's: JSC bytecode is version-locked, and a
// sidecar built by any other Bun is silently ignored at load time.
//
// The repo's node_modules copy of `electrobun` is a stub that throws on import
// (Electrobun 2.x ships its API through the Hutch devkit projection), and Bun
// 1.4's bundler has no alias option — so the build needs a node_modules whose
// `electrobun` links the devkit. The scratch root is the OUTPUT directory
// itself: JSC bytecode embeds the source path it was compiled from and hands
// it back as the module's `__filename` at runtime, so building from anywhere
// else freezes that location into every relative resolution (icons, the
// overlay config) and silently points copied apps at the build machine's
// checkout. Building beside the final index.js keeps them the same directory;
// the scaffolding is removed afterwards, leaving index.js and its sidecar.
import { copyFileSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const [entryDir, outdir, devkit, ...externals] = process.argv.slice(2)
if (entryDir === undefined || outdir === undefined || devkit === undefined) {
  console.error('build-host-bytecode: usage <entry-dir> <outdir> <devkit-dir> [externals...]')
  process.exit(1)
}
const sources: string[] = []
for (const name of readdirSync(entryDir)) {
  if (!name.endsWith('.ts')) continue
  copyFileSync(join(entryDir, name), join(outdir, name))
  sources.push(name)
}
const modules = join(outdir, 'node_modules')
try {
  mkdirSync(modules)
  symlinkSync(devkit, join(modules, 'electrobun'))
  // Same globalThis cast idiom as pack-stable-app.ts: the scripts' tsconfig
  // has no @types/bun, but this file always runs under the app's Bun.
  const bunBuild = (globalThis as unknown as {
    Bun: { build: (options: Record<string, unknown>) => Promise<{ success: boolean; logs: unknown[] }> }
  }).Bun.build
  const result = await bunBuild({
    entrypoints: [join(outdir, 'index.ts')],
    target: 'bun',
    format: 'cjs',
    minify: true,
    bytecode: true,
    external: externals,
    outdir,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(`  bun-build: ${String(log)}`)
    process.exit(1)
  }
} finally {
  for (const name of sources) rmSync(join(outdir, name))
  rmSync(modules, { recursive: true, force: true })
}
