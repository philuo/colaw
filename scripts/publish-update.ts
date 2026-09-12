/**
 * Publish an Electrobun-update release set from the packed stable app:
 *
 * - `<prefix>-Colaw.app.tar.zst` — the full bundle artifact the manifest names.
 * - `<prefix>-update.json` — the UpdateManifestV1 the Updater polls
 *   (`GET {baseUrl}/{prefix}-update.json`, cache-busted).
 * - `<prefix>-<previousHash>.patch` — a classic bsdiff from the previous
 *   published tar to this one, so an installed build at `previousHash`
 *   downloads kilobytes instead of the whole bundle (the Updater probes
 *   `{prefix}-{its hash}.patch` first and falls back to the full tar).
 *
 * `prefix` = `stable-macos-arm64` (channel-platform-arch), matching the
 * packed app's version.json identity. The previous release is discovered as
 * the newest already-published `*-update.json` in the output directory.
 * Publish from the SAME directory each time so the patch chain exists.
 *
 * Usage: bun scripts/publish-update.ts <output-dir> [--base-url <url>]
 * The base URL defaults to `http://127.0.0.1:8123` (local verification
 * server); production sets it to the real update host.
 *
 * Bun only, by fork policy.
 * @module scripts/publish-update
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = process.cwd()
const appFlag = process.argv.indexOf('--app')
const app = appFlag >= 0
  ? resolve(process.argv[appFlag + 1] ?? '')
  : join(repo, 'apps/electrobun-host/build/stable-macos-arm64/Colaw.app')
if (!existsSync(app)) {
  console.error('publish-update: stable app missing — run the pack first')
  process.exit(1)
}
const outDir = process.argv[2]
if (outDir === undefined) {
  console.error('publish-update: usage <output-dir> [--base-url <url>]')
  process.exit(1)
}
const baseUrlFlag = process.argv.indexOf('--base-url')
const baseUrl = baseUrlFlag >= 0 ? process.argv[baseUrlFlag + 1] : 'http://127.0.0.1:8123'
const notesFlag = process.argv.indexOf('--notes')
const notesFile = notesFlag >= 0 ? process.argv[notesFlag + 1] : undefined
// User-facing release notes: minimal markdown, no technical terms. The
// Updater's manifest schema ignores unknown fields, so `notes` rides along.
const notes = notesFile !== undefined && existsSync(notesFile)
  ? readFileSync(notesFile, 'utf8').trim()
  : undefined

const identity = JSON.parse(readFileSync(join(app, 'Contents/Resources/version.json'), 'utf8')) as {
  identifier: string, channel: string, version: string, hash: string
}
const prefix = `${identity.channel}-macos-arm64`

const spawn = (cmd: string, args: readonly string[]): void => {
  const result = (globalThis as unknown as { Bun: {
    spawnSync: (c: readonly string[], o: object) => { exitCode: number | null }
  } }).Bun.spawnSync([cmd, ...args], { stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) {
    console.error(`publish-update: ${cmd} ${args.join(' ')} exited ${String(result.exitCode)}`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })

// 1. Full tar.zst of the bundle.
const tarName = `${prefix}-Colaw.app.tar.zst`
const tarPath = join(outDir, tarName)
spawn('/usr/bin/tar', ['--zstd', '-cf', tarPath, '-C', join(app, '..'), 'Colaw.app'])

// 2. Manifest.
const manifest = {
  schemaVersion: 1,
  identifier: identity.identifier,
  channel: identity.channel,
  version: identity.version,
  hash: identity.hash,
  platform: 'macos',
  arch: 'arm64',
  artifact: { file: tarName },
}
const manifestPath = join(outDir, `${prefix}-update.json`)

// 3. bsdiff on the UNCOMPRESSED tars — the updater's patch chain applies to
// the decompressed {hash}.tar it retains, and a compressed-stream diff would
// be megabytes where a source-level change is kilobytes (measured: 63KB for a
// one-byte source delta vs 7.3MB when diffing the zst layer).
if (existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8')) as { hash: string, artifact: { file: string } }
  if (previous.hash !== identity.hash) {
    const previousTarZst = join(outDir, previous.artifact.file)
    if (existsSync(previousTarZst)) {
      spawn('/opt/homebrew/bin/zstd', ['-d', '-q', '-f', previousTarZst, '-o', join(outDir, '.prev.tar')])
      spawn('/opt/homebrew/bin/zstd', ['-d', '-q', '-f', tarPath, '-o', join(outDir, '.next.tar')])
      const patchPath = join(outDir, `${prefix}-${previous.hash}.patch`)
      const py = [
        'import bsdiff4, tarfile, io, json, os, sys',
        `old = open(${JSON.stringify(join(outDir, '.prev.tar'))}, 'rb').read()`,
        `new = open(${JSON.stringify(join(outDir, '.next.tar'))}, 'rb').read()`,
        `patch = bsdiff4.diff(old, new)`,
        `assert bsdiff4.patch(old, patch) == new, 'round-trip mismatch'`,
        `open(${JSON.stringify(patchPath)}, 'wb').write(patch)`,
        // The tar's embedded version.json must name the manifest's hash, or
        // the updater will reject the patched archive after applying it.
        `tf = tarfile.open(${JSON.stringify(join(outDir, '.next.tar'))})`,
        `vj = json.load(tf.extractfile('Colaw.app/Contents/Resources/version.json'))`,
        `assert vj['hash'] == ${JSON.stringify(identity.hash)}, 'tar version.json hash mismatch: ' + vj['hash']`,
        `print('patch bytes:', len(patch), 'full zst bytes:', os.path.getsize(${JSON.stringify(tarPath)}))`,
      ].join('\n')
      const tmpPy = join(outDir, '.make-patch.py')
      writeFileSync(tmpPy, py)
      spawn('/usr/bin/env', ['python3', tmpPy])
      console.log(`publish-update: tar-level patch ${previous.hash} → ${identity.hash} (round-trip + embedded hash verified)`)
    }
  }
}

writeFileSync(manifestPath, `${JSON.stringify(
  notes === undefined || notes === '' ? manifest : { ...manifest, notes },
  undefined, 2,
)}\n`)
console.log(`publish-update: published ${identity.version} (${identity.hash}) → ${outDir}`)
console.log(`publish-update: manifest ${manifestPath}; artifact ${tarName}`)
for (const temp of ['.prev.tar', '.next.tar', '.make-patch.py', '.verify-patch.py', '.verify.tar']) {
  if (existsSync(join(outDir, temp))) spawn('/bin/rm', ['-f', join(outDir, temp)])
}
console.log(`publish-update: build the app with COLAW_UPDATE_BASE_URL=${baseUrl} for this server`)
