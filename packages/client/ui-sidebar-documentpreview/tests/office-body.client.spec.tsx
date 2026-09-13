// @vitest-environment jsdom
/** Office body lifecycle: format dispatch, scroll viewer mount, pinch zoom, failure retry, dispose-on-replacement. */
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
vi.mock('../src/client/office/runtime.ts', async importOriginal => ({
  ...(await importOriginal<object>()),
  openDocx: engine.docx, openPptx: engine.pptx, openXlsx: engine.xlsx,
}))
import { OfficeBody, type OfficeFormatBodyProps } from '../src/client/office/OfficeBody.tsx'
import { OFFICE_ZOOM_MAX, OFFICE_ZOOM_MIN, type XlsxInteractions } from '../src/client/office/runtime.ts'
import { en } from '../src/client/office/locales.ts'

/** One scripted loader session, shared by every format's mocked opener. */
interface Loader {
  readonly deferred: ReturnType<typeof Promise.withResolvers<OfficeHandle>>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly hooks: {
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

/** A zoom seam double with its own scale, so gesture math is observable. */
function zoomDouble(scale = 1): {
  zoom: OfficeHandle['zoom']
  setScale: ReturnType<typeof vi.fn>
  getScale: ReturnType<typeof vi.fn>
} {
  let current = scale
  const setScale = vi.fn((next: number) => { current = next })
  const getScale = vi.fn(() => current)
  return { zoom: { getScale, setScale }, setScale, getScale }
}

/** The scroll-host double the paged handles carry: observable scroll writes. */
function scrollHostDouble(): HTMLElement & { scrollTop: number; scrollLeft: number } {
  return {
    scrollTop: 200,
    scrollLeft: 100,
    style: {} as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ top: 0, left: 0 } as DOMRect),
  } as unknown as HTMLElement & { scrollTop: number; scrollLeft: number }
}

