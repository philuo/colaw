import { describe, expect, it } from 'vitest'
import { assertErasableTypeScript, blankOutCommentsAndStrings } from '../src/erasable.ts'

describe('erasable-syntax guard', () => {
  it.each([
    'const answer: number = 1',
    'type T = { a: number }',
    'interface I { a: number }',
    'function f<T extends object>(value: T): T { return value }',
    'const x = value as unknown as string',
    'const y = { a: 1 } satisfies Record<string, number>',
    'await import("node:fs")',
    // A `declare` declaration is erased, so it stays erasable.
    'declare enum E { A }',
    'declare namespace N { const x: number }',
    'declare module "m" { const x: number }',
    // Ordinary identifier use is not a declaration.
    'module.exports = {}',
    'const publicFlag = true',
    'class C { constructor(options: { public?: boolean }) {} }',
    'class C { constructor(x: number) {} }',
  ])('accepts erasable TypeScript: %s', (program) => {
    expect(() => assertErasableTypeScript(program)).not.toThrow()
  })

  it.each([
    ['enum E { A }', 'enum'],
    ['const enum E { A }', 'enum'],
    ['export enum E { A }', 'enum'],
    ['namespace N { export const x = 1 }', 'namespace'],
    ['module M { export const x = 1 }', 'namespace'],
    ['import fs = require("node:fs")', 'import equals'],
    ['export = { a: 1 }', 'export assignment'],
    ['class C { constructor(private x: number) {} }', 'parameter property'],
    ['class C { constructor(readonly x: number) {} }', 'parameter property'],
  ])('refuses non-erasable TypeScript: %s', (program, construct) => {
    expect(() => assertErasableTypeScript(program)).toThrow(construct)
  })

  it('ignores declarations written inside comments and strings', () => {
    expect(() => assertErasableTypeScript('// enum E { A }')).not.toThrow()
    expect(() => assertErasableTypeScript('/* namespace N { } */')).not.toThrow()
    expect(() => assertErasableTypeScript('const s = "enum E { A }"')).not.toThrow()
    expect(() => assertErasableTypeScript('const t = `module M { }`')).not.toThrow()
  })

  it('blanks comments and strings without moving offsets', () => {
    const code = 'const a = "text"; // enum E { A }'
    const blanked = blankOutCommentsAndStrings(code)
    expect(blanked).toHaveLength(code.length)
    expect(blanked.startsWith('const a =')).toBe(true)
    expect(blanked).not.toContain('enum')
    expect(blanked).not.toContain('text')
  })
})
