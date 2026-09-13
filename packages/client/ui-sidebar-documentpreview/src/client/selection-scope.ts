/**
 * Selection scoping for the document preview: a drag or ⌘A inside one tab's
 * preview selects that tab's content ONLY — never the app chrome, the chat,
 * or the other pane's preview in split view.
 *
 * Why this exists: the shell opts content into selectability per element, but
 * WebKit treats the page as one selection surface. A drag out of the preview
 * keeps extending through everything selectable, and ⌘A (focus on the page,
 * not an input) selects every selectable region app-wide. The preview mounts
 * one scope per tab body — the pane the reader is using — and both gestures
 * resolve to it:
 *
 * - ⌘A resolves to the scope containing the focus (the body is focusable via
 *   pointerdown), else the scope under the pointer; editables keep their own
 *   select-all.
 * - A drag that began inside a scope is clamped to the intersection of the
 *   live selection with that scope's container, so it cannot grow past the
 *   tab's bounds. A drag that began elsewhere is left alone.
 */

/** The registered scope bodies, in mount order. */
const scopes = new Set<HTMLElement>()

/** The scope under the pointer, re-resolved on every pointerover. */
let hoveredScope: HTMLElement | undefined

function scopeOf(node: Node | null): HTMLElement | undefined {
  for (const scope of scopes) {
    if (scope.contains(node)) return scope
  }
  return undefined
}

function isEditable(element: Element | null): boolean {
  return element instanceof HTMLElement
    && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'a' || !(event.metaKey || event.ctrlKey) || event.altKey) return
  const active = document.activeElement
  if (isEditable(active)) return // an editor's own select-all wins
  // The pane in use: where the focus is, else where the pointer is.
  const target = scopeOf(active) ?? hoveredScope
  if (target === undefined) return
  event.preventDefault()
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.selectAllChildren(target)
}

function onPointerOver(event: PointerEvent): void {
  hoveredScope = scopeOf(event.target instanceof Node ? event.target : null)
}

const activeDrags = new Set<HTMLElement>()

function onPointerDown(event: PointerEvent): void {
  const scope = scopeOf(event.target instanceof Node ? event.target : null)
  if (scope === undefined) return
  activeDrags.add(scope)
  // Focus the pane in use so ⌘A resolves here and dual-pane stays unambiguous.
  scope.focus({ preventScroll: true })
}

function onPointerUp(): void {
  activeDrags.clear()
}

/** Clamp one live selection to the drag's origin scope, if it escaped it. */
function onSelectionChange(): void {
  if (activeDrags.size === 0) return
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return
  for (const scope of activeDrags) {
    const range = selection.getRangeAt(0)
    if (scope.contains(range.commonAncestorContainer)) continue // entirely inside already
    if (!range.intersectsNode(scope)) continue
    // The intersection of the selection with the scope: later start, earlier end.
    const inner = document.createRange()
    inner.selectNodeContents(scope)
    const clamped = document.createRange()
    if (range.compareBoundaryPoints(Range.START_TO_START, inner) >= 0) {
      clamped.setStart(range.startContainer, range.startOffset)
    } else {
      clamped.setStart(inner.startContainer, inner.startOffset)
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, inner) <= 0) {
      clamped.setEnd(range.endContainer, range.endOffset)
    } else {
      clamped.setEnd(inner.endContainer, inner.endOffset)
    }
    selection.removeAllRanges()
    selection.addRange(clamped)
    return // one clamp re-enters selectionchange; the next pass re-checks
  }
}

let listeners = 0

function retainDocumentListeners(): void {
  if (listeners++ > 0) return
  document.addEventListener('keydown', onKeyDown, { capture: true })
  document.addEventListener('pointerover', onPointerOver, { passive: true })
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('pointerup', onPointerUp, { passive: true })
  document.addEventListener('selectionchange', onSelectionChange)
}

function releaseDocumentListeners(): void {
  if (--listeners > 0) return
  document.removeEventListener('keydown', onKeyDown, { capture: true })
  document.removeEventListener('pointerover', onPointerOver)
  document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('selectionchange', onSelectionChange)
}

/**
 * Register one preview tab body as a selection scope.
 * @param element - the tab's scroll body; selection gestures inside it stay inside it.
 * @returns the disposer removing the scope (tab closed / body unmounted).
 */
export function bindSelectionScope(element: HTMLElement): () => void {
  // Focusable without tabbing: pointerdown focuses it so ⌘A resolves here.
  element.tabIndex = -1
  scopes.add(element)
  retainDocumentListeners()
  return () => {
    scopes.delete(element)
    activeDrags.delete(element)
    if (hoveredScope === element) hoveredScope = undefined
    releaseDocumentListeners()
  }
}
