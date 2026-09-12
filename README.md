# Colaw

English | [中文](README.zh.md)

Colaw is a desktop AI coding assistant for macOS (Apple silicon): chat, workspaces, sessions, and file preview live in one native window, so you can read and write code, run commands, and look things up in your local projects.

## Features

- **Conversational coding**: read/edit files, search by content, run commands, and search the web — with multi-turn tasks, subagents, and workflow orchestration.
- **Workspaces and sessions**: organize sessions by workspace; archive them, and restore or permanently delete them from the trash (including clear-all). Every session keeps its full history.
- **Right-sidebar document preview**: Markdown, code (line numbers + syntax highlighting), PDF, images, HTML, and plain text — previewed in place, without leaving the app.
  - **Deep zoom for long and very large images**: sharp at any magnification, anchored on the pointer, with drag-to-pan.
  - **Select and copy text straight off an image**: opening an image silently recognizes its text (Apple Vision, on-device, nothing uploaded); the text layer is pixel-aligned with the image and can be selected and copied like a document.
- **Models and credentials**: configure the API key under **Settings → Models** (stored only in the local managed store; process environment variables are never read). Switch models and reasoning effort at any time.
- **Automatic updates**: incremental patch updates, applied on restart.

## Install

Download `Colaw.dmg` from [Releases](https://github.com/philuo/colaw/releases/latest), open it, and drag Colaw into Applications. On first launch, fill in your API key under **Settings → Models**.

Requirements: macOS 15 or later, Apple silicon (arm64).

<a id="run"></a>
## Running and using

- Launching the app opens the session view. `⌘N` starts a new session; `⌘B` collapses or expands the left sidebar.
- **Choose workspace** in the top bar binds a working directory; the assistant then works inside it by default.
- Right sidebar: open it with the panel icon in the top-right corner. The **Files** tab browses the workspace — click a file to preview it; images and PDFs support zoom and pan.
- **Open working directory** in the top bar reveals the current directory in Finder.

## Development and packaging

This repository runs on [Bun](https://bun.com) exclusively: use `bun` / `bunx` for installing, scripts, tests, and builds — never `node` / `npx`.

Local stable packaging — one command runs the whole chain (product pack → official release identity → directly runnable app → DMG):

```sh
bun scripts/pack-stable-release.ts
```

Artifacts land in `apps/electrobun-host/build/stable-macos-arm64/`:

- `Colaw.app` — double-click to run;
- `Colaw.dmg` — the distribution image.

Development mode and common checks:

```sh
cd apps/electrobun-host && bun run dev   # hot-reload development window
bun vitest run <test path>               # unit tests
bun node_modules/typescript/bin/tsc -b tsconfig.client.json   # client typecheck
```

## Notes

基于 dsh 项目改造而来，适配 MacOS Arm64。
