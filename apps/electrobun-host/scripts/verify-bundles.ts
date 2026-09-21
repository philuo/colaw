/**
 * verify-bundles.ts — prove the staging bundle closure is self-consistent:
 * every collected package resolves from the staging root, and the two web
 * profile bundles actually load (their full dependency chain is present).
 *
 * Bun only. Run after prepare-bundles.ts.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

const HOST_ROOT = join(import.meta.dir, '..')
const STAGING_MODULES = join(HOST_ROOT, '.bundle-staging', 'node_modules')

const require = createRequire(join(STAGING_MODULES, 'probe.js'))
const names = readdirSync(join(STAGING_MODULES, '@deepseek-ai')).map(n => `@deepseek-ai/${n}`)
const scoped = new Set(readdirSync(STAGING_MODULES).filter(e => e.startsWith('@')).map(s => readdirSync(join(STAGING_MODULES, s)).map(n => `${s}/${n}`)).flat())
const flat = readdirSync(STAGING_MODULES).filter(e => !e.startsWith('@'))
const all = [...names, ...scoped, ...flat]

let ok = 0
const broken: string[] = []
for (const name of all) {
  // Bare-name resolve fails legitimately for exports-only packages (main:
  // false, no "." export). Every package must at least resolve its
  // package.json subpath; the import checks below are the hard test.
  try {
    require.resolve(name)
    ok++
  } catch {
    try {
      require.resolve(`${name}/package.json`)
      ok++
    } catch (e) {
      broken.push(`${name}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
}
console.log(`[verify-bundles] resolved ${ok}/${all.length} closure packages`)
if (broken.length > 0) {
  console.error(`[verify-bundles] FAILED to resolve:\n  ${broken.join('\n  ')}`)
  process.exit(1)
}

// The two web profile bundles must load completely (dependency chain intact).
const loader = async (spec: string): Promise<void> => {
  try {
    await import(join(STAGING_MODULES, spec))
    console.log(`[verify-bundles] loaded ${spec}`)
  } catch (e) {
    console.error(`[verify-bundles] FAILED to load ${spec}: ${(e as Error).message}`)
    process.exit(1)
  }
}
await loader('@deepseek-ai/dsh-base/lib/index.js')
await loader('@deepseek-ai/dsh-web-app/lib/index.js')

// The frontend dist must be present (webServer serves it).
const { existsSync } = await import('node:fs')
const frontendIndex = join(STAGING_MODULES, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
if (!existsSync(frontendIndex)) {
  console.error('[verify-bundles] FAILED: frontend dist/index.html missing')
  process.exit(1)
}
console.log(`[verify-bundles] frontend dist present (${frontendIndex})`)

console.log('[verify-bundles] ALL CHECKS PASSED')
