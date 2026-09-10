// @vitest-environment jsdom
/**
 * The right sidebar's only expand/collapse control: one button pinned to the top
 * bar's right end, offering the open glyph while the panel is hidden and the
 * collapse glyph while it is shown, and keeping the same footprint in both
 * states so the bar never moves while the panel slides past it.
 */
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarToggleButton } from '../src/client/shell/SidebarToggle.tsx'
import type { SidebarToggleButtonProps } from '../src/client/shell/SidebarToggle.tsx'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 's-test' as SessionId

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/**
 * Mount the button over a real store instance. It reads four of its props; the
 * rest of the standard kit is framework-injected and never touched here, so one
 * documented cast keeps the harness to what is actually exercised.
 */
function mountButton() {
  const instance = createSidebarRightStore(() => 'Start').create()
  const props = {
    sessionId: SESSION,
    useStore: hookOf(instance),
    actions: instance.actions,
    // Copy is the dictionary's contract; the key stands in for the translation.
    t: (key: string) => key,
  } as unknown as SidebarToggleButtonProps
  const view = render(<SidebarToggleButton {...props} />)
  const control = (): HTMLElement => {
    const node = view.container.querySelector<HTMLElement>('[data-sidebar-right-toggle]')
    if (node === null) throw new Error('expected the sidebar toggle control')
    return node
  }
  return { instance, view, control }
}

describe('SidebarToggleButton', () => {
  it('offers the way in while the session has no surface yet, and asks the panel to expand', () => {
    const { instance, control } = mountButton()
    const button = control()
    expect(button.getAttribute('aria-label')).toBe('chrome.expand')
    expect(button.getAttribute('data-sidebar-right-toggle')).toBe('expand')
    fireEvent.click(button)
    expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(true)
  })

  it('flips to the collapse glyph while the panel is shown, and asks it to collapse', () => {
    const { instance, control } = mountButton()
    act(() => { instance.actions.setExpanded(SESSION, true) })
    const button = control()
    expect(button.getAttribute('aria-label')).toBe('chrome.collapse')
    expect(button.getAttribute('data-sidebar-right-toggle')).toBe('collapse')
    fireEvent.click(button)
    expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(false)
  })

  it('is resident across both states, so the bar never moves while the panel slides', () => {
    const { instance, control, view } = mountButton()
    const button = control()
    act(() => { instance.actions.setExpanded(SESSION, true) })
    expect(control()).toBe(button)
    expect(view.container.querySelector('[data-sidebar-right-expand-placeholder]')).toBeNull()
  })
})
