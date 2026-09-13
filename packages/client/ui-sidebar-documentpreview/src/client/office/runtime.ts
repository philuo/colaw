/**
 * The Office viewer seam: the only module that touches `@silurus/ooxml`, the
 * same boundary the PDF renderer draws around pdfjs. Word and PowerPoint use
 * the library's scroll viewers — continuous multi-page surfaces with a text
 * selection layer, live hyperlinks, and width refit — and Excel uses its
 * grid viewer with the sheet tab bar. The one thing the library cannot
 * self-supply, the parser WebAssembly, arrives through the inlined `wasmUrl`
 * blob from {@link ./assets.ts}.
 */
import { openExternal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocxScrollViewer, type DocxScrollViewerOptions } from '@silurus/ooxml/docx'
import { PptxScrollViewer, type PptxScrollViewerOptions } from '@silurus/ooxml/pptx'
import { XlsxViewer, XlsxWorkbook, type XlsxViewerOptions } from '@silurus/ooxml/xlsx'
import { ooxmlWasmUrl, type OoxmlFormat } from './assets.ts'

export type { OoxmlFormat }
export { DocxScrollViewer, PptxScrollViewer, XlsxViewer, XlsxWorkbook }

/** Scale bounds shared by the viewer options and the body's wheel gesture. */
export const OFFICE_ZOOM_MIN = 0.25
export const OFFICE_ZOOM_MAX = 8

/** Failure callbacks the body shares across formats. */
export interface OfficeHooks {
  /** An asynchronous viewer failure after its load promise settled. */
  readonly onError: (error: Error) => void
}

/**
 * A loaded, interactive viewer. `zoom` drives the body's pinch gesture (the
 * library's own wheel zoom is a discrete 1.1x step, deliberately replaced by
 * the image preview's continuous curve); `scrollHost` is the scrollable
 * element the cursor-anchor math needs, present for the paged formats only.
 * The xlsx handle carries `expandMergedSelection`, which widens a single-cell
 * selection to its merge range so a merged cell reads — and clicks — as one.
 */
export interface OfficeHandle {
  readonly dispose: () => void
  readonly zoom: {
    readonly getScale: () => number
    readonly setScale: (scale: number) => void
  }
  readonly scrollHost?: HTMLElement | undefined
  readonly expandMergedSelection?: () => Promise<void>
}

/** Route one hyperlink activation through the app's single external seam. */
function onHyperlinkClick(target: { kind: string; url?: string }): void {
  if (target.kind === 'external' && typeof target.url === 'string') openExternal(target.url)
}

/** The viewer's scrollable element: the wrapper's first child inside the container. */
function scrollHostOf(container: HTMLElement): HTMLElement | undefined {
  const host = container.firstElementChild?.firstElementChild
  return host instanceof HTMLElement ? host : undefined
}

/** The viewer options every format shares: parser payload, selection, links, zoom bounds. */
function sharedOptions<Wasm>(wasm: Wasm, hooks: OfficeHooks) {
  return {
    wasmUrl: wasm,
    // CJK font fallback: documents naming fonts the host lacks (常见于中文
    // 排版问题) fall back per the auto-detected region instead of rendering
    // tofu or mis-measured runs.
    cjkFallback: 'auto',
    // Render at the display's pixel density so glyph metrics and hit tests
    // match what the screen shows.
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    enableTextSelection: true,
    enableHyperlinks: true,
    onHyperlinkClick,
    // The library's wheel zoom is replaced by the body's continuous gesture;
    // its zoomIn/zoomOut and the setScale clamp still honor these bounds.
    zoomMin: OFFICE_ZOOM_MIN,
    zoomMax: OFFICE_ZOOM_MAX,
    onError: hooks.onError,
  }
}

/**
 * Parse one Word document and present its pages as a continuous scroll with
 * selectable text and live hyperlinks, fitted to the container width.
 * @param container - the element the viewer mounts its scroll surface into.
 * @param data - the complete `.docx` bytes (copied; the parser takes ownership).
 * @param hooks - failure callbacks.
 * @returns the viewer handle.
 */
export async function openDocx(container: HTMLElement, data: ArrayBuffer, hooks: OfficeHooks): Promise<OfficeHandle> {
  const viewer = new DocxScrollViewer(container, sharedOptions(ooxmlWasmUrl('docx'), hooks) as DocxScrollViewerOptions)
  try {
    await viewer.load(data)
    viewer.fitWidth()
  } catch (error) {
    viewer.destroy()
    throw error
  }
  return { dispose: () => { viewer.destroy() }, zoom: viewer, scrollHost: scrollHostOf(container) }
}

/**
 * Parse one slide deck and present its slides as a continuous scroll with
 * selectable text and live hyperlinks, fitted to the container width.
 * @param container - the element the viewer mounts its scroll surface into.
 * @param data - the complete `.pptx` bytes (copied; the parser takes ownership).
 * @param hooks - failure callbacks.
 * @returns the viewer handle.
 */
export async function openPptx(container: HTMLElement, data: ArrayBuffer, hooks: OfficeHooks): Promise<OfficeHandle> {
  const viewer = new PptxScrollViewer(container, sharedOptions(ooxmlWasmUrl('pptx'), hooks) as PptxScrollViewerOptions)
  try {
    await viewer.load(data)
    viewer.fitWidth()
  } catch (error) {
    viewer.destroy()
    throw error
  }
  return { dispose: () => { viewer.destroy() }, zoom: viewer, scrollHost: scrollHostOf(container) }
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
  const options: XlsxViewerOptions = {
    wasmUrl: ooxmlWasmUrl('xlsx'),
    onError: hooks.onError,
  }
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
    zoom: viewer,
    expandMergedSelection: async () => {
      const selection = viewer.selectionState
      const area = selection?.areas[selection.activeAreaIndex]
      // Only a lone cell widens: a dragged multi-cell range is the reader's
      // own choice and must not be rewritten.
      if (area === undefined || area.kind !== 'cells') return
      if (area.top !== area.bottom || area.left !== area.right) return
      const worksheet = await workbook.getWorksheet(viewer.sheetIndex).catch(() => undefined)
      const merge = worksheet?.mergeCells.find(range =>
        area.top >= range.top && area.top <= range.bottom
        && area.left >= range.left && area.left <= range.right)
      if (merge === undefined) return
      viewer.setSelection({
        areas: [{ kind: 'cells', top: merge.top, left: merge.left, bottom: merge.bottom, right: merge.right }],
        activeAreaIndex: 0,
        activeCell: { row: merge.top, col: merge.left },
        extensionAnchor: { row: merge.top, col: merge.left },
      })
    },
  }
}
