/**
 * Erasable-syntax guard for the Bun type-stripping fallback.
 *
 * Node's `module.stripTypeScriptTypes` refuses constructs that need code
 * generation, and the PTC program contract is erasable-only. Bun's `Transpiler`
 * generates code for those constructs instead, so the fallback must refuse them
 * itself or the documented contract would silently widen under Bun.
 * @module @deepseek-ai/dsh-ptc-runtime-node/erasable
 */

/**
 * One refused declaration form. Each pattern demands an unambiguous shape — a
 * declaration keyword, a name, and an opening brace, or a modifier followed by a
 * parameter name — so ordinary identifier use (`module.exports`, a `public` field
 * inside an object type) does not match.
 */
const NON_ERASABLE_FORMS: readonly { readonly pattern: RegExp; readonly construct: string }[] = [
  { pattern: /(?<![\w$.])(?:const\s+)?enum\s+[A-Za-z_$][\w$]*\s*\{/u, construct: 'enum' },
  { pattern: /(?<![\w$.])(?:namespace|module)\s+[A-Za-z_$][\w$]*\s*\{/u, construct: 'namespace' },
  { pattern: /(?<![\w$.])import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/u, construct: 'import equals' },
  { pattern: /(?<![\w$.])export\s*=\s*(?!=)/u, construct: 'export assignment' },
  { pattern: /(?<![\w$.])constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+[A-Za-z_$]/u, construct: 'parameter property' },
]

/** Characters that end an identifier, used to reject a property-access match. */
const WORD_CHARACTER = /[\w$]/

/**
 * Replace every comment and string body with spaces, preserving offsets and line
 * breaks so a later match's index still describes the original source.
 *
 * A template literal's `${}` interpolations are blanked with the rest of the
 * literal. A non-erasable declaration written only inside an interpolation is
 * therefore not refused — a missed rejection, never a false one.
 *
 * @param code - the source to blank.
 * @returns an equal-length string whose comments and strings hold spaces.
 */
export function blankOutCommentsAndStrings(code: string): string {
  const out = code.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index++) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }
  let index = 0
  while (index < code.length) {
    const char = code[index]
    const next = code[index + 1]
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2)
      const stop = end === -1 ? code.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1
      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (code[cursor] === char) break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, code.length)
      blank(index, stop)
      index = stop
      continue
    }
    index += 1
  }
  return out.join('')
}

/**
 * Whether the token immediately before `index` is `declare`, which erases the
 * declaration that follows it and therefore keeps the form erasable.
 *
 * @param source - comment- and string-blanked source.
 * @param index - the match's start offset.
 * @returns true when only whitespace and the `declare` keyword precede it.
 */
function isDeclareOnly(source: string, index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0 && /\s/u.test(source[cursor] as string)) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && WORD_CHARACTER.test(source[cursor] as string)) cursor -= 1
  return source.slice(cursor + 1, end) === 'declare'
}

/**
 * Refuse TypeScript that strip-only mode cannot erase.
 *
 * @param code - the program source about to be stripped.
 * @throws when the source contains a declaration that needs code generation.
 */
export function assertErasableTypeScript(code: string): void {
  const source = blankOutCommentsAndStrings(code)
  for (const { pattern, construct } of NON_ERASABLE_FORMS) {
    const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/gu, '')}g`)
    for (let match = matcher.exec(source); match !== null; match = matcher.exec(source)) {
      if (isDeclareOnly(source, match.index)) continue
      throw new Error(`non-erasable TypeScript is not supported in strip-only mode: ${construct}`)
    }
  }
}
