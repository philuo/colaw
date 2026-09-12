// @vitest-environment jsdom
/** Office body lifecycle: format dispatch, progress chrome, failure retry, and dispose-on-replacement. */
import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { openDocx, openPptx, openXlsx, OfficeHandle } from '../src/client/office/runtime.ts'

const engine = vi.hoisted(() => ({
  docx: vi.fn<typeof openDocx>(),
  pptx: vi.fn<typeof openPptx>(),
  xlsx: vi.fn<typeof openXlsx>(),
}))
vi.mock('../src/client/office/runtime.ts', () => ({
  openDocx: engine.docx, openPptx: engine.pptx, openXlsx: engine.xlsx,
}))
import { OfficeBody, type OfficeFormatBodyProps } from '../src/client/office/OfficeBody.tsx'
import { en } from '../src/client/office/locales.ts'

/** One scripted loader session, shared by every format's mocked opener. */
interface Loader {
  readonly deferred: ReturnType<typeof Promise.withResolvers<OfficeHandle>>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly hooks: {
    readonly onProgress: (index: number, total: number) => void
    readonly onError: (error: Error) => void
  }
}

const loads: Loader[] = []

function recordLoad(hooks: Loader['hooks']): Promise<OfficeHandle> {
  const deferred = Promise.withResolvers<OfficeHandle>()
  const dispose = vi.fn(() => {})
  loads.push({ deferred, dispose, hooks })
  return deferred.promise
}

beforeEach(() => {
  loads.length = 0
  for (const opener of [engine.docx, engine.pptx, engine.xlsx]) {
    opener.mockReset().mockImplementation((_surface: unknown, _data: ArrayBuffer, hooks: Loader['hooks']) =>
      recordLoad(hooks))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Production binds one translate per locale namespace; mirror that stability.
const T = makeTranslate(en)

function harness() {
  const controller = new AbortController()
  const tabId = 'office-tab' as TabId
  function View({ format, data = 'one', kind = 'bytes' }:
  { readonly format: 'docx' | 'pptx' | 'xlsx'; readonly data?: string; readonly kind?: 'bytes' | 'text' }) {
    const bytes = useMemo(() => new TextEncoder().encode(data), [data])
    // A new data string is a new byte identity, exactly as a reload delivers.
    const content = kind === 'bytes'
      ? { kind, data: bytes } as const
      : { kind, text: '', pages: [], eof: true } as const
    const props = {
      resourceAddress: `dsh-resource://file/session/s/report.${format}`,
      content, wrap: false,
      useTabInfo: () => ({ tab: { id: tabId, signal: controller.signal } }),
      t: T,
      format,
    } as unknown as OfficeFormatBodyProps
    return <OfficeBody {...props} />
  }
  return { controller, tabId, View }
}

const handleOf = (navigate?: OfficeHandle['navigate']): OfficeHandle => ({ dispose: vi.fn(), ...navigate === undefined ? {} : { navigate } })

describe('Office body', () => {
  it('reports non-byte contents without parsing', () => {
    const h = harness()
    render(<h.View format="docx" kind="text" />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(engine.docx).not.toHaveBeenCalled()
  })

  it('does not start a load for a tab record that has already ended', () => {
    const h = harness()
    h.controller.abort()
    render(<h.View format="docx" />)
    expect(engine.docx).not.toHaveBeenCalled()
  })

  it('mounts a canvas for Word, reports progress, and pages through the handle', async () => {
    const h = harness()
    const view = render(<h.View format="docx" />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(view.container.querySelector('canvas')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.nextPage })).toBeNull()
    const handle = handleOf({
      previous: vi.fn(),
      next: vi.fn(),
    })
    await act(async () => {
      loads[0]!.hooks.onProgress(0, 3)
      loads[0]!.deferred.resolve(handle)
    })
    await act(async () => {})
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(en.pageOf.replace('{index}', '1').replace('{total}', '3'))).toBeTruthy()
    // At the first page the back button is spent; the forward button drives the viewer.
    expect(screen.getByRole('button', { name: en.previousPage }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
    expect(handle.navigate!.next).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-office-preview="docx"]')).toBeTruthy()
  })

  it('mounts no canvas for Excel and never renders the page chrome', async () => {
    const h = harness()
    const view = render(<h.View format="xlsx" />)
    await act(async () => { loads[0]!.deferred.resolve(handleOf()) })
    await act(async () => {})
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(view.container.querySelector('[data-office-preview="xlsx"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.nextPage })).toBeNull()
  })

  it('replaces the session and disposes the previous viewer when the data changes', async () => {
    const h = harness()
    const mounted = render(<h.View format="pptx" data="old" />)
    const first = handleOf({ previous: vi.fn(), next: vi.fn() })
    await act(async () => { loads[0]!.deferred.resolve(first) })
    await act(async () => {})
    mounted.rerender(<h.View format="pptx" data="new" />)
    // The stale viewer is disposed through the effect cleanup, and a new load starts.
    await act(async () => {})
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(engine.pptx).toHaveBeenCalledTimes(2)
    expect(loads[1]!.dispose).not.toHaveBeenCalled()
    const second = handleOf({ previous: vi.fn(), next: vi.fn() })
    await act(async () => { loads[1]!.deferred.resolve(second) })
    await act(async () => {})
    mounted.unmount()
    // Dispose rides the effect cleanup's settle; give the microtask a turn.
    await act(async () => {})
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('shows a load failure with retry that restarts the parse', async () => {
    const h = harness()
    render(<h.View format="docx" />)
    await act(async () => { loads[0]!.deferred.reject(new Error('bad ooxml')) })
    expect(screen.getByRole('alert').textContent).toContain('bad ooxml')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await act(async () => {})
    expect(engine.docx).toHaveBeenCalledTimes(2)
  })

  it('routes a post-load viewer failure to the same failure line', async () => {
    const h = harness()
    render(<h.View format="docx" />)
    await act(async () => { loads[0]!.deferred.resolve(handleOf({ previous: vi.fn(), next: vi.fn() })) })
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { loads[0]!.hooks.onError(new Error('render blew up')) })
    expect(screen.getByRole('alert').textContent).toContain('render blew up')
  })
})
