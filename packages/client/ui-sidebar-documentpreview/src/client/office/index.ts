/** Builtin Office registrations through document metadata and the keyed body slot. */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { OfficeBody, type OfficeBodyProps } from './OfficeBody.tsx'
import { en, zh } from './locales.ts'

/** One Office format's package-local implementation identity. */
export const OFFICE_BODY_IDS = {
  docx: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/docx',
  pptx: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pptx',
  xlsx: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/xlsx',
} as const

/** One Office format this package renders. */
export type OfficeFormat = keyof typeof OFFICE_BODY_IDS

/** The file suffixes each format's viewer accepts. Legacy binary formats are out of scope. */
const OFFICE_EXTENSIONS: Readonly<Record<OfficeFormat, readonly string[]>> = {
  docx: ['docx'],
  pptx: ['pptx'],
  xlsx: ['xlsx', 'xlsm'],
}

/** The locale keys naming each format's title. */
const OFFICE_TITLES: Readonly<Record<OfficeFormat, keyof typeof zh>> = {
  docx: 'docxTitle',
  pptx: 'pptxTitle',
  xlsx: 'xlsxTitle',
}

/**
 * Describe one builtin Office renderer independently from its keyed body slot.
 * @param format - the format to describe.
 * @param title - locale-owned implementation name.
 * @returns the complete-file Office registration.
 */
export function officeBodyDefinition(format: OfficeFormat, title: () => string): DocumentPreviewDefinition {
  return {
    id: OFFICE_BODY_IDS[format], extensions: OFFICE_EXTENSIONS[format],
    priority: 'builtin', title, loading: 'bytes-complete', wrap: false,
  }
}

/**
 * Register the Office dictionaries, metadata, and bodies with reversible
 * effects: one definition and one keyed body per format, all sharing the
 * `sidebarOffice` dictionary and the single body implementation.
 * @param ctx - context carrying the locale, document registry, and slot registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('sidebarOffice', { zh, en }), 'document-office: dictionaries')
  const t = ctx.locale.bind('sidebarOffice')
  for (const format of ['docx', 'pptx', 'xlsx'] as const) {
    const id = OFFICE_BODY_IDS[format]
    ctx.effect(() => ctx.documentPreviews.register(officeBodyDefinition(format, () => t(OFFICE_TITLES[format]))),
      `document-office: ${format} metadata`)
    const Body = (props: OfficeBodyProps): ReactNode => createElement(OfficeBody, { ...props, format })
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key: id, locale: 'sidebarOffice' }, Body,
    )), `document-office: ${format} body`)
  }
}
