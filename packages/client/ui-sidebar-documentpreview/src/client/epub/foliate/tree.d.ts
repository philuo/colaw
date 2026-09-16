/** Minimal type surface of the vendored foliate-js TOC tree (untyped upstream JS). */
import type { FoliateTocItem } from './epub.d.ts'

/** `<ol role="tree">` TOC view; call setCurrentHref on relocate to track position. */
export declare function createTOCView(
  toc: readonly FoliateTocItem[],
  onclick: (href: string) => void,
): {
  readonly element: HTMLElement
  setCurrentHref(href: string): void
}
