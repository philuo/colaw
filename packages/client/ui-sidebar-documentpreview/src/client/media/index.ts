/** Builtin media metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { MediaBody } from './MediaBody.tsx'
import { en, zh } from './locales.ts'

/** Media implementation identity, shared by metadata and the keyed slot. */
export const MEDIA_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/media'

/** File suffixes rendered by the builtin media body. */
export const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'webm', 'ogv',
  'mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus',
] as const

/**
 * Describe the builtin media renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for media files played natively by the browser.
 */
export function mediaBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: MEDIA_BODY_ID,
    extensions: MEDIA_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Register the media dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarMedia')
  ctx.effect(() => ctx.locale.register('sidebarMedia', { zh, en }), 'document-media: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(mediaBodyDefinition(() => t('title'))), 'document-media: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: MEDIA_BODY_ID, locale: 'sidebarMedia' }, MediaBody,
  )), 'document-media: body')
}
