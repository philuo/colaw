/** Office parser payloads decode to the exact bytes their runtime fetches as blob URLs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeOoxmlWasm, ooxmlWasmUrl } from '../src/client/office/assets.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('Office parser assets', () => {
  const assets = { docx: 'AQID', pptx: 'BAU=', xlsx: 'BgcI' }

  it('decodes the ambient build payload by format name', () => {
    vi.stubGlobal('__DSH_OOXML_WASM__', assets)
    expect(Array.from(decodeOoxmlWasm('docx'))).toEqual([1, 2, 3])
    expect(Array.from(decodeOoxmlWasm('pptx'))).toEqual([4, 5])
    expect(Array.from(decodeOoxmlWasm('xlsx'))).toEqual([6, 7, 8])
  })

  it('refuses a format the build did not inline', () => {
    vi.stubGlobal('__DSH_OOXML_WASM__', { docx: 'AQID' })
    expect(() => decodeOoxmlWasm('pptx')).toThrow('not bundled')
  })

  it('hands the parser to the viewer as one blob URL per format, cached', () => {
    vi.stubGlobal('__DSH_OOXML_WASM__', assets)
    const urls = ['blob:first', 'blob:second']
    let calls = 0
    const createObjectURL = vi.fn(() => urls[calls++]!)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL }))
    expect(ooxmlWasmUrl('docx')).toBe('blob:first')
    expect(ooxmlWasmUrl('docx')).toBe('blob:first')
    expect(ooxmlWasmUrl('pptx')).toBe('blob:second')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })
})
