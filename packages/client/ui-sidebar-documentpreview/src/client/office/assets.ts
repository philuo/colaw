/**
 * The parsers' WebAssembly payloads ride the same artifact as the runtime that
 * fetches them: the dynamic client factory has no module URL from which a
 * `new URL('…', import.meta.url)` reference could resolve, so the build inlines
 * every parser as base64 (see the package tsdown config) and this module turns
 * one into a blob URL the library accepts through its `wasmUrl` load option.
 */

/** Every format whose parser ships beside this renderer. */
export type OoxmlFormat = 'docx' | 'pptx' | 'xlsx'

declare global {
  /** Inline parser payloads supplied by the package-local build configuration. */
  const __DSH_OOXML_WASM__: Readonly<Record<OoxmlFormat, string>>
}

const blobUrls = new Map<OoxmlFormat, string>()

/**
 * Decode one inlined parser and hand it to the library as a same-origin blob URL.
 * The URL lives for the page: a document preview parses at most once per open,
 * and the payload itself is immutable.
 * @param format - the parser to materialize.
 * @returns the `wasmUrl` value a viewer's load options take.
 */
export function ooxmlWasmUrl(format: OoxmlFormat): string {
  const existing = blobUrls.get(format)
  if (existing !== undefined) return existing
  const bytes = decodeOoxmlWasm(format)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }))
  blobUrls.set(format, url)
  return url
}

/**
 * Decode one inlined parser payload.
 * @param format - the parser to decode.
 * @returns the raw WebAssembly bytes.
 * @throws when the build did not inline the format's parser.
 */
export function decodeOoxmlWasm(format: OoxmlFormat): Uint8Array<ArrayBuffer> {
  const base64 = typeof __DSH_OOXML_WASM__ === 'object' ? __DSH_OOXML_WASM__[format] : undefined
  if (base64 === undefined) throw new Error(`OOXML parser is not bundled: ${format}`)
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
}
