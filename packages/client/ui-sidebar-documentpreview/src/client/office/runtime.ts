/**
 * The Office viewer seam: the only module that touches `@silurus/ooxml`, the
 * same boundary the PDF renderer draws around pdfjs. Word and PowerPoint use
 * the library's scroll viewers — continuous multi-page surfaces with a text
 * selection layer, live hyperlinks, and width refit — and Excel uses its
 * grid viewer with the sheet tab bar. The one thing the library cannot
 * self-supply, the parser WebAssembly, arrives through the inlined `wasmUrl`
 * blob from {@link ./assets.ts}.
 */
import { openExternal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocxScrollViewer, type DocxScrollViewerOptions } from '@silurus/ooxml/docx'
import { PptxScrollViewer, type PptxScrollViewerOptions } from '@silurus/ooxml/pptx'
import { XlsxViewer, XlsxWorkbook, type XlsxViewerOptions } from '@silurus/ooxml/xlsx'
import type { XlsxSelectionContext } from '@silurus/ooxml/xlsx'
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

/** One merge range of a worksheet, 1-based inclusive cell coordinates. */
export interface MergeRange {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

/**
 * The merged-cell and copy interactions the xlsx body drives. The viewer's
 * own hit-testing is grid-cell granular — a click inside a merged cell
 * selects one grid cell — so the body layers whole-merge selection behavior
 * over the viewer's public surface, plus the pane-level clipboard copy.
 */
export interface XlsxInteractions {
  /** Widen a lone-cell selection that sits inside a merge to the whole merge. */
  readonly expandMergedSelection: () => Promise<boolean>
  /** Copy the selected cells through the viewer's clipboard path; its status word. */
  readonly copySelection: () => Promise<'copied' | 'empty-selection' | 'unsupported-multiple-areas' | 'too-large' | 'clipboard-unavailable' | 'clipboard-denied'>
  /** Subscribe to the viewer's committed selection changes (one slot; last wins). */
  readonly onSelectionChange: (listener: () => void) => void
}

/**
 * A loaded, interactive viewer. `zoom` drives the body's pinch gesture on the
 * paged formats (the library's own wheel zoom is a discrete 1.1x step,
 * replaced by the image preview's continuous curve); the xlsx grid keeps the
 * library's built-in wheel zoom, which scales the grid itself. `scrollHost`
 * is the scrollable element the cursor-anchor math needs, present for the
 * paged formats only.
 */
export interface OfficeHandle {
  readonly dispose: () => void
  readonly zoom: {
    readonly getScale: () => number
    readonly setScale: (scale: number) => void
  }
  readonly scrollHost?: HTMLElement | undefined
  /** Present for the xlsx format: whole-merge interactions and cell copy. */
  readonly xlsx?: XlsxInteractions
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
 * The selection's clipboard text for the fallback copy: grid order — tabs
 * between columns, newlines between rows, blanks for empty cells — the same
 * shape the viewer serializes for its own attempt. A truncated or non-range
 * context has no faithful text, so it answers none.
 * @param context - the viewer's selection context snapshot.
 * @returns the tab-separated text, or undefined when it cannot be built.
 */
function selectionText(context: XlsxSelectionContext | null): string | undefined {
  if (context?.kind !== 'range' || context.truncated) return undefined
  const rows = new Map<number, Map<number, string>>()
  for (const cell of context.cells) {
    const columns = rows.get(cell.address.row) ?? new Map<number, string>()
    columns.set(cell.address.col, cell.displayText)
    rows.set(cell.address.row, columns)
  }
  if (rows.size === 0) return undefined
  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, columns]) => [...columns.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('\t'))
    .join('\n')
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
  let selectionListener: (() => void) | undefined
  const options: XlsxViewerOptions = {
    wasmUrl: ooxmlWasmUrl('xlsx'),
    onError: hooks.onError,
    onSelectionStateChange: () => { selectionListener?.() },
  }
  const workbook = await XlsxWorkbook.load(data, options)
  let viewer: Omit<XlsxViewer, 'load'>
  try {
    viewer = XlsxViewer.fromWorkbook(container, workbook, options)
  } catch (error) {
    workbook.destroy()
    throw error
  }
  // The active sheet's merge ranges, cached per sheet index: every committed
  // selection consults them before widening.
  const mergeCache = new Map<number, readonly MergeRange[]>()
  const mergesOfSheet = async (): Promise<readonly MergeRange[]> => {
    const index = viewer.sheetIndex
    const cached = mergeCache.get(index)
    if (cached !== undefined) return cached
    const worksheet = await workbook.getWorksheet(index).catch(() => undefined)
    const merges = worksheet?.mergeCells ?? []
    mergeCache.set(index, merges)
    return merges
  }
  const xlsx: XlsxInteractions = {
    expandMergedSelection: async () => {
      const selection = viewer.selectionState
      const area = selection?.areas[selection.activeAreaIndex]
      // Only a lone cell widens: a dragged multi-cell range is the reader's
      // own choice and must not be rewritten.
      if (area === undefined || area.kind !== 'cells') return false
      if (area.top !== area.bottom || area.left !== area.right) return false
      const merge = (await mergesOfSheet()).find(range =>
        area.top >= range.top && area.top <= range.bottom
        && area.left >= range.left && area.left <= range.right)
      if (merge === undefined) return false
      viewer.setSelection({
        areas: [{ kind: 'cells', top: merge.top, left: merge.left, bottom: merge.bottom, right: merge.right }],
        activeAreaIndex: 0,
        activeCell: { row: merge.top, col: merge.left },
        extensionAnchor: { row: merge.top, col: merge.left },
      })
      return true
    },
    copySelection: async () => {
      const result = await viewer.copySelection()
      if (result.status !== 'clipboard-unavailable' && result.status !== 'clipboard-denied') {
        return result.status
      }
      // The viewer's only write path is the async Clipboard API; a host that
      // denies it (WKWebView's user-activation gate) still deserves the copy.
      // The selection text it serialized for its own attempt is rebuilt here
      // and carried through the shared helper's bridge and command fallbacks.
      const text = selectionText(viewer.getSelectionContext())
      if (text === undefined) return result.status
      return await writeClipboard(text) ? 'copied' : result.status
    },
    onSelectionChange: (listener) => { selectionListener = listener },
  }
  // Warm the cache for the opening sheet so the first committed selection
  // already resolves its merges.
  void mergesOfSheet()
  return {
    dispose: () => {
      viewer.destroy()
      workbook.destroy()
    },
    zoom: viewer,
    xlsx,
  }
}
