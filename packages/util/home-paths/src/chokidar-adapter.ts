/**
 * File watcher adapter using native fs.watch (replaces chokidar).
 *
 * Uses Node.js built-in fs.watch with manual debounce and atomic-write-safe
 * watching. Works identically in both Bun and Node.js.
 *
 * Key design: when watching a single FILE, we watch its PARENT DIRECTORY and
 * filter for the target basename. This is required because atomic writers
 * (write-temp-then-rename, e.g. writeFileAtomic) replace the inode: a watcher
 * bound directly to the file loses track after the first rename. The parent
 * directory keeps a stable inode, so it sees every replacement. This mirrors
 * what chokidar does internally.
 *
 * @module @deepseek-ai/dsh-home-paths/chokidar-adapter
 */

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Watch options (subset of chokidar options, for API compatibility). */
export interface WatchOptions {
  persistent?: boolean
  ignoreInitial?: boolean
  depth?: number
  followSymlinks?: boolean
  atomic?: boolean | number
  awaitWriteFinish?: {
    stabilityThreshold?: number
    pollInterval?: number
  }
  usePolling?: boolean
  interval?: number
}

/** Watch event types. */
export type WatchEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'all'

/** Path-bearing events (add/change/unlink/...) carry the affected path. */
type PathEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

/** Watcher interface (subset of chokidar FSWatcher, for API compatibility). */
export interface Watcher {
  on(event: PathEvent, listener: (path: string) => void): Watcher
  on(event: 'all', listener: (event: WatchEvent, path: string) => void): Watcher
  on(event: 'ready', listener: () => void): Watcher
  on(event: 'error', listener: (error: Error) => void): Watcher
  once(event: PathEvent, listener: (path: string) => void): Watcher
  once(event: 'all', listener: (event: WatchEvent, path: string) => void): Watcher
  once(event: 'ready', listener: () => void): Watcher
  once(event: 'error', listener: (error: Error) => void): Watcher
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// fs.watch implementation (works in both Bun and Node.js)
// ---------------------------------------------------------------------------

class FsWatcher implements Watcher {
  private watcher: FSWatcher | undefined
  private readonly targetPath: string
  private readonly watchPath: string
  private readonly isFileTarget: boolean
  private readonly targetBasename: string
  private readonly options: WatchOptions
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly stabilityThreshold: number
  /** Per-path existence tracking, so directory watchers classify add vs change. */
  private readonly knownPaths = new Set<string>()
  /** Extra recursive watchers bound to the real targets of followed symlinks. */
  private readonly symlinkWatchers: FSWatcher[] = []
  /** In-tree symlink paths we already bound a target watcher to (no duplicates). */
  private readonly followedLinks = new Set<string>()
  /** Periodic root-existence probe (native fs.watch never reports root removal). */
  private livenessTimer: ReturnType<typeof setInterval> | undefined
  private rootExisted = true
  private closed = false
  private readyEmitted = false

  constructor(path: string, options?: WatchOptions) {
    this.targetPath = path
    this.options = options ?? {}
    this.stabilityThreshold = this.options.awaitWriteFinish?.stabilityThreshold ?? 100

    // Heuristic: a path that currently exists as a file, or whose basename
    // carries an extension, is watched via its parent directory. A directory
    // path is watched directly. Missing paths default to parent-directory
    // watching (safe for files created later).
    this.isFileTarget = this.looksLikeFile(path)
    if (this.isFileTarget) {
      this.watchPath = dirname(path)
      this.targetBasename = basename(path)
    } else {
      this.watchPath = path
      this.targetBasename = ''
    }

    // Seed existence state so the first post-watch event on an already-present
    // target is classified as change (not add). For a single-file target this
    // is just that file; for a directory, seed its current entries.
    this.seedKnownPaths(path)

    // Emit ready after a short delay (chokidar emits ready after initial scan)
    setTimeout(() => {
      if (!this.closed && !this.readyEmitted) {
        this.readyEmitted = true
        this.emit('ready')
      }
    }, 50)

    this.startWatching()
    // Native recursive fs.watch does not cross a symlink that points outside
    // the watched tree, so emulate chokidar's followSymlinks by binding extra
    // watchers to the real targets of child symlinked directories.
    this.followChildSymlinks()
    // Native fs.watch never reports removal of the watched root itself (when
    // the root is deleted together with its parent), so probe root existence.
    this.startLivenessPoll()
  }

