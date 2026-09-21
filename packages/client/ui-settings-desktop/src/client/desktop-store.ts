/**
 * The 电脑操控 section's slot store: a mirror of the desktop-control scope
 * snapshot. The plugin's apply-world change listener is the only writer; the
 * section reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DesktopSettings } from '../desktop-settings.ts'

/** Mirror state: the three switches plus the scope's sync facts. */
export interface DesktopSectionState {
  status: 'loading' | 'ready' | 'unavailable'
  browserUse: boolean
  computerUse: boolean
  lockScreenOperation: boolean
  /** Bumped on every sync so the store always publishes a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type DesktopSectionActions = {
  sync: (draft: DesktopSectionState, value: DesktopSettings | undefined, status: DesktopSectionState['status']) => void
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
    },
  })
}
