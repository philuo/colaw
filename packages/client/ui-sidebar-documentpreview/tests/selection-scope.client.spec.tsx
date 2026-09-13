// @vitest-environment jsdom
/**
 * Selection scoping: a preview tab's body keeps drags and ⌘A inside itself —
 * never the app chrome, the chat, or the sibling pane's preview in split view.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { bindSelectionScope } from '../src/client/selection-scope.ts'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})

/** One pane: a scope body holding selectable text, beside some foreign text. */
function pane(id: string): { scope: HTMLElement; text: Text; chatBefore: HTMLElement } {
  // The foreign text sits BEFORE the scope so an outside→inside range is in
  // document order (jsdom normalizes inverted ranges, which would mask the
  // behavior under test).
  const chatBefore = document.createElement('p')
  chatBefore.append(document.createTextNode(`${id}-chat-text`))
  const scope = document.createElement('div')
  scope.dataset.pane = id
  const text = document.createTextNode(`${id}-preview-text`)
  scope.append(text)
  document.body.append(chatBefore, scope)
  return { scope, text, chatBefore }
}

function pressSelectAll(target: Node = document.body): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'a', metaKey: true, bubbles: true, cancelable: true,
  })
  Object.defineProperty(event, 'target', { value: target })
  document.dispatchEvent(event)
  return event.defaultPrevented
}

function selectionInside(scope: HTMLElement): boolean {
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  return scope.contains(range.commonAncestorContainer)
    && range.toString().includes(`${scope.dataset.pane}-preview-text`)
}

describe('selection scope', () => {
  it('⌘A with the focus inside one pane selects that pane only', () => {
    const a = pane('a')
    const b = pane('b')
    const disposeA = bindSelectionScope(a.scope)
    const disposeB = bindSelectionScope(b.scope)
    a.scope.focus()

    expect(pressSelectAll(a.scope)).toBe(true)
    expect(selectionInside(a.scope)).toBe(true)
    expect(document.getSelection()?.toString()).toContain('a-preview-text')
    expect(document.getSelection()?.toString()).not.toContain('b-preview-text')
    expect(document.getSelection()?.toString()).not.toContain('chat-text')
    disposeA()
    disposeB()
  })

  it('⌘A with no focus resolves to the pane under the pointer', () => {
    const a = pane('a')
    const b = pane('b')
    const disposeA = bindSelectionScope(a.scope)
    const disposeB = bindSelectionScope(b.scope)
    // No focus anywhere: the pointer over pane B makes B the pane in use.
    fireEvent.pointerOver(b.scope)

    expect(pressSelectAll()).toBe(true)
    expect(selectionInside(b.scope)).toBe(true)
    expect(document.getSelection()?.toString()).not.toContain('a-preview-text')
    disposeA()
    disposeB()
  })

  it('an editable keeps its own ⌘A — nothing is hijacked', () => {
    const a = pane('a')
    const dispose = bindSelectionScope(a.scope)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    expect(pressSelectAll(input)).toBe(false)
    // The pane's content was not selected in the editable's place.
    expect(selectionInside(a.scope)).toBe(false)
    dispose()
  })

  it('a drag that began inside a pane is clamped back to the pane', () => {
    const { scope, text, chatBefore } = pane('a')
    const a = { scope, text }
    const dispose = bindSelectionScope(scope)
    const chat = chatBefore
    fireEvent.pointerDown(scope)

    // A selection reaching from the chat text into the pane's text — the
    // escape a drag across the boundary produces.
    const selection = document.getSelection()
    const range = document.createRange()
    range.setStart(chat.firstChild as Text, 0)
    range.setEnd(a.text, 'a-preview-text'.length)
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    // jsdom stringifies only whole-container ranges, so the clamp is asserted
    // structurally: both boundary points land inside the pane's scope, which
    // the chat-originated range's start point was not.
    const clamped = document.getSelection()
    expect(clamped?.rangeCount).toBe(1)
    const settled = clamped!.getRangeAt(0)
    expect(a.scope.contains(settled.startContainer)).toBe(true)
    expect(a.scope.contains(settled.endContainer)).toBe(true)
    expect(a.scope.contains(settled.commonAncestorContainer)).toBe(true)
    dispose()
  })

  it('a drag that began outside is left untouched', () => {
    const { scope, text, chatBefore } = pane('a')
    const a = { scope, text }
    const dispose = bindSelectionScope(scope)
    const chat = chatBefore
    // pointerdown on the chat text, not on the scope.
    fireEvent.pointerDown(chat)

    const selection = document.getSelection()
    const range = document.createRange()
    range.setStart(chat.firstChild as Text, 0)
    range.setEnd(a.text, 4)
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    // Untouched: the range still begins in the chat text where the drag began.
    const untouched = document.getSelection()
    expect(untouched?.rangeCount).toBe(1)
    expect(untouched!.getRangeAt(0).startContainer).toBe(chat.firstChild)
    dispose()
  })
})
