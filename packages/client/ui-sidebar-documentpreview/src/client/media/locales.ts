/** Locale-owned media renderer labels (audio and video register separately). */
export const zh = {
  audioTitle: '音频',
  videoTitle: '视频',
  loading: '正在打开媒体…',
  failed: '无法播放这个媒体文件。',
  unsupported: '媒体预览需要完整文件内容。',
} satisfies Record<string, string>

export const en = {
  audioTitle: 'Audio',
  videoTitle: 'Video',
  loading: 'Opening media…',
  failed: 'Unable to play this media file.',
  unsupported: 'Media preview needs the complete file content.',
} satisfies Record<string, string>

/** Media renderer dictionary keys. */
export type MediaKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Media player titles and status text. */
    sidebarMedia: MediaKey
  }
}
