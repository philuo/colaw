/**
 * Stage Electrobun's official drag-to-Applications DMG under the stable
 * release filename. Hutch already builds the image with Colaw.app and the
 * /Applications symlink, so release packaging needs no Finder automation.
 *
 * Usage: bun scripts/build-dmg.ts
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const repo = process.cwd()
const source = join(repo, 'apps/electrobun-host/artifacts/macos-arm64-Colaw.dmg')
const destination = join(repo, 'apps/electrobun-host/build/stable-macos-arm64/Colaw.dmg')

if (!existsSync(source)) {
  console.error(`official Electrobun DMG missing: ${source}`)
  process.exit(1)
}
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
console.log(`published ${destination}`)
