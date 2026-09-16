/** Builtin OFD registration: one layout body over the .ofd extension. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { OfdHifiBody } from './OfdHifiBody.tsx'
import { en, zh, type OfdKey } from './locales.ts'

/** OFD layout implementation identity, shared by metadata and the keyed slot. */
export const OFD_HIFI_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/ofd-hifi'

/** File suffixes the OFD body accepts. */
export const OFD_EXTENSIONS = ['ofd'] as const

/**
 * Describe the OFD renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns the complete-file OFD registration.
 */
export function ofdBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: OFD_HIFI_BODY_ID, extensions: OFD_EXTENSIONS, priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the OFD dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarOfd')
  ctx.effect(() => ctx.locale.register('sidebarOfd', { zh, en }), 'document-ofd: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(ofdBodyDefinition(() => t('title'))), 'document-ofd: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: OFD_HIFI_BODY_ID, locale: 'sidebarOfd' }, OfdHifiBody,
  )), 'document-ofd: body')
}

export type { OfdKey }