const handleOf = (options: {
  zoom?: ReturnType<typeof zoomDouble>
  scrollHost?: HTMLElement
  xlsxExtra?: XlsxInteractions
} = {}): OfficeHandle => ({
  dispose: vi.fn(),
  zoom: options.zoom?.zoom ?? zoomDouble().zoom,
  ...(options.scrollHost === undefined ? {} : { scrollHost: options.scrollHost }),
  ...(options.xlsxExtra === undefined ? {} : { xlsx: options.xlsxExtra }),
})

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

  it('mounts the scroll viewer into the surface and renders no pagination chrome', async () => {
    const h = harness()
    const view = render(<h.View format="docx" />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    const surface = view.container.querySelector('[class*="surface"]') as HTMLElement
    // The container handed to the viewer is the surface div itself.
    expect(engine.docx.mock.calls[0]?.[0]).toBe(surface)
    await act(async () => { loads[0]!.deferred.resolve(handleOf()) })
    await act(async () => {})
    expect(screen.queryByRole('status')).toBeNull()
    // Continuous scroll, PDF-style: no page/slide buttons or indicator remain.
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous slide' })).toBeNull()
  })

  it('zooms on the pinch gesture with the image-preview curve and a cursor anchor', async () => {
    const h = harness()
    const view = render(<h.View format="docx" />)
    const zoom = zoomDouble(1)
    const host = scrollHostDouble()
    await act(async () => { loads[0]!.deferred.resolve(handleOf({ zoom, scrollHost: host })) })
    await act(async () => {})

    // One pinch notch: exp(12*0.007) ≈ 1.088 — smooth, not the library's 1.1 jump.
    const surface = view.container.querySelector('[class*="surface"]') as HTMLElement
    fireEvent(surface, new WheelEvent('wheel', { ctrlKey: true, deltaY: -12, clientX: 60, clientY: 40, cancelable: true }))
    const expected = Math.min(OFFICE_ZOOM_MAX, Math.max(OFFICE_ZOOM_MIN, Math.exp(12 * 0.007)))
    // The gesture previews on a transform and commits the real scale on settle.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(zoom.setScale).toHaveBeenCalledWith(expected)
    // Cursor-anchored scroll correction: content point scales around the anchor.
    expect(host.scrollTop).toBeCloseTo((200 + 40) * expected - 40, 5)
    expect(host.scrollLeft).toBeCloseTo((100 + 60) * expected - 60, 5)

    // Plain wheel is untouched: no zoom, native scrolling.
    zoom.setScale.mockClear()
    fireEvent(surface, new WheelEvent('wheel', { deltaY: -50, cancelable: true }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(zoom.setScale).not.toHaveBeenCalled()
  })

  it('clamps the zoom bounds on both ends', async () => {
    const h = harness()
    render(<h.View format="docx" />)
    const zoom = zoomDouble(7.9)
    await act(async () => { loads[0]!.deferred.resolve(handleOf({ zoom })) })
    await act(async () => {})
    const surface = document.querySelector('[class*="surface"]') as HTMLElement
    fireEvent(surface, new WheelEvent('wheel', { ctrlKey: true, deltaY: -40, cancelable: true }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(zoom.setScale).toHaveBeenLastCalledWith(OFFICE_ZOOM_MAX)
  })

  it('renders no pagination chrome for Excel, and leaves the wheel to its own viewer', async () => {
    const h = harness()
    const view = render(<h.View format="xlsx" />)
    const zoom = zoomDouble(1)
    await act(async () => { loads[0]!.deferred.resolve(handleOf({ zoom })) })
    await act(async () => {})
    expect(view.container.querySelector('[data-office-preview="xlsx"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
    // The grid keeps the library's built-in ⌘/Ctrl+wheel zoom (anchored to the
    // grid), so the body's capture gesture must not intercept: the wheel is
    // neither prevented nor forwarded to the body's zoom seam.
    const surface = view.container.querySelector('[class*="surface"]') as HTMLElement
    const wheel = new WheelEvent('wheel', { metaKey: true, deltaY: -20, clientX: 10, clientY: 10, cancelable: true })
    fireEvent(surface, wheel)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(wheel.defaultPrevented).toBe(false)
    expect(zoom.setScale).not.toHaveBeenCalled()
  })

  it('replaces the session and disposes the previous viewer when the data changes', async () => {
    const h = harness()
    const mounted = render(<h.View format="pptx" data="old" />)
    const first = handleOf()
    await act(async () => { loads[0]!.deferred.resolve(first) })
    await act(async () => {})
    mounted.rerender(<h.View format="pptx" data="new" />)
    // The stale viewer is disposed through the effect cleanup, and a new load starts.
    await act(async () => {})
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(engine.pptx).toHaveBeenCalledTimes(2)
    expect(loads[1]!.dispose).not.toHaveBeenCalled()
    const second = handleOf()
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

  it('reads one merged cell as one on click, keyboard, and copy (Excel)', async () => {
    const h = harness()
    const view = render(<h.View format="xlsx" />)
    const expand = vi.fn(async () => true)
    const copy = vi.fn(async () => 'copied' as const)
    let selectionListener: (() => void) | undefined
    const xlsx: XlsxInteractions = {
      expandMergedSelection: expand,
      copySelection: copy,
      onSelectionChange: (listener) => { selectionListener = listener },
    }
    await act(async () => { loads[0]!.deferred.resolve(handleOf({ xlsxExtra: xlsx })) })
    await act(async () => {})
    const surface = view.container.querySelector('[class*="surface"]') as HTMLElement

    // Hover draws nothing of its own: the viewer renders no hover highlight,
    // and the pane must not overlay one either.
    fireEvent.pointerMove(surface, { clientX: 40, clientY: 30 })
    expect(surface.querySelector('[class*="mergeHover"]')).toBeNull()

    // Mid-press the viewer is dragging its own selection: no rewrite.
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 30 })
    selectionListener?.()
    expect(expand).not.toHaveBeenCalled()

    // After release, a committed lone-cell selection widens to the merge.
    fireEvent.pointerUp(surface)
    selectionListener?.()
    expect(expand).toHaveBeenCalledOnce()

    // ⌘C copies through the viewer's clipboard path.
    const keyEvent = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
    surface.dispatchEvent(keyEvent)
    expect(keyEvent.defaultPrevented).toBe(true)
    expect(copy).toHaveBeenCalledOnce()
  })

  it('routes a post-load viewer failure to the same failure line', async () => {
    const h = harness()
    render(<h.View format="docx" />)
    await act(async () => { loads[0]!.deferred.resolve(handleOf()) })
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { loads[0]!.hooks.onError(new Error('render blew up')) })
    expect(screen.getByRole('alert').textContent).toContain('render blew up')
  })
})
