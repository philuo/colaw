/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
// Type-only: pulls the SpillStore Context merge (ctx.spillStore) into this program.
import type {} from '@deepseek-ai/dsh-spill'
// Type-only: pulls the SessionPersistence Context merge (ctx.sessionPersistence).
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { trashDigest } from './trash-digest.ts'
import type {
  WorkspaceDeleteSessionRequest,
  WorkspaceTrashEntry,
  WorkspaceTrashValue,
  WorkspaceUnarchiveSessionRequest,
} from './types.ts'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Read the complete trash listing with per-entry previews.
   * @returns one entry per archived session, newest archive first.
   */
  async trashEntries(): Promise<WorkspaceTrashValue> {
    const registry = this.ctx.workspaceRegistry
    const persistence = this.ctx.get('sessionPersistence')
    const entries: WorkspaceTrashEntry[] = []
    for (const sessionId of [...registry.archivedSessionIds].reverse()) {
      const archivedAt = registry.archivedEntries[sessionId]
      let preview: { title?: string; digest?: string } = {}
      if (persistence !== undefined) {
        try {
          const handle = await persistence.open(sessionId, 'read')
          try {
            preview = trashDigest((await handle.read()).events)
          } finally {
            await handle.close()
          }
        } catch {
          // An archived log that cannot be read previews empty; the entry
          // stays listed so it can still be restored or deleted.
        }
      }
      entries.push({
        sessionId,
        ...(archivedAt === undefined ? {} : { archivedAt }),
        ...preview,
      })
    }
    return { entries }
  }

  /**
   * Restore one archived session to its grouping surfaces.
   * @param request - the archived session to restore.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Remove one archived session from disk for good: the durable log, the
   * archive record, the live store entry, and every workspace accounting slot.
   * An id that is not archived is refused; there is deliberately no
   * live-session refusal — the host session store keeps admitted instances for
   * any session opened this run (archiving alone does not evict them), so a
   * residency probe would reject exactly the sessions the trash exists to
   * delete. The conversation surface already guarantees an archived session is
   * not the open conversation (archiving clears the selection and hides the
   * row).
   *
   * Deletion ENDS the session; it never merely unhides it. Every trace that
   * would outlive the artifact is retired in the same transaction, because any
   * survivor reads as "the session came back": a live store entry keeps the id
   * in the session list (and so back in the sidebar) once the archive record
   * is gone, and the persistence backend's own write route would re-materialize
   * the log from its buffered events. `session/disposed` is the single pairing
   * edge, so consumers (the session list feed included) observe one normal
   * teardown rather than a resurrection.
   * @param request - the archived session to delete permanently.
   * @returns the complete resulting archive set.
   */
  async deleteArchivedSession(request: WorkspaceDeleteSessionRequest): Promise<WorkspaceArchiveValue> {
    const sessionId = request.sessionId
    const registry = this.ctx.workspaceRegistry
    if (!registry.archivedSessionIds.includes(sessionId)) {
      throw new RemoteError('workspace/trash-conflict', `session "${sessionId}" is not archived`, { sessionId })
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new RemoteError('gateway/internal', 'session persistence is unavailable', {})
    }
    try {
      await persistence.remove(sessionId)
    } catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) {
        throw new RemoteError(
          'gateway/internal',
          `session "${sessionId}" could not be removed: ${errorMessage(error)}`,
          { sessionId },
          { cause: error },
        )
      }
      // Already gone on disk: the accounting cleanup below still runs.
    }
    // The durable artifact is gone, so an admitted instance is now only a
    // listing that outlives its session. Retire it after the removal (never
    // before): the persistence backend must already have dropped the id's
    // write route, or its `session/disposed` teardown would drain the routed
    // buffer straight back onto the disk.
    this.ctx.sessions.retire(sessionId)
    // Session-scoped temp artifacts (spilled tool results under the OS temp
    // area) leave with the session; the contract is best-effort, so a spill
    // backend that is absent or fails never fails the deletion itself.
    const spill = this.ctx.get('spillStore') as { purgeSession?: (id: string) => Promise<void> } | undefined
    if (spill?.purgeSession !== undefined) await spill.purgeSession(sessionId)
    await registry.purgeSession(sessionId)
    return { archivedSessionIds: [...registry.archivedSessionIds] }
  }

  /**
   * Remove every archived session from disk for good. One failing entry
   * never abandons the rest: each deletion is attempted independently and
   * the failures aggregate into one error after the loop, so a partial
   * clear reports exactly the survivors instead of aborting on the first
   * conflict. The whole sweep serializes with other workspace writes.
   * @returns the complete resulting archive set (empty when every entry went).
   */
  clearTrash(): Promise<WorkspaceArchiveValue> {
    return this.enqueue(async () => {
      const failures: string[] = []
      for (const sessionId of [...this.ctx.workspaceRegistry.archivedSessionIds]) {
        try {
          await this.deleteArchivedSession({ sessionId })
        } catch (error) {
          failures.push(`${sessionId}: ${error instanceof RemoteError ? error.message : errorMessage(error)}`)
        }
      }
      if (failures.length > 0) {
        throw new RemoteError(
          'workspace/trash-conflict',
          `cleared all but ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'}: ${failures.join('; ')}`,
          { failed: failures.length },
        )
      }
      return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
    })
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
