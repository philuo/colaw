/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  // The Office viewers must ride the shell's Vite pipeline rather than the
  // tsdown client bundle, for one hard reason: the library spawns its render
  // worker through `new Worker(new URL('./render-worker-host-*.js',
  // import.meta.url), { type: 'module' })`, and only Vite both emits that chunk
  // and rewrites the URL so it resolves. In the tsdown CJS bundle the URL
  // compiles away to an empty string, so the library's documented `mode:
  // 'worker'` (which keeps pagination and painting off the UI thread — the
  // difference between a fluid and a stuttering Word zoom) fails at load.
  '@silurus/ooxml/docx',
  '@silurus/ooxml/pptx',
  '@silurus/ooxml/xlsx',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
