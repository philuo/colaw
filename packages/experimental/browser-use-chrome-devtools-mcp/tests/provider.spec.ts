import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => vi.clearAllMocks())

/**
 * The provider gates on the 电脑操控 namespace, so the harness answers as the
 * tab does. It is switched on for every case below except the one that pins the
 * off behaviour: with Browser_use off the provider mounts inertly and no MCP
 * server process is ever configured.
 */
const desktopSwitches = { browserUse: true }
const settingsStub = {
  get: (namespace: string): Record<string, unknown> | undefined =>
    namespace === 'ui-desktop-control' ? desktopSwitches : undefined,
}
let ctx: Context

beforeEach(() => {
  desktopSwitches.browserUse = true
  ctx = new Context()
  ctx.provide('settings', settingsStub as never)
})

it('resolves the installed DevTools CLI and explicitly selects isolated headed or headless launch', () => {
  Provider.apply(ctx, Provider.Config({ mode: 'launch', executablePath: '/custom/chrome', toolCallTimeoutMs: 456 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'chrome-devtools-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 456 })
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=true', '--executable-path', '/custom/chrome'])
  Provider.apply(ctx, Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=false'])
  expect('default' in Provider).toBe(false)
})

it.each([
  ['http://127.0.0.1:9222', '--browser-url'],
  ['wss://browser.example/devtools/browser/id', '--ws-endpoint'],
])('attaches to %s without passing launch flags', (endpoint, flag) => {
  Provider.apply(ctx, Provider.Config({ mode: 'attach', endpoint }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', flag, endpoint])
})

it('rejects trailing endpoint garbage before mounting any browser resources', () => {
  expect(() => { Provider.apply(ctx, Provider.Config({ mode: 'attach', endpoint: 'http://localhost trailing-junk' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('mounts nothing while the 电脑操控 tab has Browser_use switched off', () => {
  desktopSwitches.browserUse = false
  Provider.apply(ctx, Provider.Config({ mode: 'launch' }))
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('stays inert when the settings service carries no ui-desktop-control section', () => {
  // A namespace the tab never registered (or a renamed one) fails closed: the
  // provider must not hand out a browser the user never switched on.
  ctx = new Context()
  ctx.provide('settings', { get: () => undefined } as never)
  Provider.apply(ctx, Provider.Config({ mode: 'launch' }))
  expect(mountSessionMcp).not.toHaveBeenCalled()
})
