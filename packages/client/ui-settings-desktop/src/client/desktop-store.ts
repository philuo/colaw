/**
 * The 电脑操控 section's slot store: a mirror of the desktop-control scope
 * snapshot plus the host's live TCC answer. The plugin's apply-world actions
 * are the only writers; the section reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DesktopSettings } from '../desktop-settings.ts'

/** One TCC grant pair as the section renders it. */
export interface DesktopPermissionStatus {
  accessibility: boolean
  screenRecording: boolean
}

/**
 * The privacy pane a missing grant deep-links to. Spelled locally so the
 * client bundle never imports the experimental provider package; the wire
 * string is checked structurally against the remote's own union.
 */
export type DesktopPermissionPane = 'accessibility' | 'screenRecording'

/** Mirror state: the three switches, the scope's sync facts, and the TCC answer. */
export interface DesktopSectionState {
  status: 'loading' | 'ready' | 'unavailable'
  browserUse: boolean
  computerUse: boolean
  lockScreenOperation: boolean
  /**
   * The host's last reported TCC state, or undefined while no probe has
   * answered. Undefined is transient by contract: every section mount and
   * every Settings deep-link re-probes.
   */
  permissions: DesktopPermissionStatus | undefined
  /**
   * The pane whose grant the floating guide is walking the user through, set
   * when an enable finds the grant missing. Cleared by dismissal or by a
   * probe that shows the grant landed.
   */
  guide: DesktopPermissionPane | undefined
  /** Bumped on every sync so the store always publishes a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type DesktopSectionActions = {
  sync: (draft: DesktopSectionState, value: DesktopSettings | undefined, status: DesktopSectionState['status']) => void
  setPermissions: (draft: DesktopSectionState, value: DesktopPermissionStatus | undefined) => void
  setGuide: (draft: DesktopSectionState, pane: DesktopPermissionPane | undefined) => void
}

/**
 * Declares the section state and write surface.
 * @returns the store handle.
 */
export function createDesktopSectionStore(): EngineStoreHandle<DesktopSectionState, DesktopSectionActions> {
  return defineStore({
    init: (): DesktopSectionState => ({
      status: 'loading',
      browserUse: false,
      computerUse: false,
      lockScreenOperation: false,
      permissions: undefined,
      guide: undefined,
      revision: -1,
    }),
    actions: {
      sync: (d, value, status) => {
        d.status = status
        if (value !== undefined) {
          d.browserUse = value.browserUse === true
          d.computerUse = value.computerUse === true
          d.lockScreenOperation = value.lockScreenOperation === true
        }
        d.revision += 1
      },
      setPermissions: (d, value) => {
        d.permissions = value
        // A landed grant retires the guide walking the user through it.
        if (value !== undefined && value.accessibility && value.screenRecording) d.guide = undefined
        d.revision += 1
      },
      setGuide: (d, pane) => {
        d.guide = pane
        d.revision += 1
      },
    },
  })
}
