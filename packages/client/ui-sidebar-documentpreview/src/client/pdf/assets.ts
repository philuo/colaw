/** Build-owned, same-version PDF.js resources; all binary assets are decoded locally. */
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

export { workerSource }

/** Resource kinds used by PDF.js 6's BinaryDataFactory requests. */
export type PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

/** Public methods required by PDF.js's BinaryDataFactory option. */
export interface PdfBinaryDataFactory {
  /** @param request - PDF.js resource kind and exact filename. @returns independent transferable resource bytes. */
  fetch(request: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array>
}

/**
 * The static asset tree the frontend build emits for PDF.js's binary data:
 * assets/pdfjs/<directory>/<filename>, served by the frontend-static fallback.
 */
const ASSET_ROOT = '/assets/pdfjs'

/** The dist directory each PDF.js resource kind maps to under the asset root. */
const KIND_DIRECTORIES: Readonly<Record<PdfAssetKind, string>> = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
}

/**
 * Capture this build's binary assets without network fallbacks.
 * @returns the constructor passed to PDF.js getDocument.
 */
export function createPdfBinaryDataFactory(): new () => PdfBinaryDataFactory {
  return class implements PdfBinaryDataFactory {
    async fetch({ kind, filename }: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array> {
      // The frontend-static fallback serves the dist tree publicly (only index
      // responses authenticate), so a same-origin asset fetch needs no headers.
      // The absolute anchor matters: PDF.js hands this URL to its worker, and a
      // relative string would resolve against the worker's own script URL.
      const url = new URL(`${ASSET_ROOT}/${KIND_DIRECTORIES[kind]}/${encodeURIComponent(filename)}`, location.href)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`PDF.js asset is not served: ${kind}/${filename}`)
      return new Uint8Array(await response.arrayBuffer())
    }
  }
}
