// @vitest-environment jsdom
/** Image Blob ownership, media types, fitted zoom rendering, and failure states. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImageBody, imageMediaType, type ImageBodyProps } from '../src/client/image/ImageBody.tsx'
import { en } from '../src/client/image/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

/** jsdom ships no ResizeObserver; the stub records the probe so a case can
 * replay a resize after adopting concrete geometry (mirroring a real pane
 * change, which re-measures through the same callback). */
let resizeProbe: (() => void) | undefined
class ResizeObserverStub {
  constructor(callback: () => void) { resizeProbe = callback }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  resizeProbe = undefined
})

afterEach(() => {
  try { cleanup() } finally {
    vi.unstubAllGlobals()
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

/** Translation with generic {placeholder} substitution, like the real seat. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = translations.get(key) ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) return `{${name}}`
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    return JSON.stringify(value)
  })
}

function props(path = 'asset.png', data: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])): ImageBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/image/${path}`,
    content: { kind: 'bytes', data },
    wrap: false,
    sessionId: 'image' as SessionId,
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: translate,
  } as ImageBodyProps
}

/** jsdom reports zero geometry; give the viewport and image concrete boxes. */
function adoptGeometry(
  view: ReturnType<typeof render>,
  viewport: { width: number; height: number },
  image: { width: number; height: number },
): HTMLElement {
  const frame = view.container.querySelector('[data-image-preview]')!.parentElement!
  const viewportEl = view.container.querySelector<HTMLElement>('[data-image-preview] > div')!
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: viewport.width })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: viewport.height })
  Object.defineProperty(viewportEl, 'clientWidth', { configurable: true, value: viewport.width })
  Object.defineProperty(viewportEl, 'clientHeight', { configurable: true, value: viewport.height })
  act(() => { resizeProbe?.() })
  const element = view.container.querySelector<HTMLImageElement>('img')!
  Object.defineProperty(element, 'naturalWidth', { configurable: true, value: image.width })
  Object.defineProperty(element, 'naturalHeight', { configurable: true, value: image.height })
  const box = (): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: viewport.width, bottom: viewport.height,
    width: viewport.width, height: viewport.height, toJSON: () => ({}),
  })
  element.getBoundingClientRect = box
  viewportEl.getBoundingClientRect = box
  return viewportEl
}

