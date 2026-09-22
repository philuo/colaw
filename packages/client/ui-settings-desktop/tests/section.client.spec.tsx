// @vitest-environment jsdom
/** The 电脑操控 section's permission block: probe-driven states over the slot store. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  setField?: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
  setRevoked?: (value: boolean) => void
  dismissPending?: () => void
  openMissingPane?: () => void
  restartApp?: () => void
} = {}) {
  const store = createDesktopSectionStore().create()
  store.actions.sync(undefined, options.status ?? 'ready')
  const refreshPermissions = options.refreshPermissions ?? vi.fn()
  render(<DesktopSection
    {...standard}
    close={vi.fn()}
    useStore={bindSnapshotSelector(store)}
    actions={store.actions}
    t={t}
    setField={options.setField ?? vi.fn()}
    refreshPermissions={refreshPermissions}
    setGuide={(pane) => { store.actions.setGuide(pane) }}
    setGrantDone={(field) => { store.actions.setGrantDone(field) }}
    setRevoked={options.setRevoked ?? ((value) => { store.actions.setRevoked(value) })}
    dismissPending={options.dismissPending ?? vi.fn()}
    openMissingPane={options.openMissingPane ?? vi.fn()}
    revealAppInFinder={vi.fn()}
    restartApp={options.restartApp ?? vi.fn()}
  />)
  return { store, refreshPermissions }
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

  it('floats the grant guide when an enable finds a grant missing, and retires it on a full grant', () => {
    const { store } = mountSection()
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: false }) })
    act(() => { store.actions.setGuide('screenRecording') })
    expect(screen.getByRole('dialog', { name: en.guideTitle })).toBeDefined()
    expect(screen.getByText(en.guideRecheck)).toBeDefined()
    // A full grant retires the guide without a dismissal click.
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: true }) })
    expect(screen.queryByRole('dialog', { name: en.guideTitle })).toBeNull()
  })

  it('keeps the switch off while grants are missing — the guide carries the pending state', () => {
    const setField = vi.fn()
    const { store } = mountSection({ setField })
    // The wiring probes before enabling: with grants missing the switch never
    // turns on — the drag-guide bar is what shows the enable is in flight.
    expect(setField).not.toHaveBeenCalled()
    act(() => { store.actions.setPendingEnable('computerUse') })
    act(() => { store.actions.setGuide('screenRecording') })
    expect(screen.getByRole('switch', { name: en.computerUseTitle }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('dialog', { name: en.guideTitle })).toBeDefined()
    expect(screen.getByText(en.pendingWaiting)).toBeDefined()
  })

  it('asks the user to flip the switch once the grants land — it never flips it for them', () => {
    const setField = vi.fn()
    const { store } = mountSection({ setField })
    act(() => { store.actions.setPendingEnable('computerUse') })
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: true }) })
    // The grant retiring the guide is the wiring's job; the store's own write
    // is what the section reacts to here.
    act(() => { store.actions.setGuide(undefined) })
    expect(screen.getByRole('switch', { name: en.computerUseTitle }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.pendingTitle)).toBeDefined()
    // Nothing enabled the capability on its own: the switch is the user's.
    expect(setField).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.pendingAction))
    expect(setField).toHaveBeenCalledWith('computerUse', true)
  })

  it('dismisses the pending prompt without touching the switch', () => {
    const setField = vi.fn()
    const dismissPending = vi.fn()
    const { store } = mountSection({ setField, dismissPending })
    act(() => { store.actions.setPendingEnable('computerUse') })
    expect(screen.getByText(en.pendingWaiting)).toBeDefined()
    fireEvent.click(screen.getByText(en.guideDismiss))
    expect(dismissPending).toHaveBeenCalledTimes(1)
    expect(setField).not.toHaveBeenCalled()
  })

  it('announces the restart a saved capability needs, and offers it', () => {
    const restartApp = vi.fn()
    const { store } = mountSection({ restartApp })
    // The switch's own wiring raises this once the capability is persisted:
    // both gated capabilities mount their provider from `apply` at boot, so a
    // saved flip only lands on the next start.
    act(() => { store.actions.setGrantDone('browserUse') })
    expect(screen.getByText(en.grantDoneTitle)).toBeDefined()
    fireEvent.click(screen.getByText(en.grantRestart))
    // `restartApp` is the host's own relaunch; the section only asks for it.
    expect(restartApp).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText(en.guideDismiss))
    expect(screen.queryByText(en.grantDoneTitle)).toBeNull()
  })

  it('reports a revoked grant as a warning and offers the walkthrough again', () => {
    const openMissingPane = vi.fn()
    const { store } = mountSection({ openMissingPane })
    act(() => { store.actions.setPermissions({ accessibility: true, screenRecording: true }) })
    expect(screen.queryByRole('alert', { name: en.revokedTitle })).toBeNull()
    // The watcher witnessed a grant that was there and is gone.
    act(() => { store.actions.setRevoked(true) })
    expect(screen.getByRole('alert', { name: en.revokedTitle })).toBeDefined()
    expect(screen.getByText(en.revokedHint)).toBeDefined()
    fireEvent.click(screen.getByText(en.revokedRegrant))
    expect(openMissingPane).toHaveBeenCalledTimes(1)
    // Dismissing is the user's acknowledgement, not a state change.
    fireEvent.click(screen.getByText(en.guideDismiss))
    expect(screen.queryByRole('alert', { name: en.revokedTitle })).toBeNull()
  })

  it('stands the in-page bar down while the native drag-guide is up', () => {
    const { store } = mountSection()
    act(() => { store.actions.setGuide('accessibility') })
    expect(screen.getByRole('dialog', { name: en.guideTitle })).toBeDefined()
    act(() => { store.actions.setNativeGuide(true) })
    // The native bar owns the guidance; the page stops drawing its own.
    expect(screen.queryByRole('dialog', { name: en.guideTitle })).toBeNull()
    act(() => { store.actions.setNativeGuide(false) })
    expect(screen.getByRole('dialog', { name: en.guideTitle })).toBeDefined()
  })

  it('dismisses the guide and answers a re-check with the itemized list', () => {
    const { store } = mountSection()
    act(() => { store.actions.setPermissions({ accessibility: false, screenRecording: false }) })
    act(() => { store.actions.setGuide('accessibility') })
    expect(screen.getByRole('dialog', { name: en.guideTitle })).toBeDefined()
    fireEvent.click(screen.getByText(en.guideDismiss))
    expect(screen.queryByRole('dialog', { name: en.guideTitle })).toBeNull()
    expect(screen.getAllByText(en.permissionMissing).length).toBe(3)
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
