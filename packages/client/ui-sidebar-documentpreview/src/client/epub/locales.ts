/** Locale-owned EPUB renderer labels. */
export const zh = {
  title: '电子书',
  loading: '正在打开电子书…',
  failed: '无法渲染这本电子书。',
  unsupported: '电子书预览需要完整文件内容。',
} satisfies Record<string, string>

export const en = {
  title: 'EPUB book',
  loading: 'Opening the book…',
  failed: 'Unable to render this EPUB book.',
  unsupported: 'EPUB preview needs the complete file content.',
} satisfies Record<string, string>

/** EPUB renderer dictionary keys. */
export type EpubKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** EPUB reader title and status text. */
    sidebarEpub: EpubKey
  }
}
