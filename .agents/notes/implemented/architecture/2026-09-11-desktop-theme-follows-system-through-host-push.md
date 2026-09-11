# Agent Note: Desktop theme follows the system through a host-pushed color scheme

Status: implemented

English | [中文](2026-09-11-desktop-theme-follows-system-through-host-push.zh.md)

## Problem

A `system` theme preference in the desktop shell painted the dark theme while macOS was in Light Mode, and kept whatever color scheme the app launched with. Two causes stacked:

- The webview's `prefers-color-scheme` reports the app-level AppKit appearance. That appearance may be forced by an explicit preference, and re-setting it under live views raises an Objective-C exception that aborts the process — so it is set once, before the first window, and stays frozen all session. A `system` preference following the media query therefore follows the frozen value: an explicit `dark` launch keeps reporting dark after macOS switches to light, and after the user switches the preference back to `system`.
- The icon poll read `effectiveAppearance` — the frozen answer — so the Dock icon followed the same launch-time snapshot.

## Decision

The host owns the resolved color scheme and pushes it; the client prefers it over the media query inside desktop shells.

- `app-appearance.ts` gains `systemIsDark()`, reading the `AppleInterfaceStyle` preference through `NSUserDefaults`. That is the system's own setting, unaffected by the app-level pin. Both the icon and the page appearance resolve `system` through it; `isDarkAppearance()` (the frozen effective answer) is deleted.
- The host injects `__DSH_DESKTOP_APPEARANCE__` (`'light' | 'dark'`) as an index-injection global — the first paint is correct — and the existing native-chrome tick pushes changes into the page (`window.__DSH_DESKTOP_APPEARANCE__ = …` plus a `dsh:desktop-appearance` event), the same channel fullscreen state uses. The tick covers both sources of change: a settings write and macOS switching under a `system` preference, each within the 2 s poll.
- `ui-theme`'s client resolves `system` through the pushed value when present (`environmentDark`), falling back to `prefers-color-scheme` in browsers and headless runs, and re-publishes on the desktop event; the boot-theme inline script applies the same priority before first paint.

The app-level AppKit appearance stays as it was: forced once at launch for explicit preferences, `nil` for `system` (whose page-side correctness no longer depends on it).

### Build-chain requirement this exposed

Client bundles build from the client face's compiled `lib/types/client/*.js`, never from `src`. A pack (or any rebuild) that runs tsdown's client pass without `tsc -b tsconfig.client.json` first ships the previous client build silently — the host-side change arrives while the client-side half of a paired change does not. `pack-stable-app.ts` runs both faces' `tsc` before both `tsdown` passes.

## Alternatives considered

- **Re-apply `NSApp.appearance` on change.** Rejected: the live-view exception cannot unwind through FFI and kills the process; the frozen-appearance constraint is recorded from a real crash.
- **Rely on `prefers-color-scheme` with `appearance = nil`.** Rejected: an explicit `dark`/`light` launch still pins the media query, and un-pinning at runtime is the same forbidden call.

## Consequences

- `system` follows the real system setting within one poll tick, in the page and the Dock icon, even when the app-level appearance is pinned by an earlier explicit choice in the same session.
- Explicit `light`/`dark` preferences behave as before: page, icon, and (at launch) the app-level appearance all agree.
- The webview's media query remains wrong while pinned; anything else reading `prefers-color-scheme` in the desktop shell must go through the pushed value instead (the fullscreen push is the established precedent for host-owned page state).
