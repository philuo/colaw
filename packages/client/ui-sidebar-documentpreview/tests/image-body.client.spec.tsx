// @vitest-environment jsdom
/** Image Blob ownership, media types, contain-fitted zoom rendering, and failure states. */
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

/** The pane the contain math divides by: concrete client boxes on the
 * viewport, plus the image's intrinsic size (object-fit paints the same
 * box the component computes, by aspect math). */
function adoptGeometry(
  view: ReturnType<typeof render>,
  pane: { width: number; height: number },
  natural: { width: number; height: number },
): HTMLElement {
  const frame = view.container.querySelector('[data-image-preview]')!.parentElement!
  const viewportEl = view.container.querySelector<HTMLElement>('[data-image-preview] > div')!
  setPaneSize(frame, pane)
  setPaneSize(viewportEl, pane)
  act(() => { resizeProbe?.() })
  const element = view.container.querySelector('img')!
  Object.defineProperty(element, 'naturalWidth', { configurable: true, value: natural.width })
  Object.defineProperty(element, 'naturalHeight', { configurable: true, value: natural.height })
  return viewportEl
}

/** Retarget an element's client box (a pane resize). */
function setPaneSize(element: HTMLElement, pane: { width: number; height: number }): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: pane.width })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: pane.height })
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

  it('rests contained and sharp: no transform, whole image, badge disabled', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    // 2000x1000 contained in a 400x300 pane displays 400x200 = 20% natural.
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // No transform at rest: the browser rasterizes at the laid-out size.
    expect(image.style.transform).toBe('')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe('true')
    expect(viewport.getAttribute('data-pannable')).toBe(null)
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('20%')
  })

  it('zooms toward the pointer on Ctrl+wheel and reports the natural-pixel scale', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // A notch of -100px scales by exp(100 * 0.004) ≈ 1.4918 over the fit.
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 75 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(1.4918')
    // cx = 100 - 200 = -100; tx = -100 - (-100 * 1.4918) ≈ 49.18. The
    // 200-tall contained height stays under the 300-tall pane, so ty = 0.
    expect(image.style.transform).toContain('translate(49.18')
    expect(image.style.transform).toContain(', 0px)')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe(null)
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('30%')
    // A plain wheel over a contained image is not a zoom or a pan.
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 100, clientY: 75 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(1.4918')
  })

  it('scales with the gesture magnitude and bounds one event\'s factor', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // A trackpad pinch emits rapid small deltas: -5px is a 1.0202 nudge.
    fireEvent.wheel(viewport, { deltaY: -5, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(1.0202')
    // One malformed huge delta is clamped to a single ×2 step.
    fireEvent.wheel(viewport, { deltaY: -100000, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(2')
  })

  it('keeps a tall image fully contained at rest — no stretch, no pan needed', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    // 400x2000 contains to 60x300 in a 400x300 pane: complete and
    // proportion-exact; the aspect never bends to the pane's shape.
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 400, height: 2000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toBe('')
    expect(viewport.getAttribute('data-pannable')).toBe(null)
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('15%')
    // A plain wheel cannot disturb the contained posture.
    fireEvent.wheel(viewport, { deltaY: 120, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toBe('')
  })

  it('re-contains proportionally when the pane resizes', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('20%')
    // Halving the pane's width re-contains to 200x100 — still 2:1. The
    // scheduler quantizes resamples, so the trailing settle (a short real
    // wait) lands the new shape.
    setPaneSize(viewport, { width: 200, height: 300 })
    await act(async () => {
      resizeProbe?.()
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(image.style.transform).toBe('')
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('10%')
  })

  it('clamps zoom at the fit floor and resets through the badge and double-click', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // Zooming out below the containment stays at the whole-image posture.
    fireEvent.wheel(viewport, { deltaY: 100, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toBe('')
    // Zoom in, then the badge returns to the contained posture.
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).not.toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toBe('')
    // A double-click toggles into a close-up at the point, and back out.
    fireEvent.dblClick(viewport, { clientX: 120, clientY: 90 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(2')
    fireEvent.dblClick(viewport, { clientX: 120, clientY: 90 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toBe('')
  })

  it('pans by drag while zoomed in and clamps at the scaled edges', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    // Zoom to the ×8 ceiling; anchored at the pane's center, so tx stays 0.
    for (let notch = 0; notch < 6; notch += 1) {
      fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
      await act(async () => { await Promise.resolve() })
    }
    expect(image.style.transform).toContain('scale(8')
    expect(viewport.getAttribute('data-pannable')).toBe('true')
    const grab = (dx: number, dy: number): void => {
      fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 200, clientY: 150 })
      fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 200 + dx, clientY: 150 + dy })
      fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200 + dx, clientY: 150 + dy })
    }
    grab(-60, 0)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('translate(-60px')
    // The image is 3200 wide in a 400-wide pane: 1400 of slack per direction.
    grab(-20000, 0)
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('translate(-1400px')
    // Vertically 1600 tall in 300: 650 of slack.
    grab(0, 20000)
    await act(async () => { await Promise.resolve() })
    const translation = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(image.style.transform)!
    expect(Number(translation[2])).toBeLessThanOrEqual(650)
  })

  it('keeps an explicit zoom across pane changes while containment owns the rest', async () => {
    const view = render(<ImageBody {...props()} />)
    const image = await screen.findByRole('img', { hidden: true })
    const viewport = adoptGeometry(view, { width: 400, height: 300 }, { width: 2000, height: 1000 })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    fireEvent.dblClick(viewport, { clientX: 200, clientY: 150 })
    await act(async () => { await Promise.resolve() })
    expect(image.style.transform).toContain('scale(2')
    // A pane resize re-clamps but never silently discards the operator's zoom;
    // the quantized resample settles after a short real wait.
    setPaneSize(viewport, { width: 700, height: 300 })
    await act(async () => {
      resizeProbe?.()
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(image.style.transform).toContain('scale(2')
    expect(viewport.getAttribute('data-zoom-at-fit')).toBe(null)
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
