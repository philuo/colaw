// @vitest-environment jsdom
/** PDF controls and stale-completion guards with real tab view state and controlled document loads. */
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { PdfDocument } from '../src/client/pdf/document.ts'
import type { renderPdfPage, renderPdfTextLayer } from '../src/client/pdf/document.ts'
import type { openPdf } from '../src/client/pdf/runtime.ts'

const engine = vi.hoisted(() => ({
  open: vi.fn<typeof openPdf>(),
  render: vi.fn<typeof renderPdfPage>(),
  textLayer: vi.fn<typeof renderPdfTextLayer>(),
}))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: engine.open }))
vi.mock('../src/client/pdf/document.ts', () => ({ renderPdfPage: engine.render, renderPdfTextLayer: engine.textLayer }))
import { PdfBody, type PdfBodyProps } from '../src/client/pdf/PdfBody.tsx'
import { createPdfStore, type PdfState } from '../src/client/pdf/store.ts'
import { en } from '../src/client/pdf/locales.ts'
import { PdfWorkerFailure } from '../src/client/pdf/errors.ts'

const loads: Array<{
  deferred: ReturnType<typeof Promise.withResolvers<PdfDocument>>
  dispose: ReturnType<typeof vi.fn>
}> = []

/** jsdom ships no ResizeObserver: the stub records the observed node, so a case
 * can prove the gutter measurement is wired to the rendered section. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  readonly observed = new Set<Element>()
  disconnected = false

  constructor() { ResizeObserverStub.instances.push(this) }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void { this.disconnected = true; this.observed.clear() }
}

beforeEach(() => {
  loads.length = 0
  ResizeObserverStub.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  engine.open.mockReset().mockImplementation(() => {
    const deferred = Promise.withResolvers<PdfDocument>()
    const dispose = vi.fn(async () => {})
    loads.push({ deferred, dispose })
    return { document: deferred.promise, dispose }
  })
  engine.render.mockReset().mockResolvedValue({ width: 100, height: 100 })
  engine.textLayer.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  // A lingering selection would leak into the next case's copy assertion.
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
})

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void { this.disconnected = true; this.observed.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  intersect(element: Element, isIntersecting: boolean): void {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

function harness() {
  const instance = createPdfStore().create()
  const controller = new AbortController()
  const tabId = 'pdf-tab' as TabId
  const subscribe = (listener: () => void) => instance.subscribe(listener)
  const snapshot = () => instance.getSnapshot()
  function useStore<T>(selector: (state: PdfState) => T): T {
    return selector(useSyncExternalStore(subscribe, snapshot))
  }
  function View({ data = 'one', kind = 'bytes' }: { readonly data?: string; readonly kind?: 'bytes' | 'text' }) {
    const bytes = useMemo(() => new TextEncoder().encode(data), [data])
    // The PDF body reads these standard seats; the remaining framework seats are unused here.
    const props = {
      resourceAddress: 'dsh-resource://file/session/s/report.pdf',
      content: kind === 'bytes' ? { kind, data: bytes } : { kind, text: '', pages: [], eof: true }, wrap: false,
      useTabInfo: () => ({ tab: { id: tabId, signal: controller.signal } }),
      useStore, actions: instance.actions, retainTab: vi.fn(), t: makeTranslate(en),
    } as unknown as PdfBodyProps
    return <PdfBody {...props} />
  }
  return { instance, controller, tabId, View }
}

const documentOf = (numPages = 3): PdfDocument => ({ numPages, getPage: vi.fn() })

describe('PDF body', () => {
  it('reports non-byte contents without starting PDF.js', () => {
    const h = harness()
    render(<h.View kind="text" />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(engine.open).not.toHaveBeenCalled()
  })

  it('does not start a load for a tab record that has already ended', () => {
    const h = harness()
    h.controller.abort()
    render(<h.View />)
    expect(engine.open).not.toHaveBeenCalled()
  })

  it('shows loading, omits the paging toolbar, and renders a continuous page sequence', async () => {
    const h = harness()
    const view = render(<h.View />)
    expect(screen.getByRole('status').textContent).toBe('Opening PDF…')
    expect(screen.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    await act(async () => { loads[0]!.deferred.resolve(documentOf()) })
    await act(async () => {})
    expect(view.container.querySelector('[role="toolbar"]')).toBeNull()
    expect([...view.container.querySelectorAll('[data-pdf-page]')].map(page => page.getAttribute('data-pdf-page')))
      .toEqual(['1', '2', '3'])
    expect(screen.getAllByRole('img').map(image => image.getAttribute('aria-label')))
      .toEqual(['PDF page 1', 'PDF page 2', 'PDF page 3'])
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2, 3])
  })

  it('keeps the replacement document when the previous load settles late', async () => {
    const h = harness()
    const mounted = render(<h.View data="old" />)
    mounted.rerender(<h.View data="new" />)
    expect(loads[0]!.dispose).toHaveBeenCalledOnce()
    const latest = documentOf(2)
    await act(async () => { loads[1]!.deferred.resolve(latest) })
    await act(async () => { loads[0]!.deferred.resolve(documentOf(99)) })
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(engine.render.mock.calls.every(([document]) => document === latest)).toBe(true)
  })

  it('shows localized load errors and retries without replacing the file resource', async () => {
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.reject(new Error('invalid PDF')) })
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: invalid PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { loads[1]!.deferred.resolve(documentOf(1)) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
    expect(engine.open.mock.calls.map(([data]) => new TextDecoder().decode(data))).toEqual(['one', 'one'])
  })

  it('reports password protection in the renderer locale', async () => {
    const h = harness()
    render(<h.View />)
    const password = new Error('encrypted')
    password.name = 'PasswordException'
    await act(async () => { loads[0]!.deferred.reject(password) })
    expect(screen.getByRole('alert').textContent).toContain(en.password)
  })

  it('renders later pages only when they approach the viewport and records the reached page', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(3)) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1])
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    const observer = IntersectionObserverStub.instances.find(instance => instance.observed.has(second))!
    act(() => { observer.intersect(second, false) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1])
    await act(async () => { observer.intersect(second, true) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2])
    expect(h.instance.getSnapshot().byTab[h.tabId]?.page).toBe(2)
    expect(screen.getByRole('img', { name: 'PDF page 2' })).toBeTruthy()
    view.unmount()
    expect(IntersectionObserverStub.instances.every(instance => instance.disconnected)).toBe(true)
  })

  it('ignores successful and failed page renders after their body unmounts', async () => {
    const success = Promise.withResolvers<{ width: number; height: number }>()
    const failure = Promise.withResolvers<{ width: number; height: number }>()
    engine.render.mockReturnValueOnce(success.promise).mockReturnValueOnce(failure.promise)
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(2)) })
    const signals = engine.render.mock.calls.map(([, , , signal]) => signal)
    expect(signals).toHaveLength(2)
    view.unmount()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await act(async () => {
      success.resolve({ width: 100, height: 100 })
      failure.reject(new Error('late render failure'))
      await Promise.allSettled([success.promise, failure.promise])
    })
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders a structured Worker failure through its own locale', async () => {
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf()) })
    act(() => { engine.open.mock.calls[0]![2](new PdfWorkerFailure(new MessageEvent('messageerror'))) })
    expect(screen.getByRole('alert').textContent).toContain(en.workerFailed)
    expect(screen.getByRole('alert').textContent).not.toContain('message could not be decoded')
  })

  it('ignores a previous document rejection and failure callback after its content is replaced', async () => {
    const h = harness()
    const mounted = render(<h.View data="old" />)
    mounted.rerender(<h.View data="new" />)
    await act(async () => { loads[1]!.deferred.resolve(documentOf(2)) })
    await act(async () => {
      loads[0]!.deferred.reject(new Error('late parsing error'))
      engine.open.mock.calls[0]![2](new PdfWorkerFailure(new ErrorEvent('error')))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('shows a foreign render rejection and retries that page', async () => {
    engine.render.mockRejectedValueOnce('foreign rendering failure')
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: foreign rendering failure')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
  })

  it('binds the zoom gutter and the pane observer to the section the moment the pages render', async () => {
    const h = harness()
    const view = render(<h.View />)
    // Behind the loader there is no section yet, so there is nothing to bind.
    expect(view.container.querySelector('[data-pdf-preview]')).toBeNull()
    expect(ResizeObserverStub.instances).toHaveLength(0)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const section = view.container.querySelector<HTMLElement>('[data-pdf-preview]')!
    expect(section.style.getPropertyValue('--pdf-zoom')).toBe('1')
    // jsdom reports no layout, so the measured gutter floors at 1px; what
    // matters is that the section was measured at all.
    expect(section.style.getPropertyValue('--pdf-pane-width')).toBe('1px')
    expect(ResizeObserverStub.instances.some(instance => instance.observed.has(section))).toBe(true)
    // The fit ratio the text layer's font size multiplies by: pane width over
    // page width, on the page box that owns the layer. jsdom reports no layout,
    // so the pane floors at 1px against the 100px page the renderer reported.
    expect(view.container.querySelector('canvas')!.parentElement!.style.getPropertyValue('--pdf-fit')).toBe('0.01')
  })

  it('zooms the pages on a ctrl/⌘ wheel and leaves a plain wheel to the scrollport', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const section = view.container.querySelector<HTMLElement>('[data-pdf-preview]')!
    fireEvent.wheel(section, { ctrlKey: true, deltaY: -100, clientX: 10, clientY: 20 })
    // The gesture frame writes the variable straight to the section, so the
    // reader sees the zoom before React hears about it.
    await settleFrame()
    expect(section.style.getPropertyValue('--pdf-zoom')).toBe('2')
    expect(h.instance.getSnapshot().byTab[h.tabId]).toBeUndefined()
    // The store only catches up once the gesture has stopped.
    await settleGesture()
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBe(2)
    fireEvent.wheel(section, { deltaY: -100, clientX: 10, clientY: 20 })
    await settleGesture()
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBe(2)
  })

  it('keeps the drawn canvas in place through a crisp re-render, so the text layer survives', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const section = view.container.querySelector<HTMLElement>('[data-pdf-preview]')!
    const canvas = section.querySelector('canvas')!
    expect(canvas.hasAttribute('hidden')).toBe(false)
    // The page's own geometry lands on the canvas that displays it — that is
    // what the fit math and the text layer's scale both read.
    expect(canvas.style.getPropertyValue('--pdf-page-width')).toBe('100px')
    expect(engine.render).toHaveBeenCalledTimes(1)
    // Zooming in needs more pixels, so the page re-renders…
    fireEvent.wheel(section, { ctrlKey: true, deltaY: -100 })
    await settleGesture()
    expect(engine.render).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).toBeNull()
    expect(canvas.hasAttribute('hidden')).toBe(false)
    expect(canvas.style.getPropertyValue('--pdf-page-width')).toBe('100px')
    // …while zooming back out does not: the bitmap already on screen is bigger
    // than the new size needs, and hiding it is what used to break selection.
    fireEvent.wheel(section, { ctrlKey: true, deltaY: 100 })
    await settleGesture()
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBe(1)
    expect(engine.render).toHaveBeenCalledTimes(2)
    expect(canvas.hasAttribute('hidden')).toBe(false)
  })

  it('zooms the pages from a WebKit pinch, which is what this shell reports instead of a ctrl+wheel', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const section = view.container.querySelector<HTMLElement>('[data-pdf-preview]')!
    await act(async () => { section.dispatchEvent(new Event('gesturestart', { bubbles: true, cancelable: true })) })
    const pinch = new Event('gesturechange', { bubbles: true, cancelable: true })
    Object.defineProperty(pinch, 'scale', { value: 1.5 })
    await act(async () => { section.dispatchEvent(pinch) })
    await settleFrame()
    expect(section.style.getPropertyValue('--pdf-zoom')).toBe('1.5')
    await settleGesture()
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBe(1.5)
  })

  it('copies the selection as plain text, without the layer’s typography', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const section = view.container.querySelector<HTMLElement>('[data-pdf-preview]')!
    const layer = view.container.querySelector<HTMLElement>('[data-pdf-text-layer]')!
    // pdfjs fills this layer itself; one span stands in for its output.
    const span = document.createElement('span')
    span.textContent = 'Selectable PDF text'
    layer.append(span)
    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const clipboard = { setData: vi.fn() }
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', { value: clipboard })
    await act(async () => { section.dispatchEvent(copy) })
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', 'Selectable PDF text')
    expect(copy.defaultPrevented).toBe(true)
  })
})

/** Let the gesture's coalesced animation frame run. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
  })
}

/** Past the gesture's idle window, where the store write and its render land. */
async function settleGesture(): Promise<void> {
  await settleFrame()
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 220) })
  })
}
