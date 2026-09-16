// @vitest-environment jsdom
/** EPUB metadata, keyed slot, and dictionary registration. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply, EPUB_BODY_ID } from '../src/client/epub/index.ts'
import { en, zh } from '../src/client/epub/locales.ts'

describe('EPUB registration', () => {
  it('registers a builtin complete-bytes body and removes everything on dispose', async () => {
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
      expect(previews.candidates('book.EPUB').map(entry => entry.id)).toEqual([EPUB_BODY_ID])
      expect(previews.candidates('book.epub')[0]).toMatchObject({
        extensions: ['epub'], priority: 'builtin', loading: 'bytes-complete', wrap: false,
      })
      expect(previews.candidates('book.mobi')).toEqual([])
      expect(previews.candidates('book.epub')[0]!.title()).toBe(en.title)
      expect(dictionaries.get('sidebarEpub')).toEqual({ zh, en })
      expect(entries.map(entry => entry.key)).toEqual([EPUB_BODY_ID])
      expect(entries.every(entry => entry.locale === 'sidebarEpub')).toBe(true)
    } finally {
      await fiber.dispose()
    }
    expect(previews.getSnapshot()).toEqual([])
    expect(entries).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