describe('ImageBody', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
    ['svg', 'image/svg+xml'],
  ] as const)('assigns .%s bytes the %s Blob media type', async (extension, mediaType) => {
    const view = render(<ImageBody {...props(`asset.${extension}`)} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    expect(image.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('keeps the image non-draggable, then shows it after decoding succeeds', async () => {
    render(<ImageBody {...props('photo.svg')} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(image.getAttribute('alt')).toBe('Image preview: photo.svg')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.getAttribute('draggable')).toBe('false')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.hasAttribute('hidden')).toBe(true)
    fireEvent.load(image)
    expect(image.hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('fits a larger image centered on both axes at its contain scale', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // Contain fit: min(400/2000, 300/1000) = 0.2; centered means zero translation.
    expect(image.style.transform).toContain('scale(0.2)')
    expect(image.style.transform).toContain('translate(0px, 0px)')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe('true')
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('20%')
  })

  it('never upscales a smaller image past its natural pixels', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    adoptGeometry(view, { width: 800, height: 600 }, { width: 200, height: 100 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(1)')
  })

  it('zooms toward the pointer on Ctrl+wheel and reports the natural-pixel scale', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // Fit is min(400/400, 300/2000) = 0.15; a notch of -100px scales by
    // exp(100 * 0.0025) ≈ 1.284, so one notch lands at ≈ 0.1926.
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 75 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.1926')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe(null)
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('19%')
    // Plain wheel without the pinch modifier stays a scroll, not a zoom.
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 100, clientY: 75 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.1926')
  })

  it('scales with the gesture magnitude and bounds one event\'s factor', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // A trackpad pinch emits rapid small deltas: -5px is a 1.01258 nudge,
    // keeping the composed gesture smooth instead of a per-event jump.
    fireEvent.wheel(viewport, { deltaY: -5, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.1518')
    // One malformed huge delta is clamped to a single ×2 step.
    fireEvent.wheel(viewport, { deltaY: -100000, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.3037')
  })

  it('caps the fitted pane at the visible window region', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    // A restored tab can mount with the frame grown past the window (jsdom's
    // window is 1024x768): a box at top 400 and 2000 tall has only 368px
    // visible, and the fit must divide by that, not by 2000.
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 2000 })
    viewport.getBoundingClientRect = () => ({
      x: 0, y: 400, top: 400, left: 0, right: 400, bottom: 2400,
      width: 400, height: 2000, toJSON: () => ({}),
    })
    fireEvent.load(image)
    await act(async () => { resizeProbe?.() })
    // Fit is min(400/400, 368/2000) = 0.184 — the whole image stays visible.
    expect(image.style.transform).toContain('scale(0.184')
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('18%')
  })

  it('re-fits when the measured pane corrects, until the operator zooms', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.15')
    // The settle probes deliver the corrected pane: the un-zoomed posture
    // re-seats at the new whole-image fit on its own.
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 })
    viewport.getBoundingClientRect = () => ({
      x: 0, y: 200, top: 200, left: 0, right: 400, bottom: 700,
      width: 400, height: 500, toJSON: () => ({}),
    })
    await act(async () => { resizeProbe?.() })
    expect(image.style.transform).toContain('scale(0.25')
    // Once the operator zooms, their scale survives later pane corrections.
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.4121')
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 700 })
    viewport.getBoundingClientRect = () => ({
      x: 0, y: 100, top: 100, left: 0, right: 400, bottom: 800,
      width: 400, height: 700, toJSON: () => ({}),
    })
    await act(async () => { resizeProbe?.() })
    expect(image.style.transform).toContain('scale(0.4121')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe(null)
  })

  it('clamps zoom at both ends and resets through the badge and double-click', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // Zooming out below the fit stays at the fit.
    fireEvent.wheel(viewport, { deltaY: 100, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.15')
    // Zoom in, then the badge returns to the fitted posture.
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).not.toContain('scale(0.15')
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.15')
    expect(image.style.transform).toContain('translate(0px, 0px)')
    // A double-click toggles into a close-up at the point, and back out.
    fireEvent.dblClick(viewport, { clientX: 120, clientY: 90 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.3')
    fireEvent.dblClick(viewport, { clientX: 120, clientY: 90 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(0.15')
    expect(image.style.transform).toContain('translate(0px, 0px)')
  })

  it('pans by drag while zoomed in and clamps at the scaled edges', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    for (let notch = 0; notch < 20; notch += 1) {
      fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
      await act(async () => { await Promise.resolve() })
    }
    expect(image.style.transform).toContain('scale(8')
    const grab = (dx: number, dy: number): void => {
      fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 200, clientY: 150 })
      fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 200 + dx, clientY: 150 + dy })
      fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200 + dx, clientY: 150 + dy })
    }
    grab(-60, 0)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('translate(-60px')
    // Dragging past the scaled edge clamps: the image is 3200 wide in a
    // 400-wide pane, so the horizontal slack is 1400 per direction.
    grab(-20000, 0)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('translate(-1400px')
    grab(0, 20000)
    await act(async () => { await Promise.resolve() })
    const translation = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(image.style.transform)!
    expect(Number(translation[2])).toBeLessThanOrEqual(7900)
  })

  it('revokes replaced bytes and reports image decode and Blob creation failures', async () => {
    const initial = props()
    const view = render(<ImageBody {...initial} />)
    const first = await screen.findByRole('img', { hidden: true })
    fireEvent.error(first)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    const changed = props('asset.png', new Uint8Array([4, 5, 6]))
    view.rerender(<ImageBody {...changed} />)
    await screen.findByRole('img', { hidden: true })
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    create.mockImplementationOnce(() => { throw new Error('Blob unavailable') })
    view.rerender(<ImageBody {...props('changed.png', new Uint8Array([7]))} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/2')
  })

  it('rejects text delivery and an unregistered suffix without creating a Blob', () => {
    const initial = props()
    const view = render(<ImageBody {...initial} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<ImageBody {...props('asset.unknown')} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(imageMediaType('folder/PHOTO.JPEG')).toBe('image/jpeg')
    expect(imageMediaType('folder/no-extension')).toBeUndefined()
    expect(imageMediaType('folder/photo.avif')).toBeUndefined()
  })
})
