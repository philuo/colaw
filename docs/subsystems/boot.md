# Profile management

English | [中文](boot.zh.md)

The [boot package group](../../packages/boot/README.md) owns launcher-provided profile data and coordinated reloads. `dsh-app-boot` resolves environment, profile and patch layers into a running Loader and identifies the failing plugin when boot cannot start. `dsh-hmr` queues module replacements, Include refreshes and profile configuration changes through one reload queue; existing Cordis HMR configuration and events remain available under `ctx.hmr`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)
<!-- END GENERATED cordis-surface -->
