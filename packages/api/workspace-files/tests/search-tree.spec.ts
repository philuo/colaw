/** The `searchTree` stream: a breadth-first host walk with caps and containment. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openWorkspace, signal, type Harness } from './harness.ts'
import type { WorkspaceTreeMatch, WorkspaceTreeSearchFrame } from '../src/index.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-search-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: { maxSearchDirs?: number; maxSearchResults?: number }): ReturnType<Harness['endpoint']> =>
  harness.endpoint(caps)

/** Drain one search stream into its frames. */
async function collect(iterable: AsyncIterable<WorkspaceTreeSearchFrame>): Promise<WorkspaceTreeSearchFrame[]> {
  const frames: WorkspaceTreeSearchFrame[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

const matchesOf = (frames: WorkspaceTreeSearchFrame[]): WorkspaceTreeMatch[] =>
  frames.filter((frame): frame is Extract<WorkspaceTreeSearchFrame, { kind: 'matches' }> =>
    frame.kind === 'matches',
  ).flatMap(frame => frame.matches)

const truncatedOf = (frames: WorkspaceTreeSearchFrame[]): boolean => {
  const done = frames[frames.length - 1]
  return done?.kind === 'done' && done.truncated
}

describe('workspaceFiles.searchTree — the stream shape', () => {
  it('opens with ready, batches matches, and closes with done', async () => {
    await writeFile(join(workspace, 'report.md'), 'x')
    const frames = await collect(endpoint().searchTree(harness.scope, '.', 'report', signal()))
    expect(frames[0]).toEqual({ kind: 'ready' })
    expect(matchesOf(frames)).toEqual([{ path: 'report.md', name: 'report.md', type: 'file' }])
    expect(frames[frames.length - 1]).toEqual({ kind: 'done', truncated: false })
  })

  it('answers an empty query with ready then done, walking nothing', async () => {
    const frames = await collect(endpoint().searchTree(harness.scope, '.', '   ', signal()))
    expect(frames).toEqual([{ kind: 'ready' }, { kind: 'done', truncated: false }])
  })
})

describe('workspaceFiles.searchTree — the walk', () => {
  it('matches deep names and keeps directories browsable', async () => {
    await mkdir(join(workspace, 'a/b/c'), { recursive: true })
    await writeFile(join(workspace, 'a/b/c/deep-report.md'), 'x')
    await writeFile(join(workspace, 'top-report.md'), 'x')
    const frames = await collect(endpoint().searchTree(harness.scope, '.', 'report', signal()))
    expect(matchesOf(frames).map(m => m.path).sort()).toEqual(['a/b/c/deep-report.md', 'top-report.md'])
    expect(truncatedOf(frames)).toBe(false)
  })

  it('matches directory names too', async () => {
    await mkdir(join(workspace, 'projects/截图2024'), { recursive: true })
    const frames = await collect(endpoint().searchTree(harness.scope, '.', '截图', signal()))
    expect(matchesOf(frames)).toEqual([{ path: 'projects/截图2024', name: '截图2024', type: 'directory' }])
  })

  it('never descends into or matches dependency/VCS directories', async () => {
    await mkdir(join(workspace, 'proj/.git'), { recursive: true })
    await mkdir(join(workspace, 'proj/node_modules/pkg'), { recursive: true })
    await writeFile(join(workspace, 'proj/.git/config'), 'x')
    await writeFile(join(workspace, 'proj/node_modules/pkg/index.js'), 'x')
    const frames = await collect(endpoint().searchTree(harness.scope, '.', 'config\\0index\\0git\\0pkg', signal()))
    expect(matchesOf(frames)).toEqual([])
    expect(truncatedOf(frames)).toBe(false)
  })

  it('skips a directory whose listing fails and still walks the rest', async () => {
    // listDirectory probes every child, so one unreadable child makes its
    // PARENT's listing throw; the walk must lose only that subtree.
    await mkdir(join(workspace, 'bad/locked'), { recursive: true })
    await mkdir(join(workspace, 'good/deep'), { recursive: true })
    await writeFile(join(workspace, 'bad/locked/secret.txt'), 'x')
    await writeFile(join(workspace, 'good/deep/target.txt'), 'x')
    await chmod(join(workspace, 'bad/locked'), 0o000)
    try {
      const frames = await collect(endpoint().searchTree(harness.scope, '.', 'target', signal()))
      expect(matchesOf(frames).map(m => m.path)).toEqual(['good/deep/target.txt'])
      expect(truncatedOf(frames)).toBe(true)
    } finally {
      await chmod(join(workspace, 'bad/locked'), 0o755)
    }
  })

  it('degrades to an empty truncated result when the root listing itself fails', async () => {
    await mkdir(join(workspace, 'locked'), { recursive: true })
    await writeFile(join(workspace, 'locked/secret.txt'), 'x')
    await chmod(join(workspace, 'locked'), 0o000)
    try {
      const frames = await collect(endpoint().searchTree(harness.scope, '.', 'target', signal()))
      expect(matchesOf(frames)).toEqual([])
      expect(truncatedOf(frames)).toBe(true)
    } finally {
      await chmod(join(workspace, 'locked'), 0o755)
    }
  })

  it('stops at the directory cap and reports truncation', async () => {
    await mkdir(join(workspace, 'd1/d2/d3'), { recursive: true })
    await writeFile(join(workspace, 'd1/d2/d3/deep.txt'), 'x')
    const frames = await collect(endpoint({ maxSearchDirs: 2 }).searchTree(harness.scope, '.', 'deep', signal()))
    expect(matchesOf(frames)).toEqual([])
    expect(truncatedOf(frames)).toBe(true)
  })

  it('refuses a root outside the workspace', async () => {
    await expect(collect(endpoint().searchTree(harness.scope, outside, 'x', signal()))).rejects.toThrow()
  })
})
