/** Builtin OFD registrations: a structured-text body and a layout body over the same extension. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { OfdTextBody } from './OfdTextBody.tsx'
import { OfdHifiBody } from './OfdHifiBody.tsx'
import { en, zh } from './locales.ts'

/** OFD structured-text implementation identity, shared by metadata and the keyed slot. */
export const OFD_TEXT_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/ofd-text'

/** OFD layout implementation identity, shared by metadata and the keyed slot. */
export const OFD_HIFI_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/ofd-hifi'

/** File suffixes both OFD bodies accept. */
export const OFD_EXTENSIONS = ['ofd'] as const

/**
 * Describe one OFD renderer independently from its keyed body slot.
 * @param id - the implementation identity to register under.
 * @param title - locale-owned implementation name.
 * @returns the complete-file OFD registration.
 */
function ofdBodyDefinition(id: string, title: () => string): DocumentPreviewDefinition {
  return { id, extensions: OFD_EXTENSIONS, priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the OFD dictionary, the two metadata rows, and the two keyed bodies
 * with reversible effects. Ordering within one apply is stable; candidates for
 * an `.ofd` file therefore list structured text first, layout second.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarOfd')
  ctx.effect(() => ctx.locale.register('sidebarOfd', { zh, en }), 'document-ofd: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(ofdBodyDefinition(OFD_TEXT_BODY_ID, () => t('textTitle'))), 'document-ofd: text metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: OFD_TEXT_BODY_ID, locale: 'sidebarOfd' }, OfdTextBody,
  )), 'document-ofd: text body')
  ctx.effect(() => ctx.documentPreviews.register(ofdBodyDefinition(OFD_HIFI_BODY_ID, () => t('hifiTitle'))), 'document-ofd: hifi metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: OFD_HIFI_BODY_ID, locale: 'sidebarOfd' }, OfdHifiBody,
  )), 'document-ofd: hifi body')
}
