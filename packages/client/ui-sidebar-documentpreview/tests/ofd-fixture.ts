/** OFD fixtures: a minimal zip writer (store / deflate-raw) plus a tiny two-page-free OFD package. */

/** Zip compression methods the fixture writer can emit. */
export const STORE_METHOD = 0
export const DEFLATE_METHOD = 8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let at = 0; at < 256; at++) {
    let value = at
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    table[at] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = streamOf(bytes)
    .pipeThrough(new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** One entry the fixture writer stores into the archive. */
export interface ZipFixtureEntry {
  readonly name: string
  readonly data: Uint8Array
  /** Any value is legal so tests can produce archives the reader must reject; 8 deflates when the runtime allows. */
  readonly method?: number
}

/**
 * Build an in-memory zip. The archive comment is emitted after the EOCD, so
 * it also exercises the reader's backward EOCD scan.
 * @param entries - the entries to store.
 * @param comment - optional archive comment (ASCII).
 * @returns zip bytes.
 */
export async function zipOf(entries: readonly ZipFixtureEntry[], comment = ''): Promise<Uint8Array> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const { name, data, method = STORE_METHOD } of entries) {
    const payload = method === DEFLATE_METHOD && typeof CompressionStream !== 'undefined'
      ? await deflateRaw(data)
      : data
    const nameBytes = new TextEncoder().encode(name)
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc32(data), true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, crc32(data), true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
  }
  const centralBytes = concat(centrals)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralBytes.length, true)
  eocdView.setUint32(16, offset, true)
  eocdView.setUint16(20, comment.length, true)
  return concat([...locals, centralBytes, eocd, new TextEncoder().encode(comment)])
}

/** A short PNG-shaped payload; the renderer only keys MIME off the extension. */
export function stampBytes(): Uint8Array {
  return Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
const OFD_NS = 'xmlns:ofd="http://www.ofdspec.org/2016"'

/**
 * A nested-layout OFD package: document at Doc_0/Document.xml, a resource
 * list with one resolvable and one missing image, and one page carrying a
 * multi-line TextObject plus two ImageObjects.
 * @returns zip bytes of the package.
 */
export async function ofdPackage(): Promise<Uint8Array> {
  const container = `${XML_DECLARATION}<ofd:OFDContainer ${OFD_NS}><ofd:DocBody><ofd:DocPath>Doc_0/Document.xml</ofd:DocPath></ofd:DocBody></ofd:OFDContainer>`
  const document = `${XML_DECLARATION}<ofd:Document ${OFD_NS}>`
    + '<ofd:CommonData><ofd:MaxPageNo>1</ofd:MaxPageNo></ofd:CommonData>'
    + '<ofd:PublicRes BaseLoc="DocumentRes.xml"/>'
    + '<ofd:Page BaseLoc="Pages/Page_0" PhysicalBox="0 0 148 210"/>'
    + '</ofd:Document>'
  const resources = `${XML_DECLARATION}<ofd:Res ${OFD_NS}>`
    + '<ofd:MultiMedia ID="1" Type="Image"><ofd:MediaFile Loc="Res/stamp.png"/></ofd:MultiMedia>'
    + '<ofd:MultiMedia ID="2" Type="Image"><ofd:MediaFile Loc="Res/missing.png"/></ofd:MultiMedia>'
    + '</ofd:Res>'
  const content = `${XML_DECLARATION}<ofd:Page ${OFD_NS}><ofd:Content><ofd:Layer ID="1">`
    + '<ofd:TextObject Boundary="20 20 100 30" Size="4">'
    + '<ofd:TextCode Y="0">第一条 测试文本行</ofd:TextCode>'
    + '<ofd:TextCode X="10" Y="35">第二条 另起一行</ofd:TextCode>'
    + '<ofd:TextCode Y="12">第三条 收尾</ofd:TextCode>'
    + '</ofd:TextObject>'
    + '<ofd:ImageObject Boundary="20 60 40 20" ResourceID="1"/>'
    + '<ofd:ImageObject Boundary="20 90 40 20" ResourceID="2"/>'
    + '</ofd:Layer></ofd:Content></ofd:Page>'
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  return zipOf([
    { name: 'META-INF/container.xml', data: encode(container) },
    { name: 'Doc_0/Document.xml', data: encode(document) },
    { name: 'Doc_0/DocumentRes.xml', data: encode(resources) },
    { name: 'Doc_0/Pages/Page_0/Content.xml', data: encode(content) },
    { name: 'Doc_0/Res/stamp.png', data: stampBytes() },
  ])
}
