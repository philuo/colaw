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

  it('follows DocRoot in the all-in-one package form and reads the Suwell dialect', async () => {
    // 税局 Suwell 形态：无 container.xml，OFD.xml 即包描述，DocRoot 指向文档；
    // 页 BaseLoc 直接是 Content.xml 文件；尺寸在 Area/PhysicalBox；
    // 资源清单由 CommonData 文本子元素指向，MediaFile 文本即文件名。
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
    const declaration = '<?xml version="1.0" encoding="UTF-8"?>'
    const ofd = `${declaration}<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`
    const document = `${declaration}<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">`
      + '<ofd:CommonData><ofd:PublicRes>DocumentRes.xml</ofd:PublicRes>'
      + '<ofd:TemplatePage ID="1" BaseLoc="Tpls/Tpl_0/Content.xml"/></ofd:CommonData>'
      + '<ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages>'
      + '</ofd:Document>'
    const resources = `${declaration}<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res"><ofd:MultiMedias>`
      + '<ofd:MultiMedia ID="7" Type="Image"><ofd:MediaFile>stamp.png</ofd:MediaFile></ofd:MultiMedia>'
      + '</ofd:MultiMedias></ofd:Res>'
    const template = `${declaration}<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">`
      + '<ofd:Content><ofd:Layer>'
      + '<ofd:PathObject Boundary="0 0 148 210" LineWidth="0.3">'
      + '<ofd:StrokeColor Value="0 0 0"/><ofd:AbbreviatedData>M 0 0 L 148 0</ofd:AbbreviatedData>'
      + '</ofd:PathObject>'
      + '</ofd:Layer></ofd:Content></ofd:Page>'
    const content = `${declaration}<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">`
      + '<ofd:Area><ofd:PhysicalBox>0 0 148 210</ofd:PhysicalBox></ofd:Area>'
      + '<ofd:Template TemplateID="1" ZOrder="Background"/>'
      + '<ofd:Content><ofd:Layer>'
      + '<ofd:TextObject Boundary="10 10 60 10" Size="4"><ofd:TextCode Y="0">发票文本行</ofd:TextCode></ofd:TextObject>'
      + '<ofd:ImageObject Boundary="10 30 20 10" ResourceID="7"/>'
      + '</ofd:Layer></ofd:Content></ofd:Page>'
    const packageBytes = await zipOf([
      { name: 'OFD.xml', data: encode(ofd) },
      { name: 'Doc_0/Document.xml', data: encode(document) },
      { name: 'Doc_0/DocumentRes.xml', data: encode(resources) },
      { name: 'Doc_0/Tpls/Tpl_0/Content.xml', data: encode(template) },
      { name: 'Doc_0/Pages/Page_0/Content.xml', data: encode(content) },
      { name: 'Doc_0/Res/stamp.png', data: stampBytes() },
    ])
    const entries = await unzipEntries(packageBytes)
    expect(documentPathOf(entries)).toBe('Doc_0/Document.xml')
    expect((await readOfdPages(packageBytes))[0]?.lines).toEqual(['发票文本行'])
    const pages = await readOfdLayout(packageBytes)
    expect(pages[0]).toMatchObject({ widthMm: 148, heightMm: 210 })
    // Template layers render first (background); within a layer the reference
    // order is images, paths, then texts.
    expect(pages[0]!.fragments).toEqual([
      {
        kind: 'path',
        xMm: 0,
        yMm: 0,
        wMm: 148,
        hMm: 210,
        d: 'M0 0 L148 0',
        stroke: 'rgb(0, 0, 0)',
        lineWidthMm: 0.3,
      },
      { kind: 'image', xMm: 10, yMm: 30, wMm: 20, hMm: 10, url: expect.stringContaining('data:image/png;base64,') as unknown as string },
      {
        kind: 'text',
        xMm: 10,
        yMm: 10,
        wMm: 60,
        hMm: 10,
        sizeMm: 4,
        runs: [{ xMm: 0, yMm: 0, text: '发票文本行' }],
      },
    ])
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
  it('resolves the page box, baseline text runs, and image data URLs', async () => {
    const pages = await readOfdLayout(await ofdPackage())
    expect(pages).toHaveLength(1)
    const page = pages[0]!
    expect(page.widthMm).toBe(148)
    expect(page.heightMm).toBe(210)

    const texts = page.fragments.filter(fragment => fragment.kind === 'text')
    expect(texts).toEqual([
      {
        kind: 'text',
        xMm: 20,
        yMm: 20,
        wMm: 100,
        hMm: 30,
        sizeMm: 4,
        // TextCode@Y gives each line its own baseline within the object box.
        runs: [
          { xMm: 0, yMm: 0, text: '第一条 测试文本行' },
          { xMm: 10, yMm: 35, text: '第二条 另起一行' },
          { xMm: 0, yMm: 12, text: '第三条 收尾' },
        ],
      },
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
