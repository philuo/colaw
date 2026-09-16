/** Minimal type surface of the vendored foliate-js view web component (untyped upstream JS). */
import type { FoliateTocItem } from './epub.d.ts'

/** The paginator/fixed-layout renderer the view mounts. */
export interface FoliateRenderer {
  setAttribute(name: string, value: string): void
  goTo(target: unknown): Promise<unknown>
  prev(): Promise<unknown>
  next(): Promise<unknown>
  destroy(): void
}

/** Relocation detail emitted after each layout position change. */
export interface FoliateRelocateDetail {
  readonly fraction: number
  readonly location?: number
  readonly tocItem?: unknown
  readonly cfi: string
  readonly range?: Range
}

/** `<foliate-view>` — import registers the custom element as a side effect. */
export declare class FoliateView extends HTMLElement {
  open(book: unknown): Promise<void>
  init(options?: { readonly lastLocation?: string; readonly showTextStart?: boolean }): Promise<void>
  goTo(target: string | number): Promise<unknown>
  prev(): Promise<unknown>
  next(): Promise<unknown>
  close(): void
  readonly renderer: FoliateRenderer
  addEventListener(
    type: 'relocate',
    listener: (event: CustomEvent<FoliateRelocateDetail>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void
}
