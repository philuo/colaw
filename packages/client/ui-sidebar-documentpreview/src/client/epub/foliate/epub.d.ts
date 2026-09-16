/** Minimal type surface of the vendored foliate-js EPUB parser (untyped upstream JS). */
export interface FoliateTocItem {
  readonly label: string
  readonly href: string
  readonly subitems?: readonly FoliateTocItem[]
}

/** One spine section; loading is lazy and reversible. */
export interface FoliateSection {
  readonly id: string
  load(): Promise<Document>
  unload(): void
  createDocument(): Promise<Document>
  readonly size: number
  readonly linear?: string
}

/** The metadata block foliate exposes (subset this package reads). */
export interface FoliateMetadata {
  readonly title?: string
  readonly language?: readonly string[] | string
  readonly identifier?: string
  readonly author?: readonly string[] | string
  readonly [key: string]: unknown
}

/** The EPUB book foliate's EPUB.init() produces. */
export declare class EPUB {
  constructor(loader: {
    loadText(name: string): Promise<string | null> | string | null
    loadBlob(name: string, type?: string): Promise<Blob | null> | Blob | null
    getSize(name: string): number
  })
  init(): Promise<EPUB>
  readonly sections: readonly FoliateSection[]
  readonly toc: readonly FoliateTocItem[]
  readonly pageList: readonly FoliateTocItem[]
  readonly metadata: FoliateMetadata
  readonly rendition?: { readonly layout?: string }
  splitTOCHref(href: string): readonly string[]
  getTOCFragment(doc: Document, id: readonly string[]): Element | null
}
