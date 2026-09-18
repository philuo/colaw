// @vitest-environment jsdom
/** Terminal type, copy, seats and explicit cleanup follow the plugin lifetime. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { SidebarRightCloseHandler } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { TerminalGuide, type TerminalGuideInjected } from '../src/client/TerminalGuide.tsx'
import { TerminalBody } from '../src/client/TerminalBody.tsx'
import { TerminalTitle } from '../src/client/TerminalTitle.tsx'
import { TerminalRecovery, type TerminalRecoveryInjected } from '../src/client/TerminalRecovery.tsx'
import { TerminalCleanup, type TerminalCleanupInjected } from '../src/client/TerminalCleanup.tsx'
import type { TerminalBodyInjected } from '../src/client/face.ts'
import { en, zh } from '../src/client/locales.ts'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

const terminalInfo = (id: string): WebTerminalInfo => ({ id: id as WebTerminalId, title: id, shell: { path: '/bin/sh', name: 'sh', args: ['-i'] }, cwd: '/workspace', cols: 80, rows: 24, state: 'running', exitCode: null })

async function mountPlugin() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  const entries: {
    name: string
    key?: string
    id?: string
    locale: string
    component: unknown
    inject: (id: SessionId) => unknown
  }[] = []
  const dictionaries = new Map<string, unknown>()
  let closeHandler: SidebarRightCloseHandler | undefined
  let terminalState: { phase: string; writable: boolean; ended?: boolean } = { phase: 'idle', writable: false }
  const endListeners = new Set<() => void>()
  const lifetime = new AbortController()
  const model = {
    state: {
      getSnapshot: () => terminalState,
      subscribe: (listener: () => void) => { endListeners.add(listener); return () => { endListeners.delete(listener) } },
    },
    signal: lifetime.signal,
  }
  const closeIn = vi.fn()
  const terminals = {
    view: vi.fn(() => model), close: vi.fn(), closeFailures: {}, retryClose: vi.fn(),
    launchShells: vi.fn(async () => ({ shells: [], selectedShell: undefined })), selectShell: vi.fn(),
    recover: vi.fn(async (_sessionId: SessionId): Promise<WebTerminalInfo[]> => []),
  }
  let params: { terminalId: WebTerminalId } | { shellPath: string } | undefined
  const occurrence = vi.fn(() => ({ navigation: { getSnapshot: () => ({ params }) } }))
  const openTabIn = vi.fn()
  ctx.provide('webTerminals', terminals as never)
  ctx.provide('sidebarRight', {
    tabDomain: { occurrence }, openTabIn, closeIn,
    registerCloseHandler: (kind: string, handler: SidebarRightCloseHandler) => { expect(kind).toBe('terminal'); closeHandler = handler; return () => { closeHandler = undefined } },
  } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<typeof entries[number], 'component'>, component: unknown) => { const entry = { ...options, component }; entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1) } },
  } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: (name: string, values: unknown) => { dictionaries.set(name, values); return () => { dictionaries.delete(name) } },
  } as never)
  const theme = { preference: 'light' as const, fontSize: 14, active: { id: 'light', colorScheme: 'light' as const, tokens: {} }, themes: [], revision: 0 }
  ctx.provide('theme', { getTheme: () => theme } as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    tabs, entries, dictionaries, terminals, model, occurrence, openTabIn, theme, closeIn,
    get endWatchers() { return endListeners.size },
    emitTheme() { ctx.emit('theme/change', theme) },
    /** Report the Host process ending on its own, the way the model publishes it. */
    endTerminal() { terminalState = { ...terminalState, ended: true }; for (const listener of [...endListeners]) listener() },
    abortLifetime() { lifetime.abort() },
    get closeHandler() { return closeHandler },
    setParams(next: typeof params) { params = next },
    async dispose() { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

it('registers terminal views, recovery and cleanup, then releases every contribution on unload', async () => {
  expect(hostApply).not.toThrow()
  const h = await mountPlugin()
  try {
    const definition = h.tabs.get('terminal')!
    expect(definition.title('sidebar://terminal')).toBe('title')
    expect(definition.guide?.map(entry => [entry.order, entry.title(), entry.description?.()])).toEqual([[20, 'new', 'description']])
    const Icon = definition.guide?.[0]?.icon
    if (Icon === undefined) throw new Error('Terminal guide icon was not registered')
    expect(renderToStaticMarkup(createElement(Icon, { size: 22 }))).toContain('width="22"')
    expect(renderToStaticMarkup(createElement(Icon))).toContain('width="26"')
    expect(definition.multiple).toBe(true)
    expect(h.dictionaries.get('sidebarTerminal')).toEqual({ en, zh })
    expect(h.entries.map(entry => [entry.name, entry.component, entry.locale])).toEqual([
      ['sidebar.right.tab.guide.entry', TerminalGuide, 'sidebarTerminal'],
      ['sidebar.right.pane.tab', TerminalBody, 'sidebarTerminal'],
      ['sidebar.right.pane.tab.title', TerminalTitle, 'sidebarTerminal'],
      ['conversation.session.header.actions', TerminalRecovery, 'sidebarTerminal'],
      ['shell.overlay', TerminalCleanup, 'sidebarTerminal'],
    ])
    const sessionId = 'session' as SessionId
    const launcher = h.entries[0]!.inject(sessionId) as TerminalGuideInjected
    const signal = new AbortController().signal
    await launcher.loadShells(signal)
    expect(h.terminals.launchShells).toHaveBeenCalledWith(sessionId, signal)
    launcher.selectShell('/bin/bash')
    expect(h.terminals.selectShell).toHaveBeenCalledWith('/bin/bash')
    const face = h.entries[1]!.inject(sessionId) as TerminalBodyInjected
    expect(face.hooks.theme.getSnapshot()).toBe(h.theme)
    const changed = vi.fn()
    const unsubscribe = face.hooks.theme.subscribe(changed)
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    expect(face.view('tab')).toBe(h.model)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', undefined, undefined)
    const terminalId = 'retained' as WebTerminalId
    h.setParams({ terminalId })
    h.setParams({ shellPath: '/bin/bash' })
    face.view('tab')
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', undefined, '/bin/bash')
    h.setParams({ terminalId })
    expect(face.keyedHooks.terminal('tab')).toBe(h.model.state)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', terminalId, undefined)
    expect(h.occurrence).toHaveBeenLastCalledWith(sessionId, { id: 'tab' })
    if (h.closeHandler === undefined) throw new Error('Terminal close handler was not registered')
    h.closeHandler(sessionId, { id: 'tab' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'tab', terminalId)
    h.setParams(undefined)
    h.closeHandler(sessionId, { id: 'new-tab' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'new-tab', undefined)
    const cleanupFace = h.entries[4]!.inject(sessionId) as TerminalCleanupInjected
    expect(cleanupFace.hooks.closeFailures).toBe(h.terminals.closeFailures)
    cleanupFace.retryClose('terminal' as Parameters<TerminalCleanupInjected['retryClose']>[0])
    expect(h.terminals.retryClose).toHaveBeenCalledWith('terminal')
  } finally {
    await h.dispose()
  }
  expect(h.closeHandler).toBeUndefined()
  expect(h.tabs.get('terminal')).toBeUndefined()
  expect(h.entries).toEqual([])
  expect(h.dictionaries.size).toBe(0)
})

it('retires a terminal tab once, when its Host process ends on its own', async () => {
  const h = await mountPlugin()
  const sessionId = 'session' as SessionId
  try {
    const face = h.entries[1]!.inject(sessionId) as TerminalBodyInjected
    face.view('tab')
    face.view('tab')
    // One watcher per view, however often a body asks for it.
    expect(h.endWatchers).toBe(1)
    expect(h.closeIn).not.toHaveBeenCalled()
    h.endTerminal()
    expect(h.closeIn).toHaveBeenCalledExactlyOnceWith(sessionId, 'tab')
    // The watcher detaches on the end it reports, so a repeated notification —
    // or a repeated end — can never retire the same tab twice.
    expect(h.endWatchers).toBe(0)
    h.endTerminal()
    expect(h.closeIn).toHaveBeenCalledOnce()
  } finally {
    await h.dispose()
  }
})

it('detaches a terminal end watcher with the view that owns it', async () => {
  const h = await mountPlugin()
  const sessionId = 'session' as SessionId
  try {
    const face = h.entries[1]!.inject(sessionId) as TerminalBodyInjected
    face.view('tab')
    expect(h.endWatchers).toBe(1)
    h.abortLifetime()
    expect(h.endWatchers).toBe(0)
    h.endTerminal()
    expect(h.closeIn).not.toHaveBeenCalled()
  } finally {
    await h.dispose()
  }
})

it('shares pending and completed recovery across Session headers and opens each returned terminal once', async () => {
  const h = await mountPlugin()
  const pending = Promise.withResolvers<WebTerminalInfo[]>()
  h.terminals.recover.mockImplementationOnce(() => pending.promise)
  const sessionId = 'session' as SessionId
  const recovery = h.entries[3]!.inject(sessionId) as TerminalRecoveryInjected
  const remounted = h.entries[3]!.inject(sessionId) as TerminalRecoveryInjected
  const completion = recovery.restore()
  try {
    expect(remounted.restore()).toBe(completion)
    expect(h.terminals.recover).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(h.openTabIn).not.toHaveBeenCalled()
    pending.resolve([terminalInfo('build'), terminalInfo('tests')])
    await completion
    expect(h.openTabIn.mock.calls).toEqual([
      [sessionId, 'terminal', { params: { terminalId: 'build' } }],
      [sessionId, 'terminal', { params: { terminalId: 'tests' } }],
    ])
    await remounted.restore()
    expect(h.terminals.recover).toHaveBeenCalledTimes(1)
    expect(h.openTabIn).toHaveBeenCalledTimes(2)
    const otherSession = 'other-session' as SessionId
    await (h.entries[3]!.inject(otherSession) as TerminalRecoveryInjected).restore()
    expect(h.terminals.recover).toHaveBeenLastCalledWith(otherSession)
    expect(h.terminals.recover).toHaveBeenCalledTimes(2)
    expect(h.openTabIn).toHaveBeenCalledTimes(2)
  } finally {
    pending.resolve([])
    await completion
    await h.dispose()
  }
})

it('allows a failed Host lookup to be retried without marking the Session recovered', async () => {
  const h = await mountPlugin()
  const unavailable = new Error('Host unavailable')
  h.terminals.recover.mockRejectedValueOnce(unavailable)
  const sessionId = 'session' as SessionId
  const recovery = h.entries[3]!.inject(sessionId) as TerminalRecoveryInjected
  try {
    await expect(recovery.restore()).rejects.toBe(unavailable)
    expect(h.openTabIn).not.toHaveBeenCalled()
    await recovery.restore()
    await recovery.restore()
    expect(h.terminals.recover).toHaveBeenCalledTimes(2)
  } finally {
    await h.dispose()
  }
})

it('does not open retained terminals when their lookup completes after plugin unload', async () => {
  const h = await mountPlugin()
  const pending = Promise.withResolvers<WebTerminalInfo[]>()
  h.terminals.recover.mockImplementationOnce(() => pending.promise)
  const recovery = h.entries[3]!.inject('session' as SessionId) as TerminalRecoveryInjected
  const completion = recovery.restore()
  try {
    expect(h.terminals.recover).toHaveBeenCalledOnce()
    await h.dispose()
    pending.resolve([terminalInfo('build')])
    await completion
    expect(h.openTabIn).not.toHaveBeenCalled()
  } finally {
    pending.resolve([])
    await completion
    await h.dispose()
  }
})
