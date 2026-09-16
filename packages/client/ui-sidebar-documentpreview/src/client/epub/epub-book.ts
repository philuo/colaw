/** EPUB（zip+OPF）打开：包内 zip 读取器供数，foliate 解析容器、OPF 与导航。 */

import { unzipEntries } from '../ofd/zip.ts'
import { EPUB } from './foliate/epub.js'

/** foliate 的 EPUB.init() 产物。 */
export type EpubBook = Awaited<ReturnType<EPUB['init']>>

/**
 * 从文件字节打开一本 EPUB：条目常驻内存，loadText/loadBlob 供 foliate 惰性取用。
 * @param data - EPUB 文件字节。
 * @returns 已初始化的 foliate EPUB 实例。
 */
export async function openEpubBook(data: Uint8Array): Promise<EpubBook> {
  const files = await unzipEntries(data)
  return new EPUB({
    loadText: (name) => {
      const bytes = files.get(name)
      return bytes === undefined ? null : new TextDecoder().decode(bytes)
    },
    loadBlob: (name, type) => {
      const bytes = files.get(name)
      if (bytes === undefined) return null
      return type !== undefined
        ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type })
        : new Blob([bytes as Uint8Array<ArrayBuffer>])
    },
    getSize: name => files.get(name)?.byteLength ?? 0,
  }).init()
}
