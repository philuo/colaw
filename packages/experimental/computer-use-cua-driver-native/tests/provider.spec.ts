/** Native SDK lifecycle and catalog behavior without desktop access. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeProvider from '../src/index.ts'
import { catalog, fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))
// The provider reaches the driver through a child process now. These cases
// assert what it does with the driver's answers — exposure filtering, catalog
// validation, result adaptation — so the host is swapped for an in-process
// one against the same external fixture. `driver-host.spec.ts` owns the
// process boundary itself.
vi.mock('../src/driver-host.ts', async () => import('./fixtures/driver-host.ts'))

/**
 * The provider gates on the 电脑操控 namespace. The harness answers with the
 * section switched on — every case below exercises the enabled surface — and
 * `gate` flips the stored fact for the one case that pins the off behaviour.
 */
const desktopSwitches = { computerUse: true }
const settingsStub = {
  get: (namespace: string): Record<string, unknown> | undefined =>
    namespace === 'ui-desktop-control' ? desktopSwitches : undefined,
}

let ctx: Context

beforeEach(async () => {
  resetFixture()
  desktopSwitches.computerUse = true
  ctx = new Context()
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('settings', settingsStub as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function execute(rawName: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    name: `cua_driver_native__${rawName}`,
    callId: ToolCallId('native-test'),
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('Cua Driver native provider', () => {
  it('mounts inertly when the 电脑操控 switch is off', async () => {
    desktopSwitches.computerUse = false
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    desktopSwitches.computerUse = true
  })

  it('registers the upstream catalog and calls its raw names', async () => {
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(catalog.tools.map(tool => `cua_driver_native__${tool.name}`))
    const result = await execute('click', { pid: 9, window_id: 7 })
    expect(result.isError).toBe(false)
    expect(fixture.calls).toMatchObject([{ name: 'click', args: { pid: 9, window_id: 7 } }])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('rejects another provider before importing or creating a native runtime', async () => {
    const release = ctx.computerUse.register(ComputerUseProviderName('another-driver'))
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow('already registered')
    expect(fixture.creates).toBe(0)
    expect(ctx.computerUse.providerName).toBe('another-driver')
    await release()
  })

  it('rolls back a failed native constructor', async () => {
    fixture.createError = new Error('native library initialization failed')
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow('native library initialization failed')
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(0)
  })

  it('accepts upstream tools whose optional description is absent', async () => {
    fixture.list = async () => JSON.stringify({ tools: [{ name: 'check_permissions', inputSchema: { type: 'object', properties: {} } }] })
    await ctx.plugin(NativeProvider)
    expect(ctx.tools.schemas()[0]?.description).toBe('')
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing catalog', '{}'],
    ['duplicate names', JSON.stringify({ tools: [catalog.tools[0], catalog.tools[0]] })],
    ['invalid function name', JSON.stringify({ tools: [{ ...catalog.tools[0], name: 'x'.repeat(70) }] })],
  ])('rolls back the native runtime after %s', async (_label, response) => {
    fixture.list = async () => response
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow()
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('preserves native tool refusals as model-visible errors', async () => {
    fixture.call = async () => ({ isError: true, content: [{ type: 'text', text: 'background_unavailable' }] })
    await ctx.plugin(NativeProvider)
    const result = await execute('click', { pid: 9, window_id: 7 })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: background_unavailable' }])
  })

  it('leaves an unrelated tool running when the native provider unloads', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const settled = Promise.withResolvers<boolean>()
    const controller = new AbortController()
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    ctx.tools.register({
      name: 'unrelated', description: 'Independent tool.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Done.' }] },
      execute(_args, exec) {
        started.resolve(exec.signal)
        return settled.promise
      },
    })
    const result = ctx.tools.execute({
      name: 'unrelated', callId: ToolCallId('unrelated'), arguments: {}, signal: controller.signal,
    })
    try {
      const signal = await started.promise
      await fiber.dispose()
      expect(signal).toBe(controller.signal)
      expect(signal.aborted).toBe(false)
      expect(fixture.shutdowns).toBe(1)
      expect(fixture.destroys).toBe(1)
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['unrelated'])
    } finally {
      settled.resolve(true)
      await result
    }
    expect((await result).isError).toBe(false)
  })

  it('retains the reservation until aborted calls and native shutdown settle', async () => {
    const called: PromiseWithResolvers<void> = Promise.withResolvers()
    const callSettled = Promise.withResolvers<unknown>()
    const shutdownStarted: PromiseWithResolvers<void> = Promise.withResolvers()
    const shutdownSettled: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.call = async () => {
      called.resolve()
      return callSettled.promise
    }
    fixture.shutdown = async () => {
      shutdownStarted.resolve()
      await shutdownSettled.promise
    }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    const result = execute('click', { pid: 9, window_id: 7 })
    await called.promise
    const disposal = fiber.dispose()
    try {
      await vi.waitFor(() => {
        expect(fixture.calls[0]?.signal?.aborted).toBe(true)
        expect(ctx.tools.schemas()).toEqual([])
      })
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
      callSettled.resolve({ content: [{ type: 'text', text: 'late native completion' }] })
      await shutdownStarted.promise
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      expect(fixture.destroys).toBe(0)
    } finally {
      callSettled.resolve({ content: [] })
      shutdownSettled.resolve()
      await disposal
    }
    expect((await result).isError).toBe(true)
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(fixture.destroys).toBe(1)
  })

  it.each([['tools', ToolRuntime], ['systemPrompt', SystemPrompt]] as const)('closes the old native runtime before %s restarts it', async (_name, service) => {
    const shutdownStarted: PromiseWithResolvers<void> = Promise.withResolvers()
    const shutdownSettled: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.shutdown = async () => {
      shutdownStarted.resolve()
      await shutdownSettled.promise
    }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    const dependency = [...ctx.registry.get(service)!.fibers][0]!
    const restart = dependency.restart()
    try {
      await shutdownStarted.promise
      expect(fixture.creates).toBe(1)
      expect(fixture.destroys).toBe(0)
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    } finally {
      shutdownSettled.resolve()
      await restart
      await fiber
    }
    await vi.waitFor(() => { expect(fixture.creates).toBe(2) })
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
    expect((await execute('check_permissions')).isError).toBe(false)
    await fiber.dispose()
    expect(fixture.shutdowns).toBe(2)
    expect(fixture.destroys).toBe(2)
  })

  it('interrupts discovery when unloaded during startup', async () => {
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.list = signal => new Promise((_resolve, reject) => {
      started.resolve()
      signal?.addEventListener('abort', () => { reject(new Error('Native discovery aborted')) }, { once: true })
    })
    const fiber = ctx.plugin(NativeProvider)
    const readiness = Promise.resolve(fiber).catch(() => undefined)
    await started.promise
    await fiber.dispose()
    await readiness
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('withholds the tools that can abort the host process', async () => {
    fixture.list = async () => JSON.stringify({
      tools: [
        ...catalog.tools,
        { name: 'invoke_menu', description: 'Resolve and invoke a menu path.', inputSchema: { type: 'object', properties: {} } },
        { name: 'replay_trajectory', description: 'Replay a recorded directory.', inputSchema: { type: 'object', properties: {} } },
      ],
    })
    await ctx.plugin(NativeProvider)
    const registered = ctx.tools.schemas().map(tool => tool.name)
    expect(registered).not.toContain('cua_driver_native__invoke_menu')
    expect(registered).not.toContain('cua_driver_native__replay_trajectory')
    expect(registered).toEqual(catalog.tools.map(tool => `cua_driver_native__${tool.name}`))
    // The tool surface alone is not the guarantee: the native registry boundary
    // enforces the same split, where deny is evaluated before allow.
    const policy = readFileSync(process.env.CUA_DRIVER_POLICY_FILE!, 'utf8')
    expect(policy).toContain('    - invoke_menu')
    expect(policy).toContain('    - replay_trajectory')
    expect(policy).toContain('    - get_window_state')
    expect(policy).toContain('deny:')
  })

  it('refuses to mount when a catalog tool has no exposure decision', async () => {
    fixture.list = async () => JSON.stringify({
      tools: [...catalog.tools, { name: 'brand_new_tool', description: 'Added upstream.', inputSchema: { type: 'object', properties: {} } }],
    })
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow('no exposure decision: brand_new_tool')
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('keeps the reservation when native shutdown cannot prove completion', async () => {
    fixture.shutdown = async () => { throw new Error('Native shutdown failed') }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    expect(fixture.destroys).toBe(0)
    expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
  })
})
