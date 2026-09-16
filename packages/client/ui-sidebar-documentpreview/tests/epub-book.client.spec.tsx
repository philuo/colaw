// @vitest-environment jsdom
/** EPUB opening through the vendored foliate parser: metadata, spine, TOC, and section load. */
import { describe, expect, it } from 'vitest'
import { openEpubBook } from '../src/client/epub/epub-book.ts'
import { epubPackage } from './epub-fixture.ts'

describe('openEpubBook', () => {
  it('parses the fixture book: metadata, one spine section, and the nav TOC', async () => {
    const book = await openEpubBook(await epubPackage())
    expect(book.metadata.title).toBe('测试电子书')
    expect(book.sections).toHaveLength(1)
    expect(book.toc.map(item => item.label.trim())).toEqual(['第一章'])
  })

  it('loads a spine section as an XHTML document', async () => {
    const book = await openEpubBook(await epubPackage())
    const chapter = await book.sections[0]!.createDocument()
    expect(chapter.getElementsByTagName('p')[0]?.textContent).toContain('你好，EPUB。')
    book.sections[0]!.unload()
  })

  it('rejects a non-EPUB payload instead of returning a partial book', async () => {
    await expect(openEpubBook(new TextEncoder().encode('not a zip'))).rejects.toThrow()
  })
})
