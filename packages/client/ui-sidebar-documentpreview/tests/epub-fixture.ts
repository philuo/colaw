/** EPUB fixtures: a minimal but valid EPUB 3 package for the foliate reader. */
import { zipOf, type ZipFixtureEntry } from './ofd-fixture.ts'

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

/**
 * A one-chapter EPUB 3: container → OPF (title 测试电子书) → nav with one
 * TOC entry 第一章 → one XHTML chapter.
 * @returns zip bytes of the package.
 */
export async function epubPackage(): Promise<Uint8Array> {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  const container = `${XML_DECLARATION}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const opf = `${XML_DECLARATION}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">`
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:identifier id="pub-id">urn:uuid:colaw-epub-fixture</dc:identifier>'
    + '<dc:title>测试电子书</dc:title>'
    + '<dc:language>zh</dc:language>'
    + '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>'
    + '</metadata>'
    + '<manifest>'
    + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    + '<item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>'
    + '</manifest>'
    + '<spine><itemref idref="chapter1"/></spine>'
    + '</package>'
  const nav = `${XML_DECLARATION}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">`
    + '<head><title>nav</title></head><body>'
    + '<nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章</a></li></ol></nav>'
    + '</body></html>'
  const chapter = `${XML_DECLARATION}<html xmlns="http://www.w3.org/1999/xhtml">`
    + '<head><title>第一章</title></head><body><p>你好，EPUB。</p></body></html>'
  return zipOf([
    { name: 'mimetype', data: encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encode(container) },
    { name: 'OEBPS/content.opf', data: encode(opf) },
    { name: 'OEBPS/nav.xhtml', data: encode(nav) },
    { name: 'OEBPS/chapter1.xhtml', data: encode(chapter) },
  ] satisfies readonly ZipFixtureEntry[])
}
