/**
 * Models section stylesheet contract, asserted against the CSS text on disk.
 *
 * The section paints in both themes, and a `--dsw-*` name the theme does not
 * declare fails silently: the browser takes the `var()` fallback, so the sheet
 * still renders and only the dark theme looks wrong. Checking the names against
 * the sheet that declares them is what turns that into a test failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build.
// Every theme sheet, not just the platform tokens: font and scrollbar
// variables are declared in siblings, and a gate reading one file would call
// their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/** The sheet without comments, so a rule cannot be answered by prose. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of one top-level rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`ModelsSection.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/**
 * The declarations of the one rule whose selector list is exactly `selectors`,
 * for the grouped rules `block` cannot address (`a { … }` vs `a,\nb { … }`).
 * Naming the whole list picks the rule apart from the per-class blocks that
 * override it, which is where a shared base's shape belongs.
 * @param selectors - every selector of the rule, in sheet order, spelled exactly as in the sheet.
 * @returns the rule's declaration text.
 */
function rule(selectors: readonly string[]): string {
  for (const match of bare.matchAll(/(?:^|\n)([^{}@/][^{}]*)\{([^}]*)\}/g)) {
    const parts = (match[1] ?? '').split(',').map(part => part.trim())
    if (parts.length === selectors.length && parts.every((part, index) => part === selectors[index])) {
      return match[2] ?? ''
    }
  }
  throw new Error(`ModelsSection.module.css has no \`${selectors.join(', ')}\` rule`)
}

describe('ModelsSection theme styles', () => {
  it('names only theme variables the token sheet defines', () => {
    // A `--dsw-*` name the sheet never declares is not a near miss: it silently
    // resolves to whatever literal sits in its fallback slot, which is how this
    // section stayed light under the dark theme before. Undeclared names have
    // no fallback at all and inherit, so both spellings must fail here.
    // Every theme-variable prefix the sheets actually use, not just `--dsw-`:
    // a `--dsh-` name reads as a plausible sibling and would otherwise slip
    // past this gate into a fallback literal.
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    // A missing `}` on an `@media` block is not a parse error: every rule after
    // it silently becomes conditional, and the whole fetch dialog once painted
    // unstyled for anyone whose system does not ask for reduced motion. Nothing
    // downstream reports this — the sheet loads and the classes still attach.
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })

  it('separates the row card from the editor it expands into', () => {
    // `bg-layer-3` and `bg-module-platform` both resolve to neutral-bluish-800
    // under the dark theme, so filling the row with either erases the nested
    // editor's boundary. The row is outlined; the fill is the editor's alone.
    expect(block('.editor')).toContain('background: var(--dsw-alias-bg-module-platform)')
    expect(block('.rowCard')).toContain('border: 0.5px solid var(--dsw-alias-border-l4)')
    expect(block('.rowCard')).not.toMatch(/\bbackground\s*:/)
  })

  it('gives every dropdown the shared chevron instead of the OS arrow', () => {
    // `select.input` caps the control at 240px, and the OS arrow is painted
    // flush inside that shrunk right edge — visibly tighter than every other
    // control on the page. `.selectInput` is what removes it, reserves the
    // right pad, and paints the shared chevron; a `<select>` that takes
    // `.input` alone silently keeps the OS one.
    const sources = readdirSync(fileURLToPath(new URL('../src/client/', import.meta.url)))
      .filter(name => name.endsWith('.tsx'))
      .map(name => ({
        name,
        text: readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8'),
      }))
    const bare = sources.flatMap(({ name, text }) => text
      .split('<select')
      .slice(1)
      // The element's own attributes end at the first `>`; a child `<option>`
      // carries no className of its own and must not answer for the select.
      .map(rest => rest.slice(0, rest.indexOf('>')))
      .filter(attributes => !attributes.includes('selectInput'))
      .map(() => name))
    expect(bare).toEqual([])
  })

  it('keeps the add slot off the shared capsule it reuses', () => {
    // `.addButton` rides the shared base to inherit box-sizing/font/cursor, so
    // a shape change on the add affordance was once written *into that base*:
    // Cancel and Apply came out 44px tall, dashed, and stretched to the row.
    // The two shapes must stay separable — the base is the 36px capsule, and
    // only `.addButton`'s own rule carries the dashed 44px slot.
    const base = rule(['.primaryButton', '.secondaryButton', '.addButton'])
    expect(base).toContain('height: 36px')
    expect(base).toContain('border-radius: 18px')
    expect(base).not.toMatch(/dashed\b/)
    expect(base).not.toMatch(/align-self\s*:/)
    expect(rule(['.secondaryButton'])).toContain('border: 0.5px solid var(--dsw-alias-border-l3)')

    const add = rule(['.addButton'])
    expect(add).toContain('height: 44px')
    expect(add).toContain('border: 1px dashed var(--dsw-alias-border-l3)')
    // `.addButton` is the only child of `.addBlock`, a *column*: a `flex` basis
    // there sizes the button's height, not its width, so the declared 44px box
    // collapses to the label's own line box. Stretching the slot is a layout
    // decision for `.addActions`/`align-self`, never a flex basis here.
    expect(add).not.toMatch(/\bflex(?:-(?:basis|grow|shrink))?\s*:/)
  })

  it('never falls back to a literal colour', () => {
    // A token that resolves is never the problem; an undeclared one takes this
    // branch, and a literal here is a single colour for both themes.
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })
})
