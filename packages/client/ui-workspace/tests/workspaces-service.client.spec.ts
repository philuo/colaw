import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ISessions, SessionListState, SessionReference, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceTrashEntry, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ClientRemote, DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { DirectoryBrowseError, UiWorkspaceService } from '../src/client/navigation.ts'

const sid = (id: string): SessionId => SessionId(id)
const wid = (id: string): WorkspaceId => id as WorkspaceId

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function workspace(
  id: string,
  sessionIds: readonly SessionId[] = [],
  createdAt = '2026-01-01T00:00:00.000Z',
): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt,
    updatedAt: createdAt,
  }
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sid(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 0,
    ...overrides,
    retainedBy: overrides.retainedBy ?? {},
  }
}

function sessionState(
  summaries: readonly SessionSummary[] = [],
  phase: SessionListState['phase'] = 'ready',
): SessionListState {
  return {
    ids: summaries.map(item => item.id),
    byId: Object.fromEntries(summaries.map(item => [item.id, item])),
    phase,
    subagentsByParent: {},
    jobsBySession: {},
  }
}

function workspaceState(
  items: WorkspaceSnapshot['items'] = [],
  archivedSessionIds: readonly SessionId[] = [],
  phase: WorkspaceSnapshot['phase'] = 'ready',
): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds,
    phase,
    state: phase === 'ready' ? 'idle' : 'loading',
    error: null,
  }
}

class MutableSource<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  update(update: (value: T) => T): void {
    this.set(update(this.value))
  }

  listenersSnapshot(): readonly (() => void)[] {
    return [...this.listeners]
  }
}

interface RetainedSession {
  readonly reference: SessionReference
  readonly release: ReturnType<typeof vi.fn<() => void>>
}

class FakeSessions implements ISessions {
  readonly list: MutableSource<SessionListState>
  readonly create: ReturnType<typeof vi.fn<ISessions['create']>>
  readonly fork = vi.fn<ISessions['fork']>(async () => sid('forked'))
  readonly retained: RetainedSession[] = []
  readonly refreshSubagents = vi.fn<ISessions['refreshSubagents']>(() => Promise.resolve())
  readonly retain = vi.fn<ISessions['retain']>((target) => {
    const release = vi.fn<() => void>()
    const sessionId = typeof target === 'string' ? target : target.childSessionId
    const binding = { sessionId } as SessionReference['binding']
    const reference: SessionReference = {
      sessionId,
      binding,
      ready: Promise.resolve(binding),
      release,
      [Symbol.dispose]: release,
    }
    this.retained.push({ reference, release })
    return reference
  })
  readonly subagentAddress = vi.fn<ISessions['subagentAddress']>()
  declare readonly using: ISessions['using']
  declare readonly retainInfo: ISessions['retainInfo']
  declare readonly searchResultLimit: ISessions['searchResultLimit']
  declare readonly setSubagentCatalogOpen: ISessions['setSubagentCatalogOpen']
  declare readonly refresh: ISessions['refresh']
  declare readonly search: ISessions['search']
  declare readonly scope: ISessions['scope']
  declare readonly scopeOf: ISessions['scopeOf']
  declare readonly sessionOf: ISessions['sessionOf']
  declare readonly binding: ISessions['binding']

  constructor(initial: SessionListState) {
    this.list = new MutableSource(initial)
    this.create = vi.fn<ISessions['create']>(async options =>
      options?.sessionId ?? sid(`created-${String(options?.workspaceId ?? 'none')}`))
  }
}

class FakeWorkspaces implements IWorkspaces {
  readonly list: MutableSource<WorkspaceSnapshot>
  readonly archiveCalls: SessionId[] = []
  readonly unarchiveCalls: SessionId[] = []
  onArchive: IWorkspaces['archiveSession'] = async (sessionId) => {
    this.list.update(state => ({
      ...state,
      archivedSessionIds: [...state.archivedSessionIds, sessionId],
    }))
  }

