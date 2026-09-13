import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

/** Whether the current process is itself Bun — the runtime this repo mandates. */
function runningUnderBun(): boolean {
  return basename(process.execPath).toLowerCase().startsWith('bun')
}

/**
 * Pack the package with the runtime's own packer and return the tarball path.
 *
 * Under Bun (the only supported lane here) `bun pm pack` writes the tarball
 * into the package directory regardless of `--pack-destination`, and prints
 * its filename as the final stdout line. Non-Bun environments keep the
 * npm_execpath-based pnpm invocation.
 */
function pack(cwd: string, timeout: number): string {
  if (runningUnderBun()) {
    run(process.execPath, ['pm', 'pack'], cwd, timeout)
    // The tarball lands in cwd (destination flag notwithstanding) and stdout
    // line order varies by TTY — the directory is the source of truth.
    const newest = readdirSync(cwd)
      .filter(name => name.endsWith('.tgz'))
      .map(name => ({ name, mtime: statSync(join(cwd, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)[0]
    if (newest === undefined) {
      throw new Error('bun pm pack produced no tarball in the package directory')
    }
    return join(cwd, newest.name)
  }
  const entrypoint = process.env.npm_execpath
  const pnpmArgs = ['pack', '--json', '--pack-destination', cwd]
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return JSON.parse(run('pnpm', pnpmArgs, cwd, timeout)) as string
  }
  const packed = /\.[cm]?js$/iu.test(entrypoint)
    ? JSON.parse(run(process.execPath, [entrypoint, ...pnpmArgs], cwd, timeout)) as { filename: string }
    : JSON.parse(run(entrypoint, pnpmArgs, cwd, timeout)) as { filename: string }
  return join(cwd, packed.filename)
}

describe('published PDF.js licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps every bundled license in the packed client artifact', ({ task }) => {
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    let tarball = ''
    try {
      tarball = pack(packageRoot, task.timeout)
      const names = run('tar', ['-tzf', tarball], packageRoot, task.timeout).split('\n')
      expect(names.some(name => name === 'package/lib/client.js')).toBe(true)
      expect(names.some(name => name.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      const client = run('tar', ['-xOf', tarball, 'package/lib/client.js'], packageRoot, task.timeout)
      expect(client).toContain('//! Bundled PDF.js license notices')
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(client, `${name} must be visible in package/lib/client.js`).toContain(commented)
      }
    } finally {
      if (tarball !== '') rmSync(tarball, { force: true })
      rmSync(output, { recursive: true, force: true })
    }
  })
})
