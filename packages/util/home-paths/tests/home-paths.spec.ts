import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  LEGACY_DSH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  migrateLegacyDshHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default Colaw home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.colaw')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.colaw')
    expect(defaultDshHome()).toBe(join(homedir(), '.colaw'))
    expect(LEGACY_DSH_HOME_DIR_NAME).toBe('.dsh')
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.colaw')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  describe('legacy home migration', () => {
    // Every case passes an explicit temp home. The function reads `homedir()`
    // by default, so a test that relies on the ambient home would create,
    // rename, and — in the legacy-absent/current-present case — delete the
    // real `~/.colaw`. That happened once; injecting the root keeps the suite
    // physically incapable of repeating it (stubbing HOME is not enough:
    // `os.homedir()` ignores it under Bun).
    let home: string

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-legacy-home-'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      await rm(home, { recursive: true, force: true })
    })

    it('moves a legacy ~/.dsh to the current home when the current one is absent', () => {
      const legacy = join(home, LEGACY_DSH_HOME_DIR_NAME)
      const current = join(home, DSH_HOME_DIR_NAME)
      mkdirSync(legacy, { recursive: true })

      expect(migrateLegacyDshHome({}, home)).toBe(legacy)
      expect(existsSync(current)).toBe(true)
      expect(existsSync(legacy)).toBe(false)
      expect(migrateLegacyDshHome({}, home)).toBeUndefined()
    })

    it('leaves both homes alone when the current one already exists', () => {
      const legacy = join(home, LEGACY_DSH_HOME_DIR_NAME)
      const current = join(home, DSH_HOME_DIR_NAME)
      mkdirSync(legacy, { recursive: true })
      mkdirSync(current, { recursive: true })
      const marker = join(current, 'settings.yaml')
      writeFileSync(marker, 'kept\n')

      expect(migrateLegacyDshHome({}, home)).toBeUndefined()
      expect(existsSync(legacy)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toBe('kept\n')
    })

    it('never migrates when the environment owns the home location', () => {
      expect(migrateLegacyDshHome({ DSH_HOME: '~/env-dsh' }, home)).toBeUndefined()
    })
  })

  it.each([
    [undefined, join(homedir(), '.colaw')],
    ['', join(homedir(), '.colaw')],
    ['   ', join(homedir(), '.colaw')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