  onUnarchive: IWorkspaces['unarchiveSession'] = async (sessionId) => {
    this.list.update(state => ({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
    }))
  }

  trashEntries(): Promise<readonly WorkspaceTrashEntry[]> {
    return Promise.resolve([])
  }

  deleteArchivedSession(): Promise<void> {
    return Promise.resolve()
  }

  clearTrash(): Promise<void> {
    return Promise.resolve()
  }

  declare readonly create: IWorkspaces['create']
  declare readonly rename: IWorkspaces['rename']
  declare readonly delete: IWorkspaces['delete']
  declare readonly insertBefore: IWorkspaces['insertBefore']
  declare readonly insertSessionBefore: IWorkspaces['insertSessionBefore']

  constructor(initial: WorkspaceSnapshot) {
    this.list = new MutableSource(initial)
  }

  archiveSession(sessionId: SessionId): Promise<void> {
    this.archiveCalls.push(sessionId)
    return this.onArchive(sessionId)
  }

  unarchiveSession(sessionId: SessionId): Promise<void> {
    this.unarchiveCalls.push(sessionId)
    return this.onUnarchive(sessionId)
  }
}

const listing: DirectoryListing = {
  path: '/home/u',
  home: '/home/u',
  crumbs: [{ name: '/', path: '/', hidden: false }],
  entries: [{ name: 'project', path: '/home/u/project', hidden: false }],
  truncated: false,
}

/** The directory-picking Remote namespace, recorded and scripted per case. */
class FakeDirectoryPicker {
  readonly calls: { method: string; payload: unknown }[] = []

  onPick: () => Promise<RemoteResult<string | null>> = () => Promise.resolve({ ok: true, value: null })
  onList: () => Promise<RemoteResult<DirectoryListing>> = () => Promise.resolve({ ok: true, value: listing })
  onCreateDirectory: () => Promise<RemoteResult<string>> =
    () => Promise.resolve({ ok: true, value: '/home/u/new' })

  readonly remote: ClientRemote['directoryPicker'] = {
    pick: () => this.record('pick', {}, this.onPick()),
    list: (path?: string) => this.record('list', { path }, this.onList()),
    createDirectory: (path: string, name: string) =>
      this.record('createDirectory', { path, name }, this.onCreateDirectory()),
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter(call => call.method === method).map(call => call.payload)
  }

  private record<T>(method: string, payload: unknown, result: Promise<T>): Promise<T> {
    this.calls.push({ method, payload })
    return result
  }
}

interface BenchOptions {
  readonly workspaces?: WorkspaceSnapshot
  readonly sessions?: SessionListState
  readonly configureSessions?: (sessions: FakeSessions) => void
}

