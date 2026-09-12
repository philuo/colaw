/**
 * postWrap hook for `hutch electrobun build --env=stable`: merge the packed
 * product's payload into the shell Hutch just built. The packer owns the
 * plugin closure (Resources/app, Resources/install) and the two theme icons;
 * Hutch owns the runtime shell and — critically — version.json (its hash is
 * the updater's release identity, computed by the official algorithm) and the
 * release artifacts (tar.zst, update.json, delta patches).
 *
 * Usage: bun scripts/merge-stable-payload.ts <staged-Colaw.app>
 * Bun only, by fork policy.
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const staged = process.env.COLAW_PACK_STAGING
  ? `${process.env.COLAW_PACK_STAGING}/Colaw.app`
  : '/tmp/pack-staging/Colaw.app'
if (staged === undefined || !existsSync(join(staged, 'Contents/Resources/app'))) {
  console.error(`merge-stable-payload: staged payload missing: ${staged ?? '(no argument)'}`)
  process.exit(1)
}
const built = join(process.cwd(), 'build/stable-macos-arm64/Colaw.app')
const from = (rel: string): string => join(staged, 'Contents/Resources', rel)
const to = (rel: string): string => join(built, 'Contents/Resources', rel)
for (const rel of ['app', 'install', 'AppIcon.icns', 'AppIconDark.icns']) {
  if (existsSync(from(rel))) cpSync(from(rel), to(rel), { recursive: true })
}
console.log(`merge-stable-payload: merged app/install/icons into ${built}`)
