# Changelog

All notable changes to this project are documented here, newest first.
Each entry ships with a `vX.Y.Z` tag; the release workflow publishes the
matching GitHub Release with DMG, app zip, and the update feed.

## [1.0.4] — 2026-09-12

### Fixed

- **PDF preview failed on the desktop app** (`this.#g.getOrInsertComputed is
  not a function`). PDF.js 6 requires the Map upsert proposal
  (`getOrInsert`/`getOrInsertComputed`), and the WKWebView the app runs in
  lacks it (as well as `Promise.try` and the Set methods on older macOS
  builds) — every PDF open failed at parse time. The preview now installs
  idempotent shims on both sides of the worker boundary: the page realm
  imports `pdf/compat.ts` ahead of PDF.js, and the same shim source is
  prepended to the worker's Blob module. New regression coverage parses a
  real PDF with the APIs deleted from BOTH realms, reproducing the desktop
  failure shape; all 25 PDF spec cases pass. Verified end to end in the
  desktop app: the right-sidebar preview renders the sample PDF page.

## [1.0.3] — 2026-09-12

### Fixed

- **Trash "clear all" deleted nothing for sessions opened during the run.**
  `deleteArchivedSession` refused any session the host session store still
  held, but archiving does not evict it, so the residency probe rejected
  exactly the sessions the trash exists to delete — a clear aborted on its
  first entry with `workspace/trash-conflict`. The unimplementable probe is
  gone; `clearTrash` now sweeps every entry independently (one failure no
  longer abandons the rest) and aggregates survivors into a single conflict
  error. Host spec gains four trash regression cases.

## [1.0.2] — 2026-09-12

### Added

- Codex-style workspace chip on the New Session page: the bound posture
  shows folder + title with a hover-revealed filled circle-X remove
  affordance; the unbound posture keeps an existing-workspace picker with no
  detached row and no add-directory (Finder) entry. New Session defaults to
  no workspace — only an explicit sidebar group action or the current
  session's workspace preselects one. Removing or switching the bound
  workspace carries the unsubmitted draft. Startup reuses or creates a
  workspace-less blank session.
- `scripts/pack-stable-release.ts`: the local one-shot stable chain mirroring
  CI (pack → official `--env=stable` identity → DMG), leaving a directly
  runnable `Colaw.app` (no self-extraction popup on every repack) beside the
  official `Colaw.dmg` in `build/stable-macos-arm64/`, with no update feed
  baked locally.
