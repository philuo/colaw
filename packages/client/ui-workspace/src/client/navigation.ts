/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param sessionId - listed or retained Session to display.
   */
  openSession(sessionId: SessionId): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session and open the child unless a later navigation supersedes it.
   * @param sessionId - source Session.
   * @returns completion; a superseded request leaves its child available without selecting it.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session.
   * @param workspaceId - explicit target; absent inherits the current
   * Session's Workspace or starts workspace-less (the New Session default).
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Start a workspace-less Session and open it unless a later navigation
   * supersedes it.
   * @param beforeOpen - optional synchronous preparation for the new Session
   * (draft carry), skipped after supersession.
   */
  startDetachedSession(beforeOpen?: (sessionId: SessionId) => void): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchNavigation(), 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }

    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  openSession(sessionId: SessionId): void {
    this.sessions.open(sessionId)
    this.ctx.layout.selectPanel(null)
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const isCurrent = (): boolean => !navigation.aborted
    const sessionId = await this.connectWorkspace(workspaceId)
    if (!isCurrent()) return
    beforeOpen?.(sessionId)
    if (isCurrent()) this.openSession(sessionId)
  }

  /** A chat with no workspace attached: the host's session create defaults
   * the cwd on its own, so a session can start with no directory bound. */
  startDetachedSession(beforeOpen?: (sessionId: SessionId) => void): void {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const isCurrent = (): boolean => !navigation.aborted
    void this.sessions.create({}).then(
      (sessionId) => {
        if (!isCurrent()) return
        beforeOpen?.(sessionId)
        if (isCurrent()) this.openSession(sessionId)
      },
      (reason: unknown) => {
        console.warn('workspace-free session failed:', reason)
        this.sessions.clear()
        this.ctx.layout.selectPanel(null)
      },
    )
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const childId = await this.sessions.fork({ sessionId, increaseTitle: true })
    if (!navigation.aborted) this.openSession(childId)
  }

  startSession(workspaceId?: WorkspaceId): void {
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = sessions.current
    // A Workspace is preselected only by an explicit request (the sidebar
    // group's New action) or by the current Session already living in one;
    // every other start is workspace-less by default — no recency fallback.
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId
    if (target === undefined) {
      this.startDetachedSession()
      return
    }
    void this.openWorkspace(target).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.archiveSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (sessions.current !== undefined) {
        initial = 'done'
        return
      }
      // The startup default is the same as every other New Session: no
      // Workspace preselected. Reuse-or-create a workspace-less blank Session
      // so the composer is immediately usable; which Workspace (if any) the
      // user works in stays their own next action.
      const reusable = reusableDetachedSession(workspace, sessions)
      initial = 'connecting'
      const attempt = reusable === undefined ? this.sessions.create({}) : Promise.resolve(reusable)
      void attempt.then(
        (sessionId) => {
          if (this.lifetime.signal.aborted) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          initial = 'done'
        },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial workspace-free selection failed:', reason)
        },
      )
    }
    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.sessions.clear()
    return true
  }

}

/**
 * The most recent reusable workspace-less blank Session: unarchived, owned by
 * no Workspace, and bound to no directory. Latest activity wins; the Host
 * order breaks ties implicitly through {@link SessionListState.ids} scan order.
 */
function reusableDetachedSession(
  workspace: WorkspaceSnapshot,
  sessions: SessionListState,
): SessionId | undefined {
  let selected: SessionId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const id of sessions.ids) {
    const summary = sessions.byId[id]
    // No bound directory matches the chip's own notion of workspace-less:
    // both an absent cwd and an empty one.
    if (summary === undefined || !summary.blank || summary.cwd) continue
    if (workspace.archivedSessionIds.includes(id)) continue
    if (workspace.items.some(item => item.sessionIds.includes(id))) continue
    if (selected === undefined || summary.updatedAt > selectedTime) {
      selected = id
      selectedTime = summary.updatedAt
    }
  }
  return selected
}

export { UiWorkspaceService }
