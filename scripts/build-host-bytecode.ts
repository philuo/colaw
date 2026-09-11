// Builds the host entry as a bytecode-cached CJS bundle. This runs under the
// app's bundled Bun, not the machine's: JSC bytecode is version-locked, and a
// sidecar built by any other Bun is silently ignored at load time.
//
// The repo's node_modules copy of `electrobun` is a stub that throws on import
// (Electrobun 2.x ships its API through the Hutch devkit projection), and Bun
// 1.4's bundler has no alias option — so the build runs from a scratch root
// whose node_modules links `electrobun` at the devkit, with the host's own
// sources copied in beside the entry.
import { copyFileSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const [entryDir, outdir, devkit, ...externals] = process.argv.slice(2)
if (entryDir === undefined || outdir === undefined || devkit === undefined) {
  console.error('build-host-bytecode: usage <entry-dir> <outdir> <devkit-dir> [externals...]')
  process.exit(1)
}
const root = `${outdir}.buildroot`
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'node_modules'), { recursive: true })
symlinkSync(devkit, join(root, 'node_modules', 'electrobun'))
for (const name of readdirSync(entryDir)) {
  if (name.endsWith('.ts')) copyFileSync(join(entryDir, name), join(root, name))
}
try {
  // Same globalThis cast idiom as pack-stable-app.ts: the scripts' tsconfig
  // has no @types/bun, but this file always runs under the app's Bun.
  const bunBuild = (globalThis as unknown as {
    Bun: { build: (options: Record<string, unknown>) => Promise<{ success: boolean; logs: unknown[] }> }
  }).Bun.build
  const result = await bunBuild({
    entrypoints: [join(root, 'index.ts')],
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
  rmSync(root, { recursive: true, force: true })
}
