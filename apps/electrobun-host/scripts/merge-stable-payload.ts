/**
 * postWrap hook for `hutch electrobun build --env=stable`: merge the packed
 * product's payload into the shell Hutch just built. The packer owns the
 * plugin closure (Resources/app, Resources/install) and the two theme icons;
 * Hutch owns the runtime shell and — critically — version.json (its hash is
 * the updater's release identity, computed by the official algorithm) and the
 * release artifacts (tar.zst, update.json, delta patches).
 *
 * The packer's bootstrap dev build sets COLAW_PACK_BOOTSTRAP=1 because no
 * packed payload exists until that build supplies the shell. The official
 * stable build runs this hook without that marker and requires the staged app.
 *
 * Usage: bun scripts/merge-stable-payload.ts
 * Bun only, by fork policy.
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.COLAW_PACK_BOOTSTRAP === '1') {
  console.log('merge-stable-payload: skipped for the bootstrap dev build')
} else {
  const staged = process.env.COLAW_PACK_STAGING
    ? `${process.env.COLAW_PACK_STAGING}/Colaw.app`
    : '/tmp/pack-staging/Colaw.app'
  if (!existsSync(join(staged, 'Contents/Resources/app'))) {
    console.error(`merge-stable-payload: staged payload missing: ${staged}`)
    process.exit(1)
  }
  const built = join(process.cwd(), 'build/stable-macos-arm64/Colaw.app')
  const from = (rel: string): string => join(staged, 'Contents/Resources', rel)
  const to = (rel: string): string => join(built, 'Contents/Resources', rel)
  for (const rel of ['app', 'install', 'AppIcon.icns', 'AppIconDark.icns']) {
    if (existsSync(from(rel))) cpSync(from(rel), to(rel), { recursive: true })
  }
  console.log(`merge-stable-payload: merged app/install/icons into ${built}`)
}
