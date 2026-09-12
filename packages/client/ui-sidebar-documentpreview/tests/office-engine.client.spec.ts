/**
 * The real parser, driven end to end: a minimal-but-genuine `.xlsx` (zip of
 * OOXML parts, no helper library beyond fflate) parses through the actual
 * Rust/WebAssembly payload. This is the evidence that the blob-URL `wasmUrl`
 * wiring reaches real parsing, not just the type surface — the same pipeline
 * the client bundle ships, fed from the installed parser instead of the
 * inlined define.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { XlsxWorkbook } from '../src/client/office/runtime.ts'

afterEach(() => { vi.unstubAllGlobals() })

const requireHere = createRequire(import.meta.url)
const parserRoot = dirname(requireHere.resolve('@silurus/ooxml/package.json'))

/** The installed xlsx parser, materialized the way the bundled artifact does it. */
function parserUrl(): string {
  const bytes = new Uint8Array(readFileSync(join(parserRoot, 'dist', 'xlsx_parser_bg.wasm')))
  return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }))
}

/** The smallest workbook Excel's own grammar accepts: two rows, inline strings, no shared parts. */
function minimalXlsx(): ArrayBuffer {
  return zipSync({
    '[Content_Types].xml': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
      '</Types>',
    ].join('')),
    '_rels/.rels': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
      '</Relationships>',
    ].join('')),
    'xl/workbook.xml': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheets><sheet name="评审" sheetId="1" r:id="rId1"/></sheets>',
      '</workbook>',
    ].join('')),
    'xl/_rels/workbook.xml.rels': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '</Relationships>',
    ].join('')),
    'xl/styles.xml': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
      '<borders count="1"><border/></borders>',
      '<cellStyleXfs count="1"><xf/></cellStyleXfs>',
      '<cellXfs count="1"><xf/></cellXfs>',
      '</styleSheet>',
    ].join('')),
    'xl/worksheets/sheet1.xml': strToU8([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetData>',
      '<row r="1"><c r="A1" t="inlineStr"><is><t>任务</t></is></c><c r="B1"><v>42</v></c></row>',
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Office</t></is></c><c r="B2"><v>3.5</v></c></row>',
      '</sheetData>',
      '</worksheet>',
    ].join('')),
  }).buffer as ArrayBuffer
}

describe('Office WebAssembly parsers', () => {
  it('parses a genuine workbook through the blob-URL wasmUrl pipeline', async () => {
    // The viewer's resolution paths read browser globals; the parse itself is
    // environment-neutral once the payload has a same-origin URL.
    vi.stubGlobal('location', new URL('http://127.0.0.1:3090/'))
    const workbook = await XlsxWorkbook.load(minimalXlsx(), { wasmUrl: parserUrl() })
    try {
      expect(workbook.sheetCount).toBe(1)
      expect(workbook.sheetNames).toEqual(['评审'])
      const worksheet = await workbook.getWorksheet(0)
      const cells = worksheet.rows.flatMap(row => row.cells)
      expect(cells.find(cell => cell.row === 1 && cell.col === 1)?.value).toMatchObject({ type: 'text', text: '任务' })
      expect(cells.find(cell => cell.row === 2 && cell.col === 1)?.value).toMatchObject({ type: 'text', text: 'Office' })
      expect(cells.find(cell => cell.row === 1 && cell.col === 2)?.value).toMatchObject({ type: 'number', number: 42 })
    } finally {
      workbook.destroy()
    }
  })
})
