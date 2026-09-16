/** Locale-owned OFD renderer labels (shared by structured-text and layout bodies). */
export const zh = {
  textTitle: '结构化文本',
  hifiTitle: '版式预览',
  textLoading: '正在解析 OFD…',
  textFailed: '无法解析这个 OFD 文件。',
  hifiLoading: '正在渲染版式…',
  hifiFailed: '无法渲染这个 OFD 文件。',
} satisfies Record<string, string>

export const en = {
  textTitle: 'Structured text',
  hifiTitle: 'Layout preview',
  textLoading: 'Parsing the OFD…',
  textFailed: 'Unable to parse this OFD file.',
  hifiLoading: 'Rendering the layout…',
  hifiFailed: 'Unable to render this OFD file.',
} satisfies Record<string, string>

/** OFD renderer dictionary keys. */
export type OfdKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OFD renderer titles and loading/failure text. */
    sidebarOfd: OfdKey
  }
}
