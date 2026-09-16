/** Builtin EPUB registration: one foliate-backed keyed document body. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { EpubBody } from './EpubBody.tsx'
import { en, zh } from './locales.ts'

/** EPUB implementation identity, shared by metadata and the keyed slot. */
export const EPUB_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/epub'

/** File suffixes the EPUB body accepts. */
export const EPUB_EXTENSIONS = ['epub'] as const

/**
 * Describe the builtin EPUB renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns the complete-file EPUB registration.
 */
export function epubBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: EPUB_BODY_ID, extensions: EPUB_EXTENSIONS, priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the EPUB dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarEpub')
  ctx.effect(() => ctx.locale.register('sidebarEpub', { zh, en }), 'document-epub: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(epubBodyDefinition(() => t('title'))), 'document-epub: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: EPUB_BODY_ID, locale: 'sidebarEpub' }, EpubBody,
  )), 'document-epub: body')
}
