/** Office metadata, keyed slots, and dictionary registration across the three formats. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'

vi.mock('../src/client/office/runtime.ts', () => ({
  openDocx: vi.fn(), openPptx: vi.fn(), openXlsx: vi.fn(),
}))
import { apply, OFFICE_BODY_IDS } from '../src/client/office/index.ts'
import { en, zh } from '../src/client/office/locales.ts'

describe('Office registration', () => {
  it('registers a builtin complete-bytes body per format and removes everything on dispose', async () => {
    const ctx = new Context()
    const previews = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const entries: Array<{ name: string; key: string; locale: string; component: unknown }> = []
    const register = vi.fn((options: typeof entries[number], component: unknown) => {
      entries.push({ ...options, component })
      return () => { entries.splice(entries.indexOf(options), 1) }
    })
    ctx.provide('documentPreviews', previews)
    ctx.provide('locale', {
      register: (name: string, value: unknown) => { dictionaries.set(name, value); return () => { dictionaries.delete(name) } },
      bind: () => makeTranslate(en),
    } as never)
    ctx.provide('slots', {
      inject: (_name: string, callback: () => () => void) => callback(), register,
    } as never)
    const fiber = ctx.plugin({ apply })
    try {
      await fiber.await()
      expect(previews.candidates('报告.DOCX')).toMatchObject([
        { id: OFFICE_BODY_IDS.docx, extensions: ['docx'], priority: 'builtin', loading: 'bytes-complete', wrap: false },
      ])
      expect(previews.candidates('deck.pptx')[0]!.id).toBe(OFFICE_BODY_IDS.pptx)
      expect(previews.candidates('book.xlsx').map(entry => entry.id)).toEqual([OFFICE_BODY_IDS.xlsx])
      // The macro-enabled workbook rides the xlsx renderer; legacy binaries do not match.
      expect(previews.candidates('book.xlsm')[0]!.id).toBe(OFFICE_BODY_IDS.xlsx)
      expect(previews.candidates('book.xls')).toEqual([])
      expect(previews.candidates('report.doc')[0]?.id).toBeUndefined()
      // Titles come from the shared dictionary.
      expect(previews.candidates('a.docx')[0]!.title()).toBe(en.docxTitle)
      expect(previews.candidates('a.pptx')[0]!.title()).toBe(en.pptxTitle)
      expect(previews.candidates('a.xlsx')[0]!.title()).toBe(en.xlsxTitle)
      expect(dictionaries.get('sidebarOffice')).toEqual({ zh, en })
      // One keyed body per format, all reading the same dictionary.
      expect(entries.map(entry => entry.key)).toEqual([OFFICE_BODY_IDS.docx, OFFICE_BODY_IDS.pptx, OFFICE_BODY_IDS.xlsx])
      expect(new Set(entries.map(entry => entry.component)).size).toBe(3)
      expect(entries.every(entry => entry.locale === 'sidebarOffice')).toBe(true)
      await fiber.dispose()
      expect(previews.getSnapshot()).toEqual([])
      expect(entries).toEqual([])
      expect(dictionaries.size).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })
})