function bench(options: BenchOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const layout = new LayoutController({
    selectPanel: vi.fn(), retainMainPanels: vi.fn(),
    setSidebar: vi.fn(), toggleSidebar: vi.fn(), setViewportWidth: vi.fn(),
    setRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
  }, () => true)
  const selectPanel = vi.spyOn(layout, 'selectPanel')
  ctx.provide('layout', layout)
  ctx.effect(() => () => { layout.dispose() })
  const directoryPicker = new FakeDirectoryPicker()
  const workspaces = new FakeWorkspaces(options.workspaces ?? workspaceState([], [], 'pending'))
  const sessions = new FakeSessions(options.sessions ?? sessionState([], 'pending'))
  options.configureSessions?.(sessions)
  const uiWorkspace = new UiWorkspaceService(
    ctx,
    directoryPicker.remote,
    workspaces,
    sessions,
  )
  return { ctx, directoryPicker, sessions, uiWorkspace, workspaces, layout, selectPanel }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('UiWorkspaceService', () => {
  it('retains an explicit main target before revealing its Conversation', () => {
    const current = sid('current')
    const b = bench()
    b.selectPanel.mockImplementation(() => {
      expect(b.sessions.retained.at(-1)!.reference.sessionId).toBe(current)
    })
    b.uiWorkspace.openSession(current)
    expect(b.sessions.retain).toHaveBeenCalledWith(current, { source: 'mainView' })
    expect(b.selectPanel).toHaveBeenCalledWith(null)
    expect(b.sessions.retain.mock.invocationCallOrder[0])
      .toBeLessThan(b.selectPanel.mock.invocationCallOrder[0]!)
  })

  it('keeps the current panel when retaining the target fails', () => {
    const b = bench()
    b.sessions.retain.mockImplementationOnce(() => { throw new Error('open failed') })
    expect(() => { b.uiWorkspace.openSession(sid('target')) }).toThrow('open failed')
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('releases a newly retained target when Workspace preparation throws', async () => {
    const b = bench({
      workspaces: workspaceState([workspace('a')]),
      sessions: sessionState([], 'pending'),
    })
    b.uiWorkspace.openSession(sid('current'))
    const failure = new Error('preparation failed')

    await expect(b.uiWorkspace.openWorkspace(wid('a'), () => { throw failure })).rejects.toBe(failure)

    expect(b.sessions.retained.map(item => item.reference.sessionId)).toEqual([sid('current'), sid('created-a')])
    expect(b.sessions.retained[0]!.release).not.toHaveBeenCalled()
    expect(b.sessions.retained[1]!.release).toHaveBeenCalledOnce()
  })

  it('opens only the latest Workspace request when creation completes out of order', async () => {
    const b = bench({
      workspaces: workspaceState([workspace('alpha'), workspace('beta')]),
      sessions: sessionState([], 'pending'),
    })
    const older = Promise.withResolvers<SessionId>()
    const newer = Promise.withResolvers<SessionId>()
    b.sessions.create.mockImplementation(options =>
      options?.workspaceId === wid('alpha') ? older.promise : newer.promise)
    const oldDraft = vi.fn()
    const newDraft = vi.fn()
    const first = b.uiWorkspace.openWorkspace(wid('alpha'), oldDraft)
    const second = b.uiWorkspace.openWorkspace(wid('beta'), newDraft)
    newer.resolve(sid('newer'))
    await second
    older.resolve(sid('older'))
    await first
    expect(oldDraft).not.toHaveBeenCalled()
    expect(newDraft).toHaveBeenCalledExactlyOnceWith(sid('newer'))
    expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('newer'), { source: 'mainView' })
  })

  it('does not reopen a Workspace after a later panel or Session navigation', async () => {
    for (const panel of [true, false]) {
      const b = bench({
        workspaces: workspaceState([workspace('alpha')]),
        sessions: sessionState([], 'pending'),
      })
      const created = Promise.withResolvers<SessionId>()
      b.sessions.create.mockReturnValue(created.promise)
      const opening = b.uiWorkspace.openWorkspace(wid('alpha'))
      if (panel) b.layout.selectPanel('other-panel' as MainPanelId)
      else b.uiWorkspace.openSession(sid('chosen'))
      created.resolve(sid('late'))
      await opening
      expect(b.sessions.retain.mock.calls.map(args => args[0]))
        .toEqual(panel ? [] : [sid('chosen')])
    }
  })

  it('does not deliver pending Workspace or fork targets after disposal', async () => {
    for (const kind of ['workspace', 'fork'] as const) {
      const b = bench({
        workspaces: workspaceState([workspace('alpha')]),
        sessions: sessionState([], 'pending'),
      })
      const created = Promise.withResolvers<SessionId>()
      b.sessions.create.mockReturnValue(created.promise)
      b.sessions.fork.mockReturnValue(created.promise)
      const pending = kind === 'workspace'
        ? b.uiWorkspace.openWorkspace(wid('alpha'))
        : b.uiWorkspace.forkSession(sid('current'))
      await b.ctx.fiber.dispose()
      created.resolve(sid('late'))
      await pending
      expect(b.sessions.retain).not.toHaveBeenCalled()
    }
  })

  it('ignores a rejected startup selection and stale catalog callbacks after disposal', async () => {
    const created = Promise.withResolvers<SessionId>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const b = bench({
      workspaces: workspaceState([workspace('a')], [], 'ready'),
      sessions: sessionState([], 'pending'),
      configureSessions: (sessions) => { sessions.create.mockReturnValue(created.promise) },
    })
    const staleReconcile = b.sessions.list.listenersSnapshot()[0]!
    b.sessions.list.set(sessionState())
    await b.ctx.fiber.dispose()
    staleReconcile()
    created.reject(new Error('late failure'))
    await Promise.resolve()

    expect(warning).not.toHaveBeenCalled()
  })

  it('does not run startup selection after a main Session was chosen while catalogs loaded', () => {
    const b = bench()
    b.uiWorkspace.openSession(sid('chosen'))

    b.workspaces.list.set(workspaceState([workspace('a')]))
    b.sessions.list.set(sessionState())

    expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('chosen'), { source: 'mainView' })
    expect(b.sessions.create).not.toHaveBeenCalled()
  })

  it('forwards fork policy and rejects a failed fork', async () => {
    const b = bench()
    await b.uiWorkspace.forkSession(sid('source'))
    expect(b.sessions.fork).toHaveBeenCalledWith({ sessionId: sid('source'), increaseTitle: true })
    expect(b.sessions.retain).toHaveBeenCalledWith(sid('forked'), { source: 'mainView' })
    b.sessions.fork.mockRejectedValueOnce(new Error('fork failed'))
    await expect(b.uiWorkspace.forkSession(sid('source'))).rejects.toThrow('fork failed')
  })

  it('reuses only an unarchived member blank and coalesces concurrent creation', async () => {
    const memberBlank = sid('member-blank')
    const archivedBlank = sid('archived-blank')
    const summaries: readonly SessionSummary[] = [
      summary('stray', { blank: true, cwd: '/w/alpha' }),
      summary('member-blank', { blank: true, cwd: '/w/alpha' }),
      summary('active', { cwd: '/w/beta' }),
      summary('archived-blank', { blank: true, cwd: '/w/gamma' }),
    ]
    const b = bench({
      workspaces: workspaceState([
        workspace('alpha', [memberBlank]),
        workspace('beta', [sid('active')]),
        workspace('gamma', [archivedBlank]),
      ], [archivedBlank]),
      sessions: sessionState(summaries, 'pending'),
    })

    await expect(Promise.all([
      b.uiWorkspace.connectWorkspace(wid('alpha')),
      b.uiWorkspace.connectWorkspace(wid('alpha')),
    ])).resolves.toEqual([memberBlank, memberBlank])
    expect(b.sessions.create).not.toHaveBeenCalled()

    const creation = Promise.withResolvers<SessionId>()
    b.sessions.create.mockImplementation(() => creation.promise)
    const first = b.uiWorkspace.connectWorkspace(wid('beta'))
    const second = b.uiWorkspace.connectWorkspace(wid('beta'))
    expect(b.sessions.create).toHaveBeenCalledOnce()
    creation.resolve(sid('fresh-beta'))
    await expect(Promise.all([first, second])).resolves.toEqual([sid('fresh-beta'), sid('fresh-beta')])

    b.sessions.create.mockImplementation(async options => sid(`fresh-${String(options?.workspaceId)}`))
    await expect(b.uiWorkspace.connectWorkspace(wid('gamma'))).resolves.toBe(sid('fresh-gamma'))
    expect(b.sessions.create).toHaveBeenLastCalledWith({ workspaceId: wid('gamma') })
    await expect(b.uiWorkspace.connectWorkspace(wid('ghost')))
      .rejects.toThrow('uiWorkspace.connectWorkspace: unknown workspace ghost')
    expect(b.sessions.retain).not.toHaveBeenCalled()
  })

  it('targets an explicit or current-session Workspace and otherwise starts workspace-less', async () => {
    const current = summary('current', { cwd: '/w/current-home', updatedAt: 1 })
    const recent = summary('recent', { cwd: '/w/recent-home', updatedAt: 2 })
    const b = bench()
    b.workspaces.list.set(workspaceState([
      workspace('current-home', [current.id]),
      workspace('recent-home', [recent.id]),
    ]))
    b.sessions.list.set(sessionState([current, recent]))
    b.sessions.create.mockImplementation(async options => sid(`opened-${String(options?.workspaceId)}`))
    await flush()
    b.sessions.retain.mockClear()
    b.sessions.create.mockClear()
    b.sessions.refreshSubagents.mockClear()

    // An explicit Workspace argument always wins.
    b.uiWorkspace.startSession(wid('recent-home'))
    await vi.waitFor(() => {
      expect(b.sessions.retain).toHaveBeenLastCalledWith(sid('opened-recent-home'), { source: 'mainView' })
    })

    // Back inside a Workspace's conversation, an unscoped New Session
    // inherits that Workspace (the sidebar's top-bar New control).
    b.uiWorkspace.openSession(current.id)
    b.uiWorkspace.startSession()
    await vi.waitFor(() => {
      expect(b.sessions.retain).toHaveBeenLastCalledWith(sid('opened-current-home'), { source: 'mainView' })
    })

    // No current Session and no explicit target: no recency fallback — the
    // New Session default is workspace-less, whichever Workspace was used last.
    const detached = bench({
      workspaces: workspaceState([workspace('recent-home', [recent.id])]),
      sessions: sessionState([recent]),
    })
    await vi.waitFor(() => {
      expect(detached.sessions.create).toHaveBeenCalledWith({})
      expect(detached.sessions.retain).toHaveBeenLastCalledWith(sid('created-none'), { source: 'mainView' })
    })

    // A workspace-free create failure releases the selection back to the shell.
    const failed = bench()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failed.sessions.create.mockRejectedValueOnce(new Error('create failed'))
    failed.uiWorkspace.startDetachedSession()
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('workspace-free session failed:', expect.any(Error))
    })
    expect(failed.selectPanel).toHaveBeenCalledWith(null)
  })

  it('startDetachedSession runs the carry hook before opening and honours supersession', async () => {
    const b = bench()
    const beforeOpen = vi.fn()
    b.uiWorkspace.startDetachedSession(beforeOpen)
    await flush()
    expect(b.sessions.create).toHaveBeenCalledWith({})
    expect(beforeOpen).toHaveBeenCalledWith(sid('created-none'))
    expect(b.sessions.retain).toHaveBeenLastCalledWith(sid('created-none'), { source: 'mainView' })

    // A later navigation wins the epoch: the late session lands unopened and
    // the carry hook never runs for it.
    const pending = Promise.withResolvers<SessionId>()
    b.sessions.create.mockImplementation(() => pending.promise)
    b.uiWorkspace.startDetachedSession(beforeOpen)
    b.layout.beginNavigation()
    pending.resolve(sid('superseded'))
    await flush()
    expect(beforeOpen).toHaveBeenCalledTimes(1)
    expect(b.sessions.retain).toHaveBeenCalledTimes(1)
  })

  it('starts a workspace-less Session after both baselines arrive (no recency fallback)', async () => {
    const b = bench()
    b.sessions.create.mockResolvedValue(sid('initial'))

    const recent = workspace('recent', [], '2026-01-02T00:00:00.000Z')
    b.workspaces.list.set(workspaceState([recent]))
    expect(b.sessions.create).not.toHaveBeenCalled()
    b.sessions.list.set(sessionState())

    await vi.waitFor(() => {
      expect(b.sessions.retain).toHaveBeenCalledWith(sid('initial'), { source: 'mainView' })
    })
    expect(b.sessions.create).toHaveBeenCalledWith({})
    expect(b.sessions.create).not.toHaveBeenCalledWith({ workspaceId: wid('recent') })
    expect(b.workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual([
      wid('recent'),
    ])
  })

  it('reuses the latest ungrouped, unarchived blank Session at startup instead of creating one', async () => {
    const b = bench()
    const olderBlank = summary('older-blank', { blank: true, updatedAt: 1 })
    const latestBlank = summary('latest-blank', { blank: true, updatedAt: 5 })
    const ordinary = summary('ordinary', { cwd: '/w/x', updatedAt: 9 })
    const groupedBlank = summary('grouped-blank', { blank: true, updatedAt: 7 })
    const archivedBlank = summary('archived-blank', { blank: true, updatedAt: 8 })
    b.workspaces.list.set(workspaceState(
      [workspace('one', [groupedBlank.id])],
      [archivedBlank.id],
    ))
    b.sessions.list.set(sessionState([olderBlank, latestBlank, ordinary, groupedBlank, archivedBlank]))

    await vi.waitFor(() => {
      expect(b.sessions.retain).toHaveBeenCalledWith(latestBlank.id, { source: 'mainView' })
    })
    expect(b.sessions.create).not.toHaveBeenCalled()
  })

  it('retries failed initial selection and never overwrites a later selection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const b = bench()
    let attempts = 0
    b.sessions.create.mockImplementation(() => ++attempts === 1
      ? Promise.reject(new Error('attach exploded'))
      : Promise.resolve(sid('retry')))
    b.workspaces.list.set(workspaceState([workspace('recent')]))
    b.sessions.list.set(sessionState())
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('initial workspace-free selection failed:', expect.any(Error))
    })
    b.workspaces.list.update(state => ({ ...state, items: [...state.items] }))
    await vi.waitFor(() => {
      expect(b.sessions.retain).toHaveBeenCalledWith(sid('retry'), { source: 'mainView' })
    })
    expect(attempts).toBe(2)

    const changed = bench()
    const pending = Promise.withResolvers<SessionId>()
    changed.sessions.create.mockImplementation(() => pending.promise)
    changed.workspaces.list.set(workspaceState([workspace('recent')]))
    changed.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(changed.sessions.create).toHaveBeenCalledOnce() })
    changed.uiWorkspace.openSession(sid('manual'))
    pending.resolve(sid('automatic'))
    await flush()
    expect(changed.sessions.retain.mock.calls.map(([target]) => target)).toEqual([sid('manual')])
  })

  it('stops initial navigation when its Cordis lifetime is disposed', async () => {
    const success = bench()
    const resolved = Promise.withResolvers<SessionId>()
    success.sessions.create.mockImplementation(() => resolved.promise)
    success.workspaces.list.set(workspaceState([workspace('recent')]))
    success.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(success.sessions.create).toHaveBeenCalledOnce() })
    await success.ctx.fiber.dispose()
    resolved.resolve(sid('late'))
    await flush()
    expect(success.sessions.retain).not.toHaveBeenCalled()
    success.workspaces.list.set(workspaceState([workspace('ignored')]))
    expect(success.sessions.create).toHaveBeenCalledOnce()

    const failure = bench()
    const rejected = Promise.withResolvers<SessionId>()
    failure.sessions.create.mockImplementation(() => rejected.promise)
    failure.workspaces.list.set(workspaceState([workspace('recent')]))
    failure.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(failure.sessions.create).toHaveBeenCalledOnce() })
    const staleReconciles = failure.workspaces.list.listenersSnapshot()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await failure.ctx.fiber.dispose()
    rejected.reject(new Error('late failure'))
    await flush()
    for (const reconcile of staleReconciles) reconcile()
    expect(warning).not.toHaveBeenCalled()
    expect(failure.sessions.create).toHaveBeenCalledOnce()
  })

  it('clears a selected Session only after it enters the archive baseline', () => {
    const current = sid('current')
    const idle = sid('idle')
    const b = bench()
    b.uiWorkspace.openSession(current)

    b.workspaces.list.set(workspaceState([workspace('one', [current, idle])], [idle]))
    expect(b.sessions.retained.find(item => item.reference.sessionId === current)!.release)
      .not.toHaveBeenCalled()
    b.workspaces.list.set(workspaceState([workspace('one', [current, idle])], [current]))
    expect(b.sessions.retained.find(item => item.reference.sessionId === current)!.release)
      .toHaveBeenCalledOnce()

    b.uiWorkspace.openSession(idle)
    b.workspaces.list.set(workspaceState([workspace('one', [current, idle])], [idle]))
    expect(b.sessions.retained.find(item => item.reference.sessionId === idle)!.release)
      .toHaveBeenCalledOnce()
  })

  it('forwards archive commands and preserves failures', async () => {
    const idle = sid('idle')
    const b = bench()

    await b.uiWorkspace.archiveSession(idle)
    expect(b.workspaces.archiveCalls).toEqual([idle])

    b.workspaces.onArchive = () => Promise.reject(new Error('archive rejected'))
    await expect(b.uiWorkspace.archiveSession(idle)).rejects.toThrow('archive rejected')
    expect(b.workspaces.archiveCalls).toEqual([idle, idle])
  })

  it('forwards unarchive commands and preserves failures', async () => {
    const idle = sid('idle')
    const b = bench()

    await b.uiWorkspace.unarchiveSession(idle)
    expect(b.workspaces.unarchiveCalls).toEqual([idle])

    b.workspaces.onUnarchive = () => Promise.reject(new Error('unarchive rejected'))
    await expect(b.uiWorkspace.unarchiveSession(idle)).rejects.toThrow('unarchive rejected')
    expect(b.workspaces.unarchiveCalls).toEqual([idle, idle])
  })

  it('passes directory operations to the Host and preserves structured browse failures', async () => {
    const b = bench()
    b.directoryPicker.onPick = () => Promise.resolve({ ok: true, value: '/w/alpha' })
    await expect(b.uiWorkspace.pickDirectory()).resolves.toBe('/w/alpha')
    b.directoryPicker.onPick = () => Promise.resolve({ ok: true, value: null })
    await expect(b.uiWorkspace.pickDirectory()).resolves.toBeNull()
    expect(b.directoryPicker.callsOf('pick')).toEqual([{}, {}])

    await expect(b.uiWorkspace.listDirectory()).resolves.toEqual(listing)
    await expect(b.uiWorkspace.listDirectory('/home/u')).resolves.toEqual(listing)
    expect(b.directoryPicker.callsOf('list')).toEqual([{ path: undefined }, { path: '/home/u' }])
    await expect(b.uiWorkspace.createDirectory('/home/u', 'new')).resolves.toBe('/home/u/new')
    expect(b.directoryPicker.callsOf('createDirectory')).toEqual([{ path: '/home/u', name: 'new' }])
    b.directoryPicker.onPick = () => Promise.resolve({
      ok: false, error: new RemoteError('gateway/internal', 'no chooser', {}),
    })
    await expect(b.uiWorkspace.pickDirectory()).rejects.toThrow('directory picker failed: no chooser')
    b.directoryPicker.onList = () => Promise.resolve({
      ok: false, error: new RemoteError('directory-picker/unreadable', 'denied', { path: '/private' }),
    })
    const listFailure = b.uiWorkspace.listDirectory('/private')
    await expect(listFailure).rejects.toBeInstanceOf(DirectoryBrowseError)
    await expect(listFailure).rejects.toMatchObject({ rpcError: { code: 'directory-picker/unreadable' } })
    b.directoryPicker.onCreateDirectory = () => Promise.resolve({
      ok: false, error: new RemoteError('directory-picker/exists', 'taken', { path: '/home/u/new' }),
    })
    await expect(b.uiWorkspace.createDirectory('/home/u', 'new')).rejects.toMatchObject({
      rpcError: { code: 'directory-picker/exists' },
    })
  })
})
