/** Canvas rendering with cancellation and page cleanup, shared by the PDF body and real-library smoke. */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'

/** The document operations used by one mounted PDF body. */
export type PdfDocument = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>

/** One in-flight PDF load and its complete cleanup operation. */
export interface PdfSession {
  readonly document: Promise<PdfDocument>
  /**
   * Cancel loading and rendering, destroy the document, and release its worker.
   * Library teardown failures are logged after native resources are released.
   * @returns cleanup completion without rejection.
   */
  dispose(): Promise<void>
}

/** Page geometry expressed in CSS pixels. */
export interface PdfPageSize {
  readonly width: number
  readonly height: number
}

/**
 * Render one page into an exclusively owned canvas. Cancellation cannot write
 * dimensions after a delayed getPage; active render tasks are cancelled and
 * awaited before the page is cleaned up. Only the bitmap belongs to the
 * renderer — the caller places the returned CSS geometry on whatever element
 * displays the page, which may not be the canvas drawn into here.
 * @param document - loaded pdfjs document.
 * @param pageNumber - 1-based selected page.
 * @param canvas - canvas owned by this render only.
 * @param signal - render lifetime.
 * @param pixelRatio - display pixel ratio.
 * @returns the page's CSS dimensions after rendering completes.
 */
export async function renderPdfPage(
  document: PdfDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  pixelRatio: number,
): Promise<PdfPageSize> {
  signal.throwIfAborted()
  const page: PDFPageProxy = await document.getPage(pageNumber)
  try {
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 96 / 72 })
    // Limit raster allocation without changing the document's display dimensions.
    const ratio = Math.min(pixelRatio, Math.sqrt(16_777_216 / (viewport.width * viewport.height)))
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    const cancel = (): void => { task.cancel() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) cancel()
      await task.promise
      signal.throwIfAborted()
      return { width: viewport.width, height: viewport.height }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}

/**
 * Build one page's selectable text layer into an exclusively owned container.
 * The layer mirrors the canvas viewport exactly (same 96/72 scale), so spans
 * land on the drawn glyphs and the reader selects real text. Positioning and
 * font sizing come from pdfjs itself (inline styles keyed off the container's
 * `--scale-factor`); the container's stylesheet supplies the transparency and
 * selection highlight.
 * @param document - loaded pdfjs document.
 * @param pageNumber - 1-based selected page.
 * @param container - a container positioned exactly over the page canvas.
 * @param signal - layer lifetime; aborting cancels the render.
 */
export async function renderPdfTextLayer(
  document: PdfDocument,
  pageNumber: number,
  container: HTMLDivElement,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const page: PDFPageProxy = await document.getPage(pageNumber)
  try {
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 96 / 72 })
    container.style.setProperty('--scale-factor', String(viewport.scale))
    container.replaceChildren()
    const layer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    })
    const cancel = (): void => { layer.cancel() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) cancel()
      await layer.render()
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}
