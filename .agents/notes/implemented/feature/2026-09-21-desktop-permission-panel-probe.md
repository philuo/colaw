# Agent Note: The 电脑操控 permission panel probes the host's own TCC state

Status: implemented

English | [中文](2026-09-21-desktop-permission-panel-probe.zh.md)

Supersedes in part the TODO in the original desktop-tab wiring ("the typert endpoint lands with the next remote round"): the `desktopPermissions` remote now has a generated client contribution, and the section's `loadPermissions` stub is gone.

## Problem

The 电脑操控 tab's macOS permission panel rendered 检测中… forever: the client-side loader was an explicit stub, the host controller existed only behind a `package.json` export no artifact backed, and the generated remote contract had no client mount. The panel could not express which grants Colaw.app held, and the System Settings deep-link was unreachable (it renders only for an answered probe).

## Decision

- `DesktopPermissionsController` declares its `@Remote` boundary type in `./types` and its `package.json` exports `./typert` plus `./remote` exactly as the generator's validator requires; the workspace build emits `lib/typert.remote-client.js`.
- The generated contribution mounts in the platform-neutral client assembly (`packages/api/remotes/src/client`), so `ctx.remote.desktopPermissions.{status,openPermissionSettings}` is callable from the 电脑操控 tab.
- The client bundle isolation gate gained one narrow exception: generated `lib/typert.remote-client.*` artifacts of experimental packages may enter client bundles. They are model-driven schema descriptors with none of the owning package's runtime — the experimental-runtime ban itself is unchanged.
- The section store holds the probe answer; every tab mount re-probes, and the Settings deep-link returns a fresh answer. A rejected call leaves the answer unset (检测中…) — an honest "no probe has answered" that the next mount retries — instead of a stale granted/missing claim.

## Consequences

The panel now expresses real TCC state, including a grant the user just made in System Settings (the deep-link re-probes). A host without the desktop bundle answers `not ok` for every probe, and the panel keeps 检测中… for that profile — visible, honest, and retried on each visit. The client bundle now carries the generated contract of an experimental package; the isolation-gate exception is the reviewed seam, and moving the remote into a non-experimental package is the fallback if experimental runtime ever leaks through it.

## Alternatives considered

- **Keep the stub and hide the panel until the endpoint "lands".** The endpoint existed host-side; hiding the panel kept a permission surface invisible while the provider shipped, the worst of both postures.
- **Move the controller into a non-experimental api package.** Cleanest against the isolation rule, but it splits the controller from the native SDK seam it drives and adds a package for two methods; the generated-artifact exception achieves the same client guarantee without the split.

## Testing

`packages/client/ui-settings-desktop/tests/section.client.spec.tsx` pins the checking/granted/missing render states over the slot store and the mount-time probe; the connection fixture answers `desktopPermissions/*`; `build:lib:client` fails unless the isolation exception and the emitted artifact agree.
