/** PDF binary resources are same-origin static assets fetched per request, with independently owned buffers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPdfBinaryDataFactory } from '../src/client/pdf/assets.ts'

beforeEach(() => { vi.stubGlobal('location', new URL('http://localhost:3000/')) })
afterEach(() => { vi.unstubAllGlobals() })

function stubFetch(payload: Uint8Array) {
  const fetch = vi.fn(async () => new Response(payload as unknown as BodyInit, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('PDF binary assets', () => {
  it('fetches each kind from its assets/pdfjs directory at the site root', async () => {
    const fetch = stubFetch(new Uint8Array([1, 2, 3]))
    const factory = new (createPdfBinaryDataFactory())()
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' }))).toEqual([1, 2, 3])
    const requested = new URL((fetch.mock.calls[0] as unknown[])[0] as string)
    expect(requested.origin + requested.pathname).toBe('http://localhost:3000/assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap')

    await factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSans.pfb' })
    expect(new URL((fetch.mock.calls[1] as unknown[])[0] as string).pathname).toBe('/assets/pdfjs/standard_fonts/FoxitSans.pfb')
    await factory.fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' })
    expect(new URL((fetch.mock.calls[2] as unknown[])[0] as string).pathname).toBe('/assets/pdfjs/wasm/openjpeg.wasm')
  })

  it('anchors the request absolutely so a worker hand-off cannot re-resolve it', async () => {
    const fetch = stubFetch(new Uint8Array())
    const factory = new (createPdfBinaryDataFactory())()
    await factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' })
    const requested = String((fetch.mock.calls[0] as unknown[])[0])
    expect(requested.startsWith('http://')).toBe(true)
    expect(requested).not.toContain('./')
  })

  it('never shares a buffer that PDF.js may transfer away', async () => {
    stubFetch(new Uint8Array([1, 2, 3]))
    const factory = new (createPdfBinaryDataFactory())()
    const first = await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    structuredClone(first, { transfer: [first.buffer] })
    expect(first.byteLength).toBe(0)
    const second = await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    expect(Array.from(second)).toEqual([1, 2, 3])
  })

  it('surfaces an unserved resource as an error naming the kind and file', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const factory = new (createPdfBinaryDataFactory())()
    await expect(factory.fetch({ kind: 'cMapUrl', filename: 'missing.bcmap' })).rejects.toThrow('not served')
  })
})
