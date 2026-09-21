# Agent Note: The control channel returns to the inherited fd, consumed through filesystem streams

Status: implemented

English | [中文](2026-09-21-control-channel-fd-fs-streams.zh.md)

Supersedes in part [The subprocess control channel rides IPC, not an inherited descriptor](2026-09-21-bun-ipc-control-channel.md): the IPC transport is retired, the fd 7 transport returns, and the part of that note's diagnosis that survives is the child-side constraint, not the transport choice.

## Problem

The IPC transport cost more than bytes: a `Buffer` frame serializes into the JSON wire form (measured 2.0x expansion and ~28 MB/s end-to-end on Bun 1.4.2, versus memcpy-grade for raw descriptor bytes), and `process.send` flushes through per-message machinery the protocol does not need. The decision to leave fd 7 rested on two claims — that Bun wires extra descriptors nondeterministically, and that no bypass exists. Re-measurement on Bun 1.4.2 (macOS arm64) refuted the first and narrowed the second:

- Parent (Bun) writes to `child.stdio[7]`, child reads: 20/20 frames delivered, `'overlapped'` and `'pipe'` alike.
- Bun child + `net.Socket({fd})` (the old child side): 0/20 — this is a deterministic Bun defect in `Socket` over an inherited descriptor, not descriptor unreliability.
- Bun child + `fs.createReadStream('', {fd})`: 10/10 delivered; raw `readSync` identical.
- Child (Bun and Node) `writeSync(fd, …)` → parent `stdio[7]` `data`: delivered, both runtimes.
- Bun parent → Node child + `Socket({fd})`: 6/6 — the Node child never had a problem.

## Decision

fd 7 returns as the transport. The parent endpoint is `child.stdio[7]` exactly as before the IPC round trip; the child endpoint is new — `openInheritedControlChannel()` builds a byte duplex whose reads push from `fs.createReadStream('', {fd, autoClose: false})` and whose writes go to the kernel synchronously through `writeSync`. The synchronous write is the load-bearing property: an async stream strands a frame the program emits immediately before blocking the event loop (the runtime must observe console output written right before a non-yielding loop), while a full descriptor blocks the writer — the bounded backpressure the protocol's frame caps assume. The marker value returns to `pipe`; `SUBPROCESS_CONTROL_FD` is exported again.

The IPC-era constraints that remain: the control suite stays in the Bun run; the V8 old-generation ceiling case still skips on Bun (`--max-old-space-size` is inert there); hostile-traffic fixtures still inject through the descriptor. The one lifecycle difference the IPC note recorded is real and now pinned where it belongs: Bun tears a paused parent endpoint down at the child's EOF, so the paused-endpoint contract holds on Node and degrades to "disposal lands the endpoint closed" on Bun.

## Consequences

The channel is byte-transparent again — full descriptor throughput, no per-frame serialization, and the measured IPC costs disappear. The child runs one implementation on every runtime. The failure modes are exactly the old ones plus none: a peer that dies surfaces EPIPE through the write path, and frames a paused parent never drains are lost when the child exits — as they were before the IPC round trip. The protocol layer (`JsonChannel`), frame caps, and every consumer are untouched.

## Alternatives considered

- **Keep the IPC transport and document its throughput bound.** Rejected on measurement: the transport's 2x expansion and ~28 MB/s ceiling buy nothing over a descriptor both runtimes deliver deterministically once the child consumes it correctly.
- **`serialization: 'advanced'` over IPC.** Structured clone would carry the Buffer as bytes, but it pins the protocol to a serialization mode whose Bun support would need re-verification per release, for a channel that never needed IPC semantics.

## Testing

`packages/subprocess/subprocess/tests/control.spec.ts` spawns real children through the shipped helper: a 256 KiB binary echo, twenty sequential spawns, and the marker contract. `packages/subprocess/subprocess-local/tests/control.spec.ts` pins the managed-disposal semantics; `packages/ptc-runtime/ptc-runtime-node` suites pin the bootstrap handshake, hostile-traffic refusal through raw descriptor writes, and the runtime-instructions wording.
