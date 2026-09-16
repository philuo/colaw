/**
 * 最小 ZIP 读取器：解析中央目录并解压条目，仅覆盖 OFD 需要的形态
 * （store 与 deflate），浏览器端用原生 DecompressionStream 解码。
 */

/** EOCD 记录：中央目录的定位与条目数。 */
interface Eocd {
  readonly entries: number
  readonly directoryOffset: number
}

/** 从数据尾部定位 EOCD（签名 0x06054b50），容忍最长 64KB 的注释。 */
function findEocd(data: Uint8Array): Eocd {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let at = data.byteLength - 22; at >= Math.max(0, data.byteLength - 22 - 65535); at--) {
    if (view.getUint32(at, true) !== 0x06054b50) continue
    return {
      entries: view.getUint16(at + 10, true),
      directoryOffset: view.getUint32(at + 16, true),
    }
  }
  throw new Error('ofd: end of central directory not found')
}

/** 字节作为单块流的直通包装（jsdom 的 Blob 没有 stream()，且这样更省一次拷贝）。 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 解压单个条目：store 直接返回，deflate 走原生 DecompressionStream('deflate-raw')。 */
async function inflateEntry(data: Uint8Array, method: number, start: number, compressedSize: number): Promise<Uint8Array> {
  const compressed = data.subarray(start, start + compressedSize)
  if (method === 0) return new Uint8Array(compressed)
  if (method !== 8) throw new Error(`ofd: unsupported zip method ${String(method)}`)
  const stream = streamOf(compressed)
    .pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 解压 OFD（zip）的全部条目到内存映射。 */
export async function unzipEntries(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocd = findEocd(data)
  const out = new Map<string, Uint8Array>()
  let at = eocd.directoryOffset
  for (let index = 0; index < eocd.entries; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localHeaderOffset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength))
    // 下一目录项 = 头 46 字节 + 名字 + 额外字段 + 注释。
    at += 46 + nameLength + extraLength + commentLength
    // 本头里名字/额外字段的长度可能与中央目录不同，以本头为准再定位数据。
    const nameLengthLocal = view.getUint16(localHeaderOffset + 26, true)
    const extraLengthLocal = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + nameLengthLocal + extraLengthLocal
    out.set(name, await inflateEntry(data, method, dataStart, compressedSize))
  }
  return out
}
