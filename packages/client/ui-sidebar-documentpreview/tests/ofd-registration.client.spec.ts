/** OFD metadata, keyed slots, and dictionary registration for the two bodies. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply, OFD_HIFI_BODY_ID } from '../src/client/ofd/index.ts'
import { en, zh } from '../src/client/ofd/locales.ts'

describe('OFD registration', () => {
  it('registers both bodies over .ofd and removes everything on dispose', async () => {
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
      // Both implementations claim .ofd; structured text leads, layout follows.
      expect(previews.candidates('document.OFD').map(entry => entry.id)).toEqual([OFD_HIFI_BODY_ID])
      expect(previews.candidates('document.ofd')[0]).toMatchObject({
        extensions: ['ofd'], priority: 'builtin', loading: 'bytes-complete', wrap: false,
      })
      expect(previews.candidates('document.pdf')).toEqual([])
      // Titles come from the shared dictionary.
      expect(previews.candidates('a.ofd')[0]!.title()).toBe(en.title)
      expect(dictionaries.get('sidebarOfd')).toEqual({ zh, en })
      // One keyed body per implementation, both reading the same dictionary.
      expect(entries.map(entry => entry.key)).toEqual([OFD_HIFI_BODY_ID])
      expect(new Set(entries.map(entry => entry.component)).size).toBe(1)
      expect(entries.every(entry => entry.locale === 'sidebarOfd')).toBe(true)
    } finally {
      await fiber.dispose()
    }
    expect(previews.getSnapshot()).toEqual([])
    expect(entries).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
