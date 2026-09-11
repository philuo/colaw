# Agent Note: The stable app packages as analyzed, minified bundles over one shared module plane

Status: implemented

English | [中文](2026-09-11-stable-app-bundled-packaging.zh.md)

## Problem

`scripts/pack-stable-app.ts` built the stable desktop app by materializing the pnpm production closure into `Contents/Resources/app` (pnpm `deploy --prod --legacy`, a shameless hoist of every `.pnpm` package, vendor copies, and link re-aiming). The result was 452 MiB with three structural defects:

- **It shipped code the runtime never executes as code.** Workspace packages arrived as their published trees — `src/` for every package whose dev `files`/`exports` point there, every package's full `lib/` including unimported entries, tests and documentation removed only by a pruning allowlist that had to grow with every exception.
- **Its size was the dependency graph's, not the composition's.** The deploy walked manifest `dependencies` from the CLI anchor; the app boots one composed profile, so every package any profile could mount paid its way in.
- **Self-containment was structural, not verified.** The closure's symlinks were audited to stay inside the app, but client-module resolution walked from the profile directory through `~/.dsh/profiles/node_modules` — healed by the CLI, not by the app — so a clean machine could boot a stable app whose browser plugin graph resolved nowhere.

## Decision

The stable app is **bundled, not deployed**. `pack-stable-app.ts` composes the exact entry list the shipped profile mounts (web template bundles plus the Electrobun overlay, through `dsh-app-boot`'s own composition), then:

1. **Closure analysis by import walk, not manifest walk.** Seeds are the composed entry names, the two bundle packages, and the host entry file. Every scanned file contributes its imports (Bun `Transpiler.scanImports`, plus textual detection of `require.resolve('…')` literals and `new URL('./…', import.meta.url)` worker references, which no import table shows). A package nothing reaches is never shipped; the web profile closure is 262 packages against the deploy's whole-graph closure.
2. **One minified ESM bundle per package entry point** (`Bun.build`, tree-shaken, `minify: true`), with **every bare cross-package import external**, emitted into a flat `Resources/app/node_modules` tree of generated manifests plus bundled code. The loader's dynamic `import(name)` resolves through that tree by ordinary up-walking from the host bundle — the single-instance guarantee cordis `Symbol` keys require (the two-module-plane incident of 2026-09-09 is the failure mode this preserves against).
3. **The Electrobun build's fully-inlined dev main is replaced** by a host bundle built against the same external plane, so host code and plugin code share one copy of cordis and every other library. The Electrobun SDK ships as the `electrobun` package resolved from the Hutch devkit.
4. **Runtime data ships beside the code:** each package's non-code published files (bundle `cordis.patch.yml`, `presets/`, `assets/`, browser `lib/client.js` bundles — minified — the web frontend `dist/`, native `bin/*.node` for darwin-arm64 only), plus a generated `install/package.json` anchor whose flat dependency list names every shipped package.
5. **The host heals the module fallback on bundled boots** (`healProfilesModuleFallback` against the in-app anchor), making client-module resolution and out-of-tree plugins self-contained; dev and source runs keep the checkout plane.
6. **The stable copy sheds its dev markers** — `version.json` channel, `build.json` environment, and the `Colaw-dev` bundle name become `stable`/`Colaw`, so the Electrobun SDK's install-root name stops licensing the repository dev watcher on build machines.
7. **Audit gates the artifact:** no symlinks or TypeScript/source-map/metadata files under `Resources/app`, and every bare import of every emitted bundle must resolve inside the app (specifiers the repository install itself cannot resolve — sharp's cross-platform natives — are listed as unshipped optionals instead of failing).

### Resolutions the analysis must own

- **Manual `node_modules` walking, never Bun's resolver.** Bun applies tsconfig `paths` to every resolution style (`resolveSync`, `createRequire().resolve`), which would silently flip the analysis onto the src plane; the packer implements Node's parent-walk against package `exports` (exact, wildcard, and exports-less subpaths) itself.
- **Data-declared loader rows seed the closure.** Preset compositions are YAML entry lists the import graph never sees; a preset that names an unshipped plugin fails its rows at discovery (the "标准模式 加载失败" symptom) and, once shipped, mounts those plugins by name at session scope. Every closure package's shipped YAML is scanned for `name: '@scope/pkg'` rows and the named packages seed the walk, iterated to a fixpoint.
- **A shipped package's declared export surface ships.** Conventions resolve subpaths by name at runtime: typert-loader discovers `./typert` type graphs and **silently skips** packages whose export is absent, leaving the type graph empty with no diagnostic. Every non-wildcard code-target export of a non-browser package becomes a unit of its own. Packages declaring `dsh.client` are excluded — their node-plane surface has no runtime consumer, and seeding it would pull browser-only trees (shiki languages, katex, pdf workers) into the app.
- **CJS conditional dispatch ships verbatim.** A bundled CJS entry's runtime `require('./x.js')` (zod's v3/v4 switch) cannot be inlined; the target ships beside the unit like a worker file, and a verbatim record never overwrites a unit's bundled output at the same path.
- **The data copy never overwrites bundled output.** Runtime data files are the non-code files (plus the client bundle family, whose entry point the copy loop minifies); every other code file belongs to the unit or verbatim writer.
- **Version conflicts inline into the importer.** The first resolution of a name owns the root plane; a package whose files resolve a different version (negotiator 0.6/1.1) has that specifier removed from *its* bundle's externals, so `Bun.build` inlines the version its own resolution found. Nesting the losing copy under each importer was rejected as tree complexity for a case pnpm discipline keeps rare.
- **Optional dependencies absent from the install stay absent.** sharp's wasm32 fallback and every non-darwin-arm64 native are external and unshipped; the runtime meets the same resolution failure it meets today.

## Alternatives considered

- **Keep the deploy closure and prune harder.** Rejected: pruning is an allowlist chasing exceptions, `src/` cannot be removed while dev exports point at it, and the size floor remains the manifest graph's, not the composition's.
- **One mega-bundle for all plugins.** Rejected: the Electrobun dev main is fully inlined, so a plugins mega-bundle would hold a second copy of cordis next to the host's — the exact Symbol-split failure the two-plane incident recorded.
- **Nested node_modules emission for version conflicts.** Rejected: correct but multiplies tree shapes and manifest bookkeeping for a case the lockfile keeps rare; inlining the conflicting specifier into the one importer that resolves it is local and observable in the audit.

## Consequences

- The stable app measures **108 MiB** (66.6 shell + 41.4 bundles/data) against the deploy's 452 MiB, with zero symlinks and no TypeScript, source maps, or READMEs under `Resources/app`.
- Per-package tree-shaking is real but per-package: a package ships as one unit per entry point actually imported, and unreferenced `lib/` entries are dropped. Same-package sibling units can duplicate internal modules between them; no such subpath pair exists in the web profile today.
- Verbatim-shipped code files (worker entrypoints addressed by string URL) are minified when `Bun.build` accepts them and copied byte-for-byte when it does not.
- The full chain (`tsc` host face, tsdown host and client faces, Vite, Electrobun build, analysis, emission, audit) is exercised by `pnpm run build:app:stable`; smoke acceptance is a fresh-`DSH_HOME` launch reaching `dsh core booted` with a populated `__DSH_BOOT__` and a served client bundle batch.
- Client browser bundles are minified in the pack step; the client face build itself is unchanged, so dev and snapshot flows are unaffected.
