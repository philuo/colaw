/** The app-wide selection policy: the shell is inert, content opts back in. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/design-platform.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Match one rule by its exact selector list. `[^}]` keeps a match inside a
 * single block, so a property check cannot be satisfied by a later rule.
 * @param selector - selector list as written in the sheet.
 * @returns a global regular expression for that rule.
 */
function rule(selector: string): RegExp {
  const escaped = selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s*')
  return new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 'g')
}

const bodies = (selector: string): string[] => [...css.matchAll(rule(selector))].map(match => match[0])

/**
 * Whether a rule declares the UNPREFIXED property. A plain `includes` would be
 * satisfied by the `-webkit-` twin, which is exactly the declaration this guard
 * must not accept in its place.
 * @param body - one rule's declarations.
 * @param value - the value the property must carry.
 * @returns true when the unprefixed declaration is present.
 */
const declares = (body: string, value: string): boolean =>
  new RegExp(`(?<![-\\w])user-select:\\s*${value}`).test(body)

describe('design-platform.css selection policy', () => {
  it('makes every element inert by default, so chrome needs no rule of its own', () => {
    // Per element, not on `html, body`: this WebKit resolves `user-select` on
    // the element itself, so an inherited `none` does not reach a descendant the
    // UA sheet gave its own value.
    expect(bodies('*, *::before, *::after').some(body => declares(body, 'none'))).toBe(true)
  })

  it('keeps text entry selectable', () => {
    const entry = bodies(":is(input, textarea, [contenteditable='true'], [contenteditable=''])")
    expect(entry).toHaveLength(1)
    expect(declares(entry[0] ?? '', 'text')).toBe(true)
  })

  it('lets a content surface opt back in, itself and everything inside it', () => {
    // `:where()` is load-bearing: a component's own `user-select: none` (code
    // gutters, line numbers) must still win on the elements it owns. The
    // descendant half is what carries the opt-in past the `*` reset.
    const optIn = bodies(':where([data-dsh-selectable]), :where([data-dsh-selectable]) *')
    expect(optIn).toHaveLength(1)
    expect(declares(optIn[0] ?? '', 'text')).toBe(true)
  })

  it('keeps controls and media out of both selection and drag', () => {
    const chrome = bodies("button, a, img, svg, [role='button']")
    expect(chrome).toHaveLength(1)
    expect(declares(chrome[0] ?? '', 'none')).toBe(true)
    expect(chrome[0]).toContain('-webkit-user-drag: none')
  })

  it('stops the root from rubber-banding the composer out of place', () => {
    expect(bodies('html, body').some(body => body.includes('overscroll-behavior: none'))).toBe(true)
  })
})
