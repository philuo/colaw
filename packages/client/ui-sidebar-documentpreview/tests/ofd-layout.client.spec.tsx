// @vitest-environment jsdom
/** OFD reading: zip round-trip, container navigation, text extraction, and layout fragments. */
import { describe, expect, it } from 'vitest'
import { unzipEntries } from '../src/client/ofd/zip.ts'
import { decodeXmlBytes, documentPathOf, readOfdPages } from '../src/client/ofd/ofd-document.ts'
import { readOfdLayout } from '../src/client/ofd/ofd-layout.ts'
import { DEFLATE_METHOD, STORE_METHOD, ofdPackage, stampBytes, zipOf, type ZipFixtureEntry } from './ofd-fixture.ts'

describe('zip reader', () => {
  it('reads stored entries and locates the EOCD past an archive comment', async () => {
    const data = await zipOf([
      { name: 'a.txt', data: new TextEncoder().encode('plain') },
      { name: 'dir/b.bin', data: Uint8Array.of(0, 1, 2, 255) },
    ], 'archive comment')
    const entries = await unzipEntries(data)
    expect(new TextDecoder().decode(entries.get('a.txt'))).toBe('plain')
    expect([...entries.get('dir/b.bin')!]).toEqual([0, 1, 2, 255])
  })

  it.skipIf(typeof CompressionStream === 'undefined')('inflates deflate-raw entries', async () => {
    const data = await zipOf([
      { name: 'packed.xml', data: new TextEncoder().encode('<?xml version="1.0"?><a>packed</a>'), method: DEFLATE_METHOD },
      { name: 'raw.xml', data: new TextEncoder().encode('<b/>'), method: STORE_METHOD },
    ])
    const entries = await unzipEntries(data)
    expect(new TextDecoder().decode(entries.get('packed.xml'))).toContain('packed')
    expect(new TextDecoder().decode(entries.get('raw.xml'))).toBe('<b/>')
  })

  it('rejects an unknown compression method', async () => {
    const data = await zipOf([{ name: 'x', data: new Uint8Array(4), method: 99 }])
    await expect(unzipEntries(data)).rejects.toThrow(/unsupported zip method 99/)
  })
})

describe('container navigation', () => {
  it('follows DocPath to the nested document and falls back to OFD.xml', async () => {
    const package_ = await unzipEntries(await ofdPackage())
    expect(documentPathOf(package_)).toBe('Doc_0/Document.xml')
    const bare = await unzipEntries(await zipOf([
      { name: 'OFD.xml', data: new TextEncoder().encode('<?xml version="1.0"?><ofd:Document/>') },
    ] as readonly ZipFixtureEntry[]))
    expect(documentPathOf(bare)).toBe('OFD.xml')
  })
})

describe('text extraction', () => {
  it('collects per-page TextCode lines in document order', async () => {
    const pages = await readOfdPages(await ofdPackage())
    expect(pages).toEqual([{
      page: 1,
      lines: ['第一条 测试文本行', '第二条 另起一行', '第三条 收尾'],
    }])
  })
})

describe('layout skeleton', () => {
  it('resolves the page box, positioned text lines, and image data URLs', async () => {
    const pages = await readOfdLayout(await ofdPackage())
    expect(pages).toHaveLength(1)
    const page = pages[0]!
    expect(page.widthMm).toBe(148)
    expect(page.heightMm).toBe(210)

    const texts = page.fragments.filter(fragment => fragment.kind === 'text')
    expect(texts).toEqual([
      { kind: 'text', xMm: 20, yMm: 20, sizeMm: 4, text: '第一条 测试文本行' },
      // X/Y attributes win; the attribute-less line stacks at size * 1.5 per row.
      { kind: 'text', xMm: 30, yMm: 55, sizeMm: 4, text: '第二条 另起一行' },
      { kind: 'text', xMm: 20, yMm: 32, sizeMm: 4, text: '第三条 收尾' },
    ])

    const images = page.fragments.filter(fragment => fragment.kind === 'image')
    const expected = `data:image/png;base64,${btoa(String.fromCharCode(...stampBytes()))}`
    expect(images).toEqual([
      { kind: 'image', xMm: 20, yMm: 60, wMm: 40, hMm: 20, url: expected },
      // The missing resource keeps its placeholder position without a URL.
      { kind: 'image', xMm: 20, yMm: 90, wMm: 40, hMm: 20, url: undefined },
    ])
  })
})

describe('xml decoding', () => {
  it('decodes GBK-declared entries through the declaration probe', () => {
    const prefix = new TextEncoder().encode('<?xml version="1.0" encoding="gbk"?><TextCode>')
    const decoded = decodeXmlBytes(Uint8Array.of(...prefix, 0xD6, 0xD0, 0x3C, 0x2F, 0x54, 0x65, 0x78, 0x74, 0x43, 0x6F, 0x64, 0x65, 0x3E))
    expect(decoded).toContain('中')
  })
})
