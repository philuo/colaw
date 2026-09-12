/** Copy owned by the Office renderers (docx / pptx / xlsx share one namespace). */
export const zh = {
  docxTitle: 'Word 文档',
  pptxTitle: '演示文稿',
  xlsxTitle: '电子表格',
  loading: '正在解析 Office 文件…',
  failed: '无法显示 Office 文件：{message}',
  unsupported: 'Office 预览需要完整文件内容。',
  retry: '重试',
  previousPage: '上一页',
  nextPage: '下一页',
  previousSlide: '上一张',
  nextSlide: '下一张',
  pageOf: '{index} / {total}',
} satisfies Record<string, string>

/** Office translation keys shared by both dictionaries. */
export type OfficeLocaleKey = keyof typeof zh

/** English Office-renderer dictionary. */
export const en = {
  docxTitle: 'Word document',
  pptxTitle: 'Presentation',
  xlsxTitle: 'Spreadsheet',
  loading: 'Parsing the Office file…',
  failed: 'Cannot display the Office file: {message}',
  unsupported: 'Office preview requires the complete file contents.',
  retry: 'Retry',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  previousSlide: 'Previous slide',
  nextSlide: 'Next slide',
  pageOf: '{index} / {total}',
} satisfies Record<OfficeLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Office page/slide, loading, and failure messages. */
    sidebarOffice: OfficeLocaleKey
  }
}
