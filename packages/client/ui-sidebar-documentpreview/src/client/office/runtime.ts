/**
 * The Office viewer seam: the only module that touches `@silurus/ooxml`, the
 * same boundary the PDF renderer draws around pdfjs. The library ships its own
 * worker fallback (a data-URL worker when no module URL is available), so the
 * one thing it cannot self-supply — the parser WebAssembly — arrives through
 * the inlined `wasmUrl` blob from {@link ./assets.ts}.
 */
import { DocxViewer, type DocxViewerOptions } from '@silurus/ooxml/docx'
import { PptxViewer, type PptxViewerOptions } from '@silurus/ooxml/pptx'
import { XlsxViewer, XlsxWorkbook, type XlsxViewerOptions } from '@silurus/ooxml/xlsx'
import { ooxmlWasmUrl, type OoxmlFormat } from './assets.ts'

export type { OoxmlFormat }
export { DocxViewer, PptxViewer, XlsxViewer, XlsxWorkbook }

/** Progress and failure callbacks the body shares across formats. */
export interface OfficeHooks {
  /**
   * Page/slide position, reported by the viewer as it lays out and navigates.
   * @param index - zero-based position.
   * @param total - known positions so far; a progressive layout may grow it.
   */
  readonly onProgress: (index: number, total: number) => void
  /** An asynchronous viewer failure after its load promise settled. */
  readonly onError: (error: Error) => void
}

/**
 * A loaded, interactive viewer. `navigate` is present for the paged formats
 * (Word, PowerPoint); the spreadsheet viewer owns its own sheet tabs instead.
 */
export interface OfficeHandle {
  readonly dispose: () => void
  readonly navigate?: {
    readonly previous: () => void
    readonly next: () => void
  }
}

/**
 * Parse one Word document and present its pages in the canvas.
 * @param canvas - the canvas the viewer renders the current page into.
 * @param data - the complete `.docx` bytes (copied; the parser takes ownership).
 * @param hooks - progress and failure callbacks.
 * @returns the viewer handle.
 */
export async function openDocx(canvas: HTMLCanvasElement, data: ArrayBuffer, hooks: OfficeHooks): Promise<OfficeHandle> {
  const options: DocxViewerOptions = {
    wasmUrl: ooxmlWasmUrl('docx'),
    onPageChange: (index, total) => { hooks.onProgress(index, total) },
    onError: hooks.onError,
  }
  const viewer = new DocxViewer(canvas, options)
  try {
    await viewer.load(data)
    await viewer.fitWidth()
  } catch (error) {
    viewer.destroy()
    throw error
  }
  return {
    dispose: () => { viewer.destroy() },
    navigate: {
      previous: () => { void viewer.prevPage() },
      next: () => { void viewer.nextPage() },
    },
  }
}

/**
 * Parse one slide deck and present its slides in the canvas.
 * @param canvas - the canvas the viewer renders the current slide into.
 * @param data - the complete `.pptx` bytes (copied; the parser takes ownership).
 * @param hooks - progress and failure callbacks.
 * @returns the viewer handle.
 */
export async function openPptx(canvas: HTMLCanvasElement, data: ArrayBuffer, hooks: OfficeHooks): Promise<OfficeHandle> {
  const options: PptxViewerOptions = {
    wasmUrl: ooxmlWasmUrl('pptx'),
    onSlideChange: (index, total) => { hooks.onProgress(index, total) },
    onError: hooks.onError,
  }
  const viewer = new PptxViewer(canvas, options)
  try {
    await viewer.load(data)
    await viewer.fitWidth()
  } catch (error) {
    viewer.destroy()
    throw error
  }
  return {
    dispose: () => { viewer.destroy() },
    navigate: {
      previous: () => { void viewer.prevSlide() },
      next: () => { void viewer.nextSlide() },
    },
  }
}

/**
 * Parse one workbook and present its sheets in the container; the viewer owns
 * the sheet tab bar and the grid surface inside it.
 * @param container - the element the viewer mounts its canvas and tabs into.
 * @param data - the complete `.xlsx` bytes (copied; the parser takes ownership).
 * @param hooks - failure callbacks (a workbook has no page concept).
 * @returns the handle releasing the viewer and the borrowed workbook.
 */
export async function openXlsx(container: HTMLElement, data: ArrayBuffer, hooks: OfficeHooks): Promise<OfficeHandle> {
  const options: XlsxViewerOptions = { wasmUrl: ooxmlWasmUrl('xlsx'), onError: hooks.onError }
  const workbook = await XlsxWorkbook.load(data, options)
  let viewer: Omit<XlsxViewer, 'load'>
  try {
    viewer = XlsxViewer.fromWorkbook(container, workbook, options)
  } catch (error) {
    workbook.destroy()
    throw error
  }
  return {
    dispose: () => {
      viewer.destroy()
      workbook.destroy()
    },
  }
}
