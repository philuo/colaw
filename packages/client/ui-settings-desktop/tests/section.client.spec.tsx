// @vitest-environment jsdom
/** The 电脑操控 section's permission block: probe-driven states over the slot store. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createDesktopSectionStore } from '../src/client/desktop-store.ts'
import type { DesktopSectionComponentProps } from '../src/client/DesktopSection.tsx'
import { DesktopSection } from '../src/client/DesktopSection.tsx'
import { en } from '../src/client/locales.ts'
// Imported for the LocaleNamespaceMap augmentation ('settings.desktop'), which
// makes the slot-composed `t` seat resolve in this program.
import '../src/client/index.ts'

afterEach(cleanup)

const t: DesktopSectionComponentProps['t'] = key => en[key as keyof typeof en]

// The standard props the shell binds at runtime; none of them reach this
// section's own logic, so static stubs suffice.
const standard: GlobalStandardProps = {
  usePanelInfo: selector => selector({ activePanelId: null }),
  useSessions: (() => ({ ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} })) as GlobalStandardProps['useSessions'],
  useSessionStatus: (() => undefined) as GlobalStandardProps['useSessionStatus'],
  useSessionRetainInfo: () => undefined,
  useResource: (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource'],
  useWorkspaces: (() => ({ ids: [], byId: {}, phase: 'ready' })) as GlobalStandardProps['useWorkspaces'],
}

/** Render one section over a fresh store, with the probes recorded. */
function mountSection(options: {
  status?: 'ready'
  refreshPermissions?: () => void
  openPermissionSettings?: () => void
} = {}) {
  const store = createDesktopSectionStore().create()
  store.actions.sync(undefined, options.status ?? 'ready')
  const refreshPermissions = options.refreshPermissions ?? vi.fn()
  const openPermissionSettings = options.openPermissionSettings ?? vi.fn()
  render(<DesktopSection
    {...standard}
    close={vi.fn()}
    useStore={bindSnapshotSelector(store)}
    actions={store.actions}
    t={t}
    setField={vi.fn()}
    refreshPermissions={refreshPermissions}
    openPermissionSettings={openPermissionSettings}
  />)
  return { store, refreshPermissions, openPermissionSettings }
}

describe('DesktopSection permission block', () => {
  it('shows 检测中 while no probe has answered, and probes on mount', () => {
    const { refreshPermissions } = mountSection()
    expect(screen.getByText(en.permissionChecking)).toBeDefined()
    expect(refreshPermissions).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(en.permissionOpenSettings)).toBeNull()
  })

  it('reports a fully granted pair as 已授权 with no guidance block', () => {
    const { store } = mountSection()
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: true }) })
    expect(screen.getByText(en.permissionGranted)).toBeDefined()
    expect(screen.queryByText(en.permissionAccessibility)).toBeNull()
    expect(screen.queryByText(en.permissionOpenSettings)).toBeNull()
  })

  it('itemizes each missing grant and deep-links System Settings on demand', async () => {
    const openPermissionSettings = vi.fn()
    const { store } = mountSection({ openPermissionSettings })
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: false }) })
    // The head pill and the failing row both read 未授权; the granted row
    // reads 已授权. (Class tint is a stylesheet concern; jsdom sees no CSS.)
    expect(screen.getAllByText(en.permissionMissing).length).toBe(2)
    expect(screen.getAllByText(en.permissionGranted).length).toBe(1)
    fireEvent.click(screen.getByText(en.permissionOpenSettings))
    await waitFor(() => { expect(openPermissionSettings).toHaveBeenCalledTimes(1) })
  })

  it('recovers the answer when a later probe succeeds after a rejected one', () => {
    const { store } = mountSection()
    // Rejected probes leave the answer unset (检测中 stays); a subsequent
    // successful probe — the next mount, or a Settings deep-link — lands it.
    act(() => { store.actions.setPermissions({ accessibility: false, screenRecording: false }) })
    expect(screen.getAllByText(en.permissionMissing).length).toBeGreaterThan(0)
    act(() => { store.actions.setPermissions(undefined) })
    expect(screen.getByText(en.permissionChecking)).toBeDefined()
  })
})
