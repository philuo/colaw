/** Locale-owned OFD renderer labels. */
export const zh = {
  title: '版式预览',
  loading: '正在渲染版式…',
  failed: '无法渲染这个 OFD 文件。',
} satisfies Record<string, string>

export const en = {
  title: 'Layout preview',
  loading: 'Rendering the layout…',
  failed: 'Unable to render this OFD file.',
} satisfies Record<string, string>

/** OFD renderer dictionary keys. */
export type OfdKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OFD renderer title and loading/failure text. */
    sidebarOfd: OfdKey
  }
}
