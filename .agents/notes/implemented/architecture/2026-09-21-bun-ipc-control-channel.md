# Agent Note: The subprocess control channel rides IPC, not an inherited descriptor

Status: implemented

English | [中文](2026-09-21-bun-ipc-control-channel.zh.md)

Supersedes in part [Subprocess control pipe](2026-09-11-subprocess-control-pipe.md); superseded in part by [The control channel returns to the inherited fd, consumed through filesystem streams](2026-09-21-control-channel-fd-fs-streams.md) — the fd transport returns with a filesystem-stream child side, and this note's descriptor-unreliability claim is narrowed to a deterministic `net.Socket({fd})` defect on Bun.

Supersedes in part [Subprocess control pipe](2026-09-11-subprocess-control-pipe.md): the dedicated channel, its environment marker, and its child API stand; the inherited-descriptor transport and its `overlapped` disposition do not. The IPC channel is not the supervisor's own management protocol, which that note rejects for payload requests.

## Problem

The local subprocess provider carried its optional control channel over an extra inherited stdio descriptor at fd 7 (`stdio[7] = 'overlapped'`; the child opened `new Socket({ fd: 7 })`). Node wires that descriptor deterministically. Bun does not: measured on 1.4.0, one process wired fd 7 and dropped it on the next call, and fd 3 with `'pipe'` never delivered bytes at all while fd 3 with `'overlapped'` did. The failure is silent at the descriptor level and appears as a control channel that ends before the program settles.

Its only product consumer is `dsh-ptc-runtime-node`, which the `ptc` agent preset mounts (`mode: ptc`), so a Colaw user who selects that preset reached a broken `run_code`. The suite was previously excluded from the Bun run rather than fixed, on the belief that the shell never mounts PTC.

## Decision

The control channel now rides the IPC channel `stdio: 'ipc'` creates, which both runtimes deliver deterministically:

- `dsh-subprocess/control` owns the transport. `controlDuplex(port)` adapts an IPC port to the byte-mode duplex the protocol speaks; `controlChunk(message)` recovers a chunk from every form a transport may deliver (`Buffer`, a typed array, or the JSON wire form `{ type: 'Buffer', data }` both runtimes use); `openInheritedControlChannel()` consumes the launch marker and adapts the child's own `process`.
- `controlDuplex` holds two properties at once. The Writable's receipt is the hand-off in the current turn, not the port's later flush: the protocol writes a header and a body under `cork`, and `uncork` cannot flush while a write is in flight, so a receipt deferred past a program that blocks the event loop strands every frame after the first. The port's own receipt is tracked separately, and destroy waits for it before disconnecting, so a program that writes its final frame and then closes does not lose it. An open IPC channel holds its process alive, so destroy must also release the channel.
- `dsh-subprocess-local` pushes `'ipc'` at stdio index 3 instead of padding to fd 7, and `controlPipe(child)` adapts the child handle.
- `SUBPROCESS_CONTROL_FD` is gone; `SUBPROCESS_CONTROL_MARKER` names the transport so a later one can be added without a compatibility break.
- The `subprocess-local` control suite returns to the Bun run; the PTC fixtures that injected hostile traffic through `fs.writeSync(7, …)` now inject it through `process.send`, which is the channel's real forgery surface.
- The V8 old-generation ceiling case skips on Bun: `maxOldGenerationSizeMb` becomes `--max-old-space-size`, which Bun ignores, so the observed heap limit cannot track the configured value.
- `erasable.ts` restores the program-language contract on Bun. Node's `stripTypeScriptTypes` refuses constructs that need code generation, and both the PTC README and the model-facing `run_code` description promise erasable syntax only; `Bun.Transpiler` generates code for them instead, so the Bun fallback now refuses them itself before transpiling.

## Consequences

`dsh-ptc-runtime-node` goes from 24 failing cases to none under Bun, and the transport is deterministic. The last three to fall were one shape: a program that blocks the event loop immediately after emitting output. The frame reached the transport but not the host, because the Writable's receipt gated the hand-off and `uncork` could not flush past an in-flight write. The two adapter properties above are the fix, and each has its own regression case in the control suite.

The control channel is now message-framed by the transport and length-framed by the protocol on top of it, so a hostile program forges frames with `process.send` rather than a raw descriptor write.

## Alternatives

- **Unix domain socket.** Cross-runtime and deterministic, but introduces a filesystem path, a cleanup obligation, and a sandbox interaction the inherited descriptor deliberately avoided.
- **Keep fd 7 and retry.** The Bun behavior is state-dependent, so a retry would turn a deterministic protocol into a timing-dependent one.
- **Leave the suite excluded.** Rejected: the preset makes PTC reachable, so the exclusion hid a user-visible break rather than a test-only limitation.
