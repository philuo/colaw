/** The `searchTree` endpoint: a breadth-first host walk with caps and containment. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openWorkspace, signal, type Harness } from './harness.ts'

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

const endpoint = (caps?: { maxSearchDirs?: number }): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

describe('workspaceFiles.searchTree — the happy path', () => {
  it('matches deep names and keeps directories browsable', async () => {
    await mkdir(join(workspace, 'a/b/c'), { recursive: true })
    await writeFile(join(workspace, 'a/b/c/deep-report.md'), 'x')
    await writeFile(join(workspace, 'top-report.md'), 'x')
    const result = await endpoint().searchTree(harness.scope, '.', 'report', signal())
    expect(result.matches.map(m => m.path).sort()).toEqual(['a/b/c/deep-report.md', 'top-report.md'])
    expect(result.truncated).toBe(false)
  })

  it('matches directory names too', async () => {
    await mkdir(join(workspace, 'projects/截图2024'), { recursive: true })
    const result = await endpoint().searchTree(harness.scope, '.', '截图', signal())
    expect(result.matches).toEqual([{ path: 'projects/截图2024', name: '截图2024', type: 'directory' }])
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
      const result = await endpoint().searchTree(harness.scope, '.', 'target', signal())
      expect(result.matches.map(m => m.path)).toEqual(['good/deep/target.txt'])
      expect(result.truncated).toBe(true)
    } finally {
      await chmod(join(workspace, 'bad/locked'), 0o755)
    }
  })

  it('degrades to an empty truncated result when the root listing itself fails', async () => {
    await mkdir(join(workspace, 'locked'), { recursive: true })
    await writeFile(join(workspace, 'locked/secret.txt'), 'x')
    await chmod(join(workspace, 'locked'), 0o000)
    try {
      const result = await endpoint().searchTree(harness.scope, '.', 'target', signal())
      expect(result.matches).toEqual([])
      expect(result.truncated).toBe(true)
    } finally {
      await chmod(join(workspace, 'locked'), 0o755)
    }
  })

  it('stops at the directory cap and reports truncation', async () => {
    await mkdir(join(workspace, 'd1/d2/d3'), { recursive: true })
    await writeFile(join(workspace, 'd1/d2/d3/deep.txt'), 'x')
    const result = await endpoint({ maxSearchDirs: 2 }).searchTree(harness.scope, '.', 'deep', signal())
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('refuses a root outside the workspace', async () => {
    await expect(endpoint().searchTree(harness.scope, outside, 'x', signal())).rejects.toThrow()
  })
})
