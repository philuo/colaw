---
description: "Run Cua Driver computer-use tools from its native npm SDK, with durable screenshots and explicit host desktop permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-cua-driver-native

English | [中文](README.zh.md)

## Summary

Use Cua Driver to inspect and operate desktop windows without installing its separate CLI or application. The native npm dependency runs in a child process of the DSH host and exposes Cua Driver's own tools. Screenshots reach image-capable models through durable attachments. This published experimental package requires the launching host's desktop permissions and remains an explicit composition choice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already supplies the tool registry and system prompt.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
```

The provider has no configuration fields. It loads the exact Cua Driver npm version declared in [package.json](package.json) and hosts that driver in a child process of the launching host. Native import, runtime initialization, malformed catalog, duplicate tool name, or occupied computer-use registration failures reject activation and roll back owned resources. The registered provider name is `cua-driver-native`.

Use an attachment store and a model route that explicitly declares image input to receive screenshots. The [MCP result adapter](../../mcp/mcp-client/README.md) owns image admission and diagnostic behavior; programmatic callers retain the canonical raw result when a model cannot receive its images. Calls use Cua Driver's upstream tool parameters and results.

### Host requirements

The native dependency supplies platform binaries through npm optional dependencies. Keep optional dependencies enabled. Grant desktop permissions to the application that launches DSH; this provider neither installs a permission-owning app nor changes OS grants. The driver runs in a child process of that application, so a driver crash ends the child rather than the host: the host stays up and the next call starts a fresh child, but in-flight driver state — a window snapshot's `element_token`, a session, a recording — is lost with it. macOS attributes the child's permission requests through the launching application's responsible process, so a restart does not re-prompt for a grant the user already made. Use the [installed MCP provider](../computer-use-cua-driver-mcp/README.md) when the separate Cua Driver application should own permissions and execution.

### Verify the installed SDK

From the repository root, run this opt-in check against the installed native dependency. It discovers tools, reads permission status with `prompt: false`, and verifies teardown; it captures no screenshots, sends no input, and requests no OS permissions. Clearing `NODE_USE_ENV_PROXY` prevents Node from installing the launching shell's proxy before test setup.

```sh
env -u NODE_USE_ENV_PROXY DSH_COMPUTER_USE_NATIVE_E2E=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider reserves the shared computer-use registration before loading native code. A child plugin owns discovery, model tools, guidance, and the hosted driver. The parent retains the registration until child teardown has removed tools, interrupted native calls and image-capability admission, awaited settlement, and completed driver shutdown. Cancellation does not undo input already delivered to an application.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Catalog validation, exposure filtering, tool registration, the permission policy, and provider guidance |
| [src/driver-host.ts](src/driver-host.ts) | Child-process ownership: spawning the driver, framing calls, cancellation, death detection, respawn, and reaping |
| — | No runtime invariant companion is published; resource ownership has no independently observed state to compare. |

Tool definitions reuse the existing MCP result adapter. Cua Driver's JSON catalog determines the schemas; its raw result supplies canonical text, structured output, and image bytes. The computer-use service carries only the provider name and exclusive registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use service](../../computer-use/computer-use/README.md) — exclusive named registration.
- [MCP client](../../mcp/mcp-client/README.md) — shared result and image projection.
- [Cua Driver SDK](https://cua.ai/docs/reference/cua-driver/sdk-reference) — upstream runtime API and host facilities.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The provider contributes the following computer-use guidance while its native tools are mounted.

##### Native Cua Driver guidance

```markdown
Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry — it names the way through, so pass delivery_mode:"foreground" rather than reaching for another tool. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work. Application-menu invocation is not part of this tool surface: resolving a menu path reaches AppKit's window-raise path from the driver's own worker thread, where macOS asserts and kills the driver process, taking every snapshot and session held in it, so reach a window's menu commands through its own controls or a keyboard equivalent instead. delivery_mode:"foreground" is what briefly fronts a window, and it restores the previous frontmost afterwards.
```

#### Token effect

This fixed guidance adds system-prompt tokens while the provider is mounted. Upstream guidance resources are not automatically loaded.

#### KV Cache effect

The unchanged guidance preserves its repeated prompt prefix. Mounting, removing, or editing it changes that prefix and can reduce cache reuse.

### Discovered Cua Driver tools and results

#### What the model sees

Tools use the `cua_driver_native__` prefix followed by the upstream name and retain the upstream descriptions and input schemas. Two upstream tools stay off this surface — `invoke_menu` and `replay_trajectory` — because the first reaches the assertion above and the second re-dispatches tool names read from a recorded directory; a native permission policy denies both as well, so a recording cannot reach one either. Upstream tool refusals become tool errors. Supported screenshots appear as durable image references beside result text; the canonical raw result remains available to programmatic callers.

#### Token effect

The discovered catalog adds tool definitions to each request. Accessibility trees, result text, and admitted screenshots add per-call context. Raw base64 remains in execution-local canonical values and is not copied into model history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Tool results append to Session history. Replacing the provider or its catalog changes the model-visible tools and can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package preserves the upstream driver's platform and application limits.

- **Host permissions and graphics session** — npm installation does not grant desktop access or create a graphical session.
- **Native cursor overlay** — a headless macOS Node host can receive `facility_unavailable` for overlay operations while screenshots and background input remain usable.
- **Shared desktop** — the provider does not reserve windows or complete workflows for a Session. Other callers and applications can change the same desktop between calls.
- **Cancellation** — an aborted call can have delivered input already; inspect fresh state before retrying. The provider waits for driver shutdown during unload but does not promise native action rollback.
- **Driver crashes** — the driver runs in a child process; a crash ends that child and discards the in-flight state it held (window snapshots and their `element_token` values, sessions, recordings). The host survives and the next call starts a fresh child.
- **Failed shutdown** — if the child does not exit, the host waits briefly and then kills it. A registration left occupied by a failed mount still requires restarting the host.
- **Experimental release** — tool schemas follow the pinned upstream SDK and have no DSH stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
