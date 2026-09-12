import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-sidebar-documentpreview', ['lib/types/index.js'])
const require = createRequire(import.meta.url)
const workerSpecifier = 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
const workerModule = '\0dsh-pdf-worker.mjs'

/** License files for PDF.js and the data embedded beside its runtime. */
function pdfLicenseFiles(root: string): string[] {
  return ['LICENSE', ...['cmaps', 'standard_fonts', 'wasm'].flatMap(directory =>
    readdirSync(join(root, directory)).filter(name => name.startsWith('LICENSE')).sort()
      .map(name => `${directory}/${name}`),
  )]
}

/** Keep every bundled PDF.js license visible in the published client artifact. */
function pdfLicenseBanner(): string {
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  const notice = pdfLicenseFiles(root).map(name =>
    `${name}\n\n${readFileSync(join(root, name), 'utf8').trimEnd()}`,
  ).join('\n\n')
  return ['//! Bundled PDF.js license notices', ...notice.split('\n').map(line => `// ${line}`)].join('\n')
}

/** Keep font mappings and image decoders in the same artifact as their PDF.js runtime. */
function pdfAssets(): string {
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  return JSON.stringify(Object.fromEntries([
    ['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm'],
  ].map(([kind, directory]) => [kind, Object.fromEntries(
    readdirSync(join(root, directory!)).filter(name => !name.startsWith('LICENSE')).sort()
      .map(name => [name, readFileSync(join(root, directory!, name)).toString('base64')]),
  )])))
}

/** The parser payload filenames the Office renderers fetch through their `wasmUrl` option. */
const OOXML_FORMATS = ['docx', 'pptx', 'xlsx'] as const

/**
 * The installed package root, derived from its entry module: the package does
 * not export a `./package.json` subpath, so a manifest resolve throws under
 * strict ESM resolution (the notices generator loads this config file).
 */
function ooxmlPackageRoot(): string {
  return dirname(dirname(require.resolve('@silurus/ooxml')))
}

/** Keep every parser in the same artifact as the runtime that fetches it. */
function ooxmlAssets(): string {
  const dist = join(ooxmlPackageRoot(), 'dist')
  return JSON.stringify(Object.fromEntries(OOXML_FORMATS.map(format =>
    [format, readFileSync(join(dist, `${format}_parser_bg.wasm`)).toString('base64')])))
}

/** The MIT license text must stay visible in the artifact that carries the parsers. */
function ooxmlLicenseBanner(): string {
  const notice = readFileSync(join(ooxmlPackageRoot(), 'LICENSE'), 'utf8').trimEnd()
  return ['//! Bundled @silurus/ooxml license notice', ...notice.split('\n').map(line => `// ${line}`)].join('\n')
}

/**
 * The client loader evaluates each bundle with `new Function`, where
 * `import.meta` is a parse error, and every emitted chunk beside `client.js`
 * would be dead weight the package walk does not ship. The library's
 * module-URL references are exactly such dead paths here: the parser payload
 * arrives through the inlined `wasmUrl` blob, and its worker source is
 * inlined beside the format code. Rewrite the URL expressions to inert
 * strings and force one single-file bundle.
 */
const ooxmlModuleUrl: NonNullable<UserConfig['plugins']> = [{
  name: 'dsh-ooxml-module-url',
  transform(code, id) {
    if (!id.includes('@silurus/ooxml')) return null
    const next = code.replace(/new URL\((["'])([^"'`]*)\1,\s*import\.meta\.url\)(?:\.href)?/g, '""')
    return next === code ? null : { code: next, map: null }
  },
}]

/** The dynamic client factory has no module URL from which to resolve a Worker file. */
const pdfWorker: NonNullable<UserConfig['plugins']> = [{
  name: 'dsh-pdf-worker-source',
  resolveId(source) {
    return source === workerSpecifier ? workerModule : null
  },
  load(id) {
    if (id !== workerModule) return null
    const path = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    this.addWatchFile(path)
    return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`
  },
}]

export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true ? {
    ...config,
    banner: [pdfLicenseBanner(), ooxmlLicenseBanner()].join('\n'),
    outputOptions: { ...config.outputOptions, inlineDynamicImports: true, chunkFileNames: 'client-chunk-[name]-[hash].cjs' },
    plugins: [config.plugins, pdfWorker, ooxmlModuleUrl],
    define: {
      ...config.define,
      __DSH_PDFJS_ASSETS__: pdfAssets(),
      __DSH_OOXML_WASM__: ooxmlAssets(),
    },
  } : config,
)
