/** Builtin media registrations: separate audio and video keyed document bodies. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { MediaBody } from './MediaBody.tsx'
import { en, zh } from './locales.ts'

/** Audio implementation identity, shared by metadata and the keyed slot. */
export const AUDIO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/audio'

/** Video implementation identity, shared by metadata and the keyed slot. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/** File suffixes each player accepts; the sets are disjoint. */
export const MEDIA_EXTENSIONS = {
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'ogv'],
} as const

/**
 * Describe one media renderer independently from its keyed body slot.
 * @param id - the implementation identity to register under.
 * @param extensions - the file suffixes this player accepts.
 * @param title - locale-owned implementation name.
 * @returns the complete-file media registration.
 */
function mediaBodyDefinition(id: string, extensions: readonly string[], title: () => string): DocumentPreviewDefinition {
  return { id, extensions, priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the media dictionary, the two metadata rows (audio, video), and
 * their keyed bodies with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarMedia')
  ctx.effect(() => ctx.locale.register('sidebarMedia', { zh, en }), 'document-media: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(mediaBodyDefinition(AUDIO_BODY_ID, MEDIA_EXTENSIONS.audio, () => t('audioTitle'))), 'document-media: audio metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: AUDIO_BODY_ID, locale: 'sidebarMedia' }, MediaBody,
  )), 'document-media: audio body')
  ctx.effect(() => ctx.documentPreviews.register(mediaBodyDefinition(VIDEO_BODY_ID, MEDIA_EXTENSIONS.video, () => t('videoTitle'))), 'document-media: video metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarMedia' }, MediaBody,
  )), 'document-media: video body')
}
