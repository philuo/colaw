---
description: "The process-sandbox package group: the confinement seam, per-platform backends, and the shared policy resolver."
kind: "package-group"
---

# packages/sandbox

English | [中文](README.zh.md)

## Summary

The `sandbox/` group confines subprocess execution to a file-effect policy: commands run `read-only`, write only under the session workspace (`workspace-write`), or run unrestricted (`danger-full-access`). Three packages deliver it: the confinement service (`sandbox/`), the per-platform backends for Linux and macOS (`sandbox-local/`), and the shared policy resolver (`sandbox-policy/`). A confined call that a policy denies can retry through a user-approved one-time escalation. Confinement is same-world only: it shares the host kernel and filesystem, while containers, microVMs, and remote executors replace whole capabilities instead of registering here.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three packages play the confinement roles; the subsystem reference owns the exhaustive contracts and the per-call policy semantics.

| Package | Role | ctx key |
|---|---|---|
| [`sandbox/`](sandbox/README.md) | Confinement service contract: modes, enforcement, per-call policy, and the escalation vocabulary | `ctx.sandbox` |
| [`sandbox-local/`](sandbox-local/README.md) | Per-platform confinement backends: Linux bwrap then Landlock, macOS Seatbelt | registers on `ctx.sandbox` |
| [`sandbox-policy/`](sandbox-policy/README.md) | Shared policy home: deployment defaults and per-session mode overrides for every enforcing family | `ctx.sandboxPolicy` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the confinement decision and its cross-family extension.

- [Process sandbox subsystem](../../docs/subsystems/sandbox.md) — modes, per-call policy, wrapped-argv dialects, and fail-closed errors.
- [The subprocess sandbox decision](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — the capability boundary, escalation choreography, and deferred phases.
- [Cross-family file sandbox decision](../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) — the shared policy home and the sandboxed filesystem provider.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