  /**
   * Decide whether a path refers to a single file (watch parent) or a
   * directory (watch directly).
   */
  private looksLikeFile(target: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { lstatSync } = require('node:fs') as typeof import('node:fs')
      return lstatSync(target).isFile()
    } catch {
      // Path missing: treat a basename with an extension as a file.
      return basename(target).includes('.')
    }
  }

  /** Record which paths already exist (for add/change classification). */
  private seedKnownPaths(target: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeFs = require('node:fs') as typeof import('node:fs')
      if (this.isFileTarget) {
        if (nodeFs.existsSync(target)) this.knownPaths.add(target)
      } else {
        // Seed the directory itself and its immediate entries.
        this.knownPaths.add(target)
        for (const entry of nodeFs.readdirSync(target)) {
          this.knownPaths.add(join(target, entry))
        }
      }
    } catch {
      // Best effort; missing paths simply start with an empty known set.
    }
  }

  private startWatching(): void {
    try {
      if (this.isFileTarget) {
        // Watch the parent directory (stable inode) and filter for our file.
        this.watcher = fsWatch(this.watchPath, { recursive: false }, (eventType, filename) => {
          if (this.closed) return
          if (!filename) return
          if (basename(filename) !== this.targetBasename) return
          this.handleEvent(eventType, this.targetPath)
        })
      } else {
        // Watch the directory itself, recursively.
        this.watcher = fsWatch(this.watchPath, { recursive: true }, (eventType, filename) => {
          if (this.closed) return
          const filePath = filename ? join(this.watchPath, filename) : this.watchPath
          this.handleEvent(eventType, filePath)
        })
      }

      this.watcher.on('error', (error: Error) => {
        this.emit('error', error)
      })
    } catch (error) {
      this.emit('error', error as Error)
    }
  }

  /**
   * Bind extra watchers to the real targets of every direct-child symlinked
   * directory of a watched directory. Native recursive fs.watch (both Node and
   * Bun on macOS) does not follow a symlink that points outside the watched
   * tree, so writes through the link are invisible without this. Chokidar's
   * followSymlinks (default true) does the equivalent resolution internally.
   */
  private followChildSymlinks(): void {
    if (this.isFileTarget || this.options.followSymlinks === false) return
    let entries: string[]
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeFs = require('node:fs') as typeof import('node:fs')
      entries = nodeFs.readdirSync(this.watchPath)
    } catch {
      return
    }
    for (const entry of entries) {
      this.followSymlink(join(this.watchPath, entry))
    }
  }

  /**
   * If `linkPath` is a symlink to a directory, watch its real target and map
   * every target event back onto the in-tree symlink path. No-op for ordinary
   * directories, broken links, or links already followed.
   */
  private followSymlink(linkPath: string): void {
    if (this.closed || this.followedLinks.has(linkPath) || this.options.followSymlinks === false) return
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('node:fs') as typeof import('node:fs')
    let linkStats
    try {
      linkStats = nodeFs.lstatSync(linkPath)
    } catch {
      return
    }
    if (!linkStats.isSymbolicLink()) return
    let realTarget: string
    try {
      realTarget = nodeFs.realpathSync(linkPath)
      // stat (not lstat): follow the link to learn whether the target is a dir.
      if (!nodeFs.statSync(realTarget).isDirectory()) return
    } catch {
      return // Broken/dangling symlink: nothing safe to follow.
    }
    this.followedLinks.add(linkPath)
    this.seedFollowedTarget(linkPath, realTarget, new Set<string>())
    try {
      const targetWatcher = fsWatch(realTarget, { recursive: true }, (eventType, filename) => {
        if (this.closed) return
        // Target reports paths relative to realTarget; rebase onto the link.
        const mappedPath = filename ? join(linkPath, filename) : linkPath
        this.handleEvent(eventType, mappedPath)
      })
      targetWatcher.on('error', (error: Error) => {
        this.emit('error', error)
      })
      this.symlinkWatchers.push(targetWatcher)
    } catch (error) {
      this.followedLinks.delete(linkPath)
      this.emit('error', error as Error)
    }
  }

  /** Record a followed target's existing entries under their mapped (link) paths. */
  private seedFollowedTarget(linkPath: string, realDir: string, seen: Set<string>): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('node:fs') as typeof import('node:fs')
    let real: string
    try {
      real = nodeFs.realpathSync(realDir)
    } catch {
      return
    }
    if (seen.has(real)) return // Defend against symlink cycles.
    seen.add(real)
    if (seen.size > 32) return // Bound recursion on pathological trees.
    let dirents
    try {
      dirents = nodeFs.readdirSync(real, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      const mapped = join(linkPath, dirent.name)
      this.knownPaths.add(mapped)
      if (dirent.isDirectory()) {
        this.seedFollowedTarget(mapped, join(realDir, dirent.name), seen)
      }
    }
  }

  /**
   * Poll the watched directory's existence. Verified on macOS arm64 (Node 22
   * and Bun 1.4): when the watched root is removed together with its parent
   * tree, recursive fs.watch delivers NO event (not for children, nor for the
   * root), yet the handle stays alive and resumes after a same-path recreate.
   * Chokidar closes that gap with its own stat polling; emit unlinkDir/addDir
   * for the root here so consumers can rewatch / rescan.
   */
  private startLivenessPoll(): void {
    if (this.isFileTarget) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeFs = require('node:fs') as typeof import('node:fs')
      this.rootExisted = nodeFs.existsSync(this.watchPath)
    } catch {
      this.rootExisted = false
    }
    // Honor the caller's polling cadence but clamp to avoid a busy syscall loop.
    const requested = this.options.interval ?? 100
    const period = Math.min(Math.max(requested, 20), 1_000)
    this.livenessTimer = setInterval(() => {
      this.checkRootLiveness()
    }, period)
    // Don't keep the event loop alive solely for this probe.
    const timer = this.livenessTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  private checkRootLiveness(): void {
    if (this.closed) return
    let exists: boolean
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeFs = require('node:fs') as typeof import('node:fs')
      exists = nodeFs.existsSync(this.watchPath)
    } catch {
      exists = false
    }
    if (this.rootExisted === exists) return
    this.rootExisted = exists
    if (!exists) {
      // Root vanished: its child symlink targets are gone with it.
      this.closeSymlinkWatchers()
      this.knownPaths.clear()
      this.emit('all', 'unlinkDir', this.watchPath)
      this.emit('unlinkDir', this.watchPath)
      return
    }
    // Same-path recreate: rebuild existence/symlink state and announce it.
    this.seedKnownPaths(this.watchPath)
    this.followChildSymlinks()
    this.emit('all', 'addDir', this.watchPath)
    this.emit('addDir', this.watchPath)
  }

  /** Close only the extra symlink-target watchers (used on root removal). */
  private closeSymlinkWatchers(): void {
    for (const targetWatcher of this.symlinkWatchers) {
      try {
        targetWatcher.close()
      } catch {
        // Best effort.
      }
    }
    this.symlinkWatchers.length = 0
    this.followedLinks.clear()
  }

  private handleEvent(eventType: 'rename' | 'change', filePath: string): void {
    if (this.closed) return
    // With ignoreInitial (chokidar default in our callers), suppress events
    // that arrive before the initial scan/ready window completes. FSEvents
    // delivers a baseline notification when a watcher starts, which is not a
    // real change and must not be re-emitted.
    if (this.options.ignoreInitial !== false && !this.readyEmitted) return

    // Debounce events to emulate awaitWriteFinish (coalesce the temp-create
    // and temp-rename pair of an atomic write into one stable event).
    const existingTimer = this.debounceTimers.get(filePath)
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath)
      void this.determineAndEmit(eventType, filePath)
    }, this.stabilityThreshold)

    this.debounceTimers.set(filePath, timer)
  }

  private async determineAndEmit(eventType: 'rename' | 'change', filePath: string): Promise<void> {
    if (this.closed) return

    let stats
    try {
      stats = await stat(filePath)
    } catch {
      // File no longer exists -> unlink.
      if (this.closed) return
      this.knownPaths.delete(filePath)
      this.emit('all', 'unlink', filePath)
      this.emit('unlink', filePath)
      return
    }

    // Re-check after the await: close() may have run during stat.
    if (this.closed) return

    if (stats.isDirectory()) {
      const existed = this.knownPaths.has(filePath)
      this.knownPaths.add(filePath)
      if (!existed) {
        // A newly appearing directory may be a freshly created symlink; bind a
        // target watcher now so later writes through it are observed. (No-op for
        // ordinary directories.)
        this.followSymlink(filePath)
        this.emit('all', 'addDir', filePath)
        this.emit('addDir', filePath)
      } else {
        this.emit('all', 'change', filePath)
        this.emit('change', filePath)
      }
      return
    }

    const existed = this.knownPaths.has(filePath)
    this.knownPaths.add(filePath)
    if (eventType === 'rename' && !existed) {
      this.emit('all', 'add', filePath)
      this.emit('add', filePath)
    } else {
      this.emit('all', 'change', filePath)
      this.emit('change', filePath)
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    if (this.closed) return
    const listeners = this.listeners.get(event)
    if (listeners !== undefined) {
      // Snapshot because a once-listener removes itself during dispatch.
      for (const listener of [...listeners]) {
        try {
          listener(...args)
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  on(event: PathEvent, listener: (path: string) => void): Watcher
  on(event: 'all', listener: (event: WatchEvent, path: string) => void): Watcher
  on(event: 'ready', listener: () => void): Watcher
  on(event: 'error', listener: (error: Error) => void): Watcher
  // Implementation signature (never[] is assignable to every typed listener).
  on(event: string, listener: (...args: never[]) => void): Watcher {
    this.addListener(event, listener as unknown as (...args: unknown[]) => void, false)
    return this
  }

  once(event: PathEvent, listener: (path: string) => void): Watcher
  once(event: 'all', listener: (event: WatchEvent, path: string) => void): Watcher
  once(event: 'ready', listener: () => void): Watcher
  once(event: 'error', listener: (error: Error) => void): Watcher
  once(event: string, listener: (...args: never[]) => void): Watcher {
    this.addListener(event, listener as unknown as (...args: unknown[]) => void, true)
    return this
  }

  private addListener(event: string, listener: (...args: unknown[]) => void, once: boolean): void {
    const wrapped: (...args: unknown[]) => void = once
      ? (...args: unknown[]) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      : listener
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)?.add(wrapped)
  }

  private removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    if (this.livenessTimer !== undefined) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = undefined
    }
    this.closeSymlinkWatchers()
    if (this.watcher !== undefined) {
      this.watcher.close()
      this.watcher = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a file watcher using native fs.watch.
 * Replaces chokidar with zero dependencies; safe for atomic rename writes.
 */
export function watch(path: string, options?: WatchOptions): Watcher {
  return new FsWatcher(path, options)
}

/** Whether running in Bun runtime (kept for API compatibility). */
export const IS_BUN = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'
