# 基于 dsh + electrobun (Bun@1.4.x) 构建桌面端 IDE 集成指南

> 目标：基于 DeepSeek Harness (dsh) 和 electrobun，后端选择 Bun@1.4.x，构建桌面端 IDE。
> 分析日期：2026-09-07 | dsh 版本：0.1.3-alpha.2

## 1. 架构选型分析

### 1.1 三种可能的集成架构



```
方案 A: Bun 直接运行 dsh（推荐验证后采用）

┌──────────────────────────────────────────────┐

│  electrobun (Electron 前端 + Bun 后端)        │

│  ┌────────────┐    ┌───────────────────────┐ │

│  │  Renderer  │◄──►│  Bun Main Process     │ │

│  │  (IDE UI)  │    │  ┌─────────────────┐  │ │

│  │            │    │  │  dsh (Cordis 树) │  │ │

│  │            │    │  │  (Bun 直接运行)   │  │ │

│  │            │    │  └─────────────────┘  │ │

│  └────────────┘    └───────────────────────┘ │

└──────────────────────────────────────────────┘

方案 B: Bun 作为 Host，dsh 作为子进程（最稳妥）

┌──────────────────────────────────────────────┐

│  electrobun (Electron 前端 + Bun 后端)        │

│  ┌────────────┐    ┌───────────────────────┐ │

│  │  Renderer  │◄──►│  Bun Main Process     │ │

│  │  (IDE UI)  │    │  - IDE 业务逻辑        │ │

│  │            │    │  - 窗口/菜单/文件管理   │ │

│  │            │    │  - 插件管理             │ │

│  └────────────┘    └──────────┬────────────┘ │

│                               │ IPC / stdio   │

│                        ┌──────▼──────┐        │

│                        │ dsh 子进程   │        │

│                        │ (Node.js)    │        │

│                        │ --profile sdk│        │

│                        └─────────────┘        │

└──────────────────────────────────────────────┘

方案 C: 混合（Bun 运行业务，dsh 运行 Agent）

┌──────────────────────────────────────────────┐

│  electrobun                                   │

│  ┌────────────┐    ┌───────────────────────┐ │

│  │  Renderer  │◄──►│  Bun Main             │ │

│  │  (IDE UI)  │    │  - 文件系统            │ │

│  │            │    │  - LSP 客户端          │ │

│  │            │    │  - 终端 (Bun PTY)      │ │

│  │            │    │  - IDE 插件系统        │ │

│  └────────────┘    └──────────┬────────────┘ │

│                               │ JSON-RPC       │

│                        ┌──────▼──────┐        │

│                        │ dsh 子进程   │        │

│                        │ (Agent 运行时)│        │

│                        └─────────────┘        │

└──────────────────────────────────────────────┘
```

### 1.2 方案对比



| 维度           | 方案 A (Bun 直跑 dsh)            | 方案 B (dsh 子进程)  | 方案 C (混合)       |
| ------------ | ---------------------------- | --------------- | --------------- |
| **原生模块兼容**   | ⚠️ 需验证 node-pty/koffi/fs-ext | ✅ Node.js 原生支持  | ✅ dsh 侧 Node.js |
| **性能**       | ✅ 单进程，无 IPC 开销               | ⚠️ IPC 开销       | ⚠️ IPC 开销       |
| **稳定性**      | ⚠️ Bun 对 Cordis 兼容性未知        | ✅ dsh 官方支持 Node | ✅ 职责分离          |
| **IDE 功能扩展** | ✅ 直接在 Bun 中扩展                | ⚠️ 需通过 dsh 插件扩展 | ✅ Bun 侧自由扩展     |
| **调试难度**     | ⚠️ Bun + Cordis 混合栈          | ✅ 清晰的进程边界       | ✅ 清晰的进程边界       |
| **推荐度**      | ⭐⭐⭐ (验证后)                    | ⭐⭐⭐⭐⭐ (最稳妥)     | ⭐⭐⭐⭐ (IDE 专用)   |

### 1.3 推荐路径

**对于构建 IDE，推荐方案 C（混合架构）**，原因：



1. **IDE 的核心能力（文件系统、LSP、终端、编辑器）在 Bun 侧实现更自然**，Bun 有优秀的文件系统 API 和性能

2. **dsh 专注做 Agent 运行时**，通过 JSON-RPC 与 Bun 通信，职责清晰

3. **避免 Bun 运行 dsh 的兼容性风险**，dsh 官方只支持 Node.js

4. **可以独立升级 dsh 和 IDE 层**，互不影响

如果团队小、想快速验证，可以先用**方案 B**（dsh 作为 Node.js 子进程，Bun 做 IDE 外壳），验证后再考虑将部分能力迁移到 Bun 侧。

## 2. 方案 C 详细架构设计

### 2.1 进程拓扑



```
┌─────────────────────────────────────────────────────────┐

│                    electrobun 应用                         │

│                                                           │

│  ┌──────────────────┐      ┌─────────────────────────┐  │

│  │   Renderer 进程   │      │     Bun Main 进程        │  │

│  │                  │      │                         │  │

│  │  ┌────────────┐  │      │  ┌───────────────────┐  │  │

│  │  │  IDE UI     │  │      │  │  IDE Core (Bun)   │  │  │

│  │  │  (React/    │  │      │  │                   │  │  │

│  │  │   Vue/Svelte)│ │      │  │  - 文件系统服务     │  │  │

│  │  │            │  │      │  │  - LSP 客户端管理器  │  │  │

│  │  │  - 编辑器   │  │      │  │  - 终端管理器       │  │  │

│  │  │  - 文件树   │  │      │  │  - 项目管理         │  │  │

│  │  │  - 终端 UI  │  │      │  │  - IDE 插件系统     │  │  │

│  │  │  - AI 面板  │  │      │  │  - 配置管理         │  │  │

│  │  └────────────┘  │      │  └─────────┬─────────┘  │  │

│  │                  │      │            │             │  │

│  │  ┌────────────┐  │      │  ┌─────────▼─────────┐  │  │

│  │  │  Preload    │  │      │  │  Agent Client     │  │  │

│  │  │  (安全桥)   │  │      │  │  (JSON-RPC over   │  │  │

│  │  └────────────┘  │      │  │   stdio/unix socket)│ │  │

│  └────────┬─────────┘      │  └─────────┬─────────┘  │  │

│           │                  │            │             │  │

│           │    contextBridge │            │ spawn       │  │

│           └──────────────────┘            │             │  │

│                                          ┌──▼──────┐     │  │

│                                          │  dsh     │     │  │

│                                          │ 子进程   │     │  │

│                                          │ (Node.js)│     │  │

│                                          │         │     │  │

│                                          │ --profile│     │  │

│                                          │   ide   │     │  │

│                                          │         │     │  │

│                                          │ Cordis  │     │  │

│                                          │ 插件树   │     │  │

│                                          └─────────┘     │  │

└─────────────────────────────────────────────────────────┘
```

### 2.2 通信协议

#### Bun ↔ dsh：JSON-RPC 2.0 over stdio

dsh 的 SDK profile 原生支持 JSON-RPC over stdio：



```
// Bun 侧：Agent Client

import { spawn } from 'bun'

class DshAgentClient {

&#x20; private process: Subprocess

&#x20; private requestId = 0

&#x20; private pendingRequests = new Map\<number, { resolve, reject }>()

&#x20; constructor(dshPath: string, profile: string = 'sdk') {

&#x20;   this.process = spawn({

&#x20;     cmd: \[dshPath, '--profile', profile],

&#x20;     stdin: 'pipe',

&#x20;     stdout: 'pipe',

&#x20;     stderr: 'inherit',

&#x20;   })

&#x20;   this.listen()

&#x20; }

&#x20; async createSession(options: { model?: string; provider?: string }) {

&#x20;   return this.request('sessions.create', options)

&#x20; }

&#x20; async sendMessage(sessionId: string, content: string) {

&#x20;   return this.request('sessions.sendMessage', { sessionId, content })

&#x20; }

&#x20; streamSession(sessionId: string): AsyncGenerator\<any> {

&#x20;   // 订阅 session 事件流

&#x20; }

&#x20; private request(method: string, params: any) {

&#x20;   const id = ++this.requestId

&#x20;   const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

&#x20;   this.process.stdin.write(request)

&#x20;   return new Promise((resolve, reject) => {

&#x20;     this.pendingRequests.set(id, { resolve, reject })

&#x20;   })

&#x20; }

&#x20; private listen() {

&#x20;   // 解析 stdout 的 NDJSON (newline-delimited JSON)

&#x20;   // 区分 response 和 notification

&#x20; }

}
```

#### Renderer ↔ Bun：electrobun contextBridge



```
// preload.ts

import { contextBridge } from 'electrobun'

contextBridge.exposeInMainWorld('ide', {

&#x20; // 文件系统

&#x20; fs: {

&#x20;   readFile: (path) => ipc.invoke('fs:readFile', path),

&#x20;   writeFile: (path, content) => ipc.invoke('fs:writeFile', path, content),

&#x20;   watch: (path, callback) => ipc.on('fs:watch:' + path, callback),

&#x20; },

&#x20; // 终端

&#x20; terminal: {

&#x20;   create: () => ipc.invoke('terminal:create'),

&#x20;   write: (id, data) => ipc.send('terminal:write', id, data),

&#x20;   onData: (id, callback) => ipc.on('terminal:data:' + id, callback),

&#x20; },

&#x20; // AI Agent (通过 Bun 转发到 dsh)

&#x20; agent: {

&#x20;   createSession: (options) => ipc.invoke('agent:createSession', options),

&#x20;   sendMessage: (sessionId, content) => ipc.invoke('agent:sendMessage', sessionId, content),

&#x20;   stream: (sessionId, callback) => ipc.on('agent:stream:' + sessionId, callback),

&#x20; },

&#x20; // LSP

&#x20; lsp: {

&#x20;   start: (serverConfig) => ipc.invoke('lsp:start', serverConfig),

&#x20;   request: (id, method, params) => ipc.invoke('lsp:request', id, method, params),

&#x20; },

})
```

## 3. dsh 侧：IDE 专用 Profile 设计

### 3.1 创建 IDE Profile

dsh 的 Profile 系统允许创建自定义组合。为 IDE 创建专用 profile：



```
\# \$DSH\_HOME/profiles/ide/cordis.patch.yml

\# IDE 专用 profile：在 dsh-base 基础上添加 IDE 能力

\# 1. 添加 IDE 专用工具（通过自定义 dsh 插件包）

\- insert:

&#x20;   # 文件编辑工具（增强版，支持 IDE 集成）

&#x20;   - id: tool-ide-file-edit

&#x20;     name: '@your-org/dsh-tool-ide-file-edit'

&#x20;     config:

&#x20;       workspaceRoot: !!js process.env.IDE\_WORKSPACE\_ROOT

&#x20;       maxFileSize: 10485760

&#x20;   # LSP 工具（代码补全、跳转、重构）

&#x20;   - id: tool-ide-lsp

&#x20;     name: '@your-org/dsh-tool-ide-lsp'

&#x20;     config:

&#x20;       languageServers:

&#x20;         typescript:

&#x20;           command: typescript-language-server

&#x20;           args: \['--stdio']

&#x20;         python:

&#x20;           command: pylsp

&#x20;   # 终端工具（与 IDE 终端集成）

&#x20;   - id: tool-ide-terminal

&#x20;     name: '@your-org/dsh-tool-ide-terminal'

&#x20;     config:

&#x20;       shell: !!js process.env.SHELL || '/bin/zsh'

&#x20;       cwd: !!js process.env.IDE\_WORKSPACE\_ROOT

&#x20;   # 搜索工具（代码搜索，ripgrep 后端）

&#x20;   - id: tool-ide-search

&#x20;     name: '@your-org/dsh-tool-ide-search'

&#x20;     config:

&#x20;       backend: ripgrep

&#x20;       maxResults: 100

&#x20;   # Git 工具

&#x20;   - id: tool-ide-git

&#x20;     name: '@your-org/dsh-tool-ide-git'

&#x20;   # 测试运行工具

&#x20;   - id: tool-ide-test

&#x20;     name: '@your-org/dsh-tool-ide-test'

&#x20;     config:

&#x20;       testRunners:

&#x20;         javascript: \['vitest', 'jest', 'npm test']

&#x20;         python: \['pytest']

\# 2. 覆盖默认模型配置（IDE 场景）

\- id: agent-default-model

&#x20; config:

&#x20;   provider: deepseek-official

&#x20;   model: deepseek-v4-flash  # IDE 场景优先快速模型

\# 3. 覆盖沙箱策略（IDE 场景需要更多文件系统访问）

\- id: sandbox-policy

&#x20; config:

&#x20;   mode: workspace-write

&#x20;   workspaceRoot: !!js process.env.IDE\_WORKSPACE\_ROOT

\# 4. 覆盖审批策略（IDE 场景可配置自动审批某些操作）

\- id: approval

&#x20; config:

&#x20;   policy: ask  # 或 'never' (danger-full-access 模式)

\# 5. 禁用不需要的 Web 工具（IDE 有自己的浏览器集成）

\- id: tool-web

&#x20; config:

&#x20;   fetch: false

&#x20;   search: false
```

### 3.2 IDE 专用 dsh 插件开发

每个 IDE 能力都是一个标准 dsh 插件（Cordis 插件），遵循三角色模式：



```
// packages/ide-tools/src/file-edit.ts

import { Context, Service } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

// Service Definition

export interface IdeFileEditService {

&#x20; readFile(path: string): Promise\<string>

&#x20; writeFile(path: string, content: string): Promise\<void>

&#x20; editFile(path: string, edits: FileEdit\[]): Promise\<FileEditResult>

}

// Consumer (面向模型的工具)

export default function IdeFileEditPlugin(ctx: Context, config: Config) {

&#x20; // 注册工具到 ctx.tools

&#x20; ctx.effect(() => ctx.tools.register({

&#x20;   name: 'ide\_edit\_file',

&#x20;   description: 'Edit a file in the IDE workspace. Supports precise string replacement.',

&#x20;   schema: z.object({

&#x20;     path: z.string().description('Relative path from workspace root'),

&#x20;     edits: z.array(z.object({

&#x20;       oldString: z.string(),

&#x20;       newString: z.string(),

&#x20;     })),

&#x20;   }),

&#x20;   execute: async (args) => {

&#x20;     // 通过 Bun IPC 调用 IDE 文件系统

&#x20;     const result = await ctx.get('ideBridge').editFile(args.path, args.edits)

&#x20;     return result

&#x20;   },

&#x20; }), 'ide-file-edit.tool')

}
```

### 3.3 dsh ↔ Bun 桥接服务

在 dsh 侧注册一个桥接服务，将工具调用转发到 Bun：



```
// dsh 插件：IDE Bridge

export default function IdeBridgePlugin(ctx: Context, config: { socketPath: string }) {

&#x20; const bridge = new IdeBridgeClient(config.socketPath)

&#x20;&#x20;

&#x20; ctx.provide('ideBridge', bridge)

&#x20;&#x20;

&#x20; ctx.effect(() => () => bridge.close(), 'ide-bridge.close')

}

// 通过 Unix socket 与 Bun 通信

class IdeBridgeClient {

&#x20; constructor(private socketPath: string) {}

&#x20;&#x20;

&#x20; async editFile(path: string, edits: any\[]): Promise\<any> {

&#x20;   return this.request('ide:editFile', { path, edits })

&#x20; }

&#x20;&#x20;

&#x20; async terminalWrite(id: string, data: string): Promise\<void> {

&#x20;   return this.request('ide:terminalWrite', { id, data })

&#x20; }

&#x20;&#x20;

&#x20; async lspRequest(serverId: string, method: string, params: any): Promise\<any> {

&#x20;   return this.request('ide:lspRequest', { serverId, method, params })

&#x20; }

&#x20;&#x20;

&#x20; private async request(method: string, params: any): Promise\<any> {

&#x20;   // Unix socket JSON-RPC 请求

&#x20; }

}
```

## 4. Bun 侧：IDE Core 设计

### 4.1 项目结构



```
your-ide/

├── src/

│   ├── main/              # Bun Main 进程

│   │   ├── index.ts       # 入口

│   │   ├── window.ts      # 窗口管理

│   │   ├── menu.ts        # 菜单

│   │   ├── fs/            # 文件系统服务

│   │   ├── terminal/      # 终端管理 (Bun PTY)

│   │   ├── lsp/           # LSP 客户端管理器

│   │   ├── git/           # Git 集成

│   │   ├── search/        # 代码搜索 (ripgrep)

│   │   ├── agent/         # dsh Agent 客户端

│   │   ├── plugins/       # IDE 插件系统

│   │   └── config/        # 配置管理

│   ├── renderer/          # Renderer 进程 (前端 UI)

│   │   ├── editor/        # 编辑器 (Monaco/CodeMirror)

│   │   ├── sidebar/       # 侧边栏 (文件树、搜索、Git)

│   │   ├── panel/         # 面板 (终端、输出、问题)

│   │   ├── ai/            # AI 面板 (对话、代码补全)

│   │   └── statusbar/     # 状态栏

│   └── preload/           # Preload 脚本

│       └── index.ts

├── dsh-plugins/           # 自定义 dsh 插件

│   ├── ide-file-edit/

│   ├── ide-lsp/

│   ├── ide-terminal/

│   ├── ide-search/

│   └── ide-git/

├── package.json

└── tsconfig.json
```

### 4.2 Bun 关键服务实现

#### 文件系统服务



```
// src/main/fs/service.ts

import { watch } from 'bun'

export class FsService {

&#x20; private watchers = new Map\<string, FileWatcher>()

&#x20; async readFile(path: string): Promise\<string> {

&#x20;   return Bun.file(path).text()

&#x20; }

&#x20; async writeFile(path: string, content: string): Promise\<void> {

&#x20;   await Bun.write(path, content)

&#x20; }

&#x20; async editFile(path: string, edits: { oldString: string; newString: string }\[]): Promise<{ success: boolean; applied: number }> {

&#x20;   let content = await this.readFile(path)

&#x20;   let applied = 0

&#x20;   for (const edit of edits) {

&#x20;     if (content.includes(edit.oldString)) {

&#x20;       content = content.replace(edit.oldString, edit.newString)

&#x20;       applied++

&#x20;     }

&#x20;   }

&#x20;   if (applied > 0) {

&#x20;     await this.writeFile(path, content)

&#x20;   }

&#x20;   return { success: applied === edits.length, applied }

&#x20; }

&#x20; watch(path: string, callback: (event: string, filename: string) => void): () => void {

&#x20;   const watcher = watch(path, (event, filename) => callback(event, filename))

&#x20;   this.watchers.set(path, watcher)

&#x20;   return () => {

&#x20;     watcher.unwatch()

&#x20;     this.watchers.delete(path)

&#x20;   }

&#x20; }

}
```

#### 终端管理（Bun.Terminal 原生 PTY，零依赖）

> **使用 Bun.Terminal 原生 API，替代 node-pty。** 跨平台 openpty (Linux/macOS) + ConPTY (Windows)，零原生模块构建，支持可复用 Terminal 和 `await using` 自动清理。

```typescript
// src/main/terminal/manager.ts
// Bun.Terminal 原生 PTY，零外部依赖

interface TerminalSession {
  terminal: Bun.Terminal
  process: Bun.Subprocess
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()

  /**
   * 创建持久终端会话。
   * 使用独立的 Bun.Terminal 实例，可跨多个命令复用。
   */
  create(shell: string = process.env.SHELL || '/bin/zsh', cwd: string): string {
    const id = Bun.randomUUIDv7()

    // 创建可复用 Terminal（独立于进程，可跨多个 spawn 复用）
    const terminal = new Bun.Terminal({
      cols: 120,
      rows: 40,
      name: 'xterm-256color',
      data(term, data) {
        // 转发到 Renderer（Uint8Array → string）
        mainWindow.webContents.send('terminal:data:' + id, new TextDecoder().decode(data))
      },
      exit(term, exitCode, signal) {
        // PTY 流关闭（0=EOF, 1=error），不是子进程退出
        mainWindow.webContents.send('terminal:exit:' + id, { exitCode, signal })
      },
    })

    // 在 Terminal 中启动 shell
    const process = Bun.spawn([shell], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      terminal,  // 复用已创建的 Terminal
    })

    this.sessions.set(id, { terminal, process })
    return id
  }

  /** 向终端写入数据（用户输入） */
  write(id: string, data: string): void {
    this.sessions.get(id)?.terminal.write(data)
  }

  /** 调整终端大小 */
  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.terminal.resize(cols, rows)
  }

  /** 设置原始模式（禁用行缓冲和回显） */
  setRawMode(id: string, enabled: boolean): void {
    this.sessions.get(id)?.terminal.setRawMode(enabled)
  }

  /**
   * 在已有终端中运行新命令（复用 Terminal）。
   * 适用于 IDE 中"在终端中运行"功能。
   */
  runInTerminal(id: string, command: string, args: string[], cwd?: string): Bun.Subprocess {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Terminal ${id} not found`)

    return Bun.spawn([command, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      terminal: session.terminal,  // 复用已有 Terminal
    })
  }

  /** 销毁终端会话 */
  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.process.kill()   // 先 kill 子进程
      session.terminal.close() // 再关闭 PTY
      this.sessions.delete(id)
    }
  }

  /** 销毁所有终端（应用退出时调用） */
  disposeAll(): void {
    for (const id of this.sessions.keys()) {
      this.dispose(id)
    }
  }
}
```

**Bun.Terminal 关键特性**：

| 特性 | 说明 |
|---|---|
| 跨平台 PTY | POSIX 用 `openpty()`，Windows 用 ConPTY (`CreatePseudoConsole`) |
| 零原生构建 | 内置在 Bun 二进制中，无需 node-gyp 编译 |
| 可复用 Terminal | `new Bun.Terminal()` 创建独立 PTY，可跨多个 `Bun.spawn` 复用 |
| `await using` | 实现 `AsyncDisposable`，自动 close |
| termios 控制 | POSIX 支持 `inputFlags/outputFlags/localFlags/controlFlags` |
| 原始模式 | `setRawMode(true)` 禁用行缓冲和回显 |
| 事件回调 | `data`/`exit`/`drain` 三个回调 |
| 背压控制 | `drain` 回调通知可写入更多数据 |

> 完整的 Bun.Terminal 与 node-pty 对比、平台差异、替换路线图，见 [07-bun-native-api-mapping.md](./07-bun-native-api-mapping.md#11-node-pty--bunterminal--最关键)。

#### LSP 客户端管理器



```
// src/main/lsp/manager.ts

import { spawn } from 'bun'

import { createMessageConnection } from 'vscode-jsonrpc'

export class LspManager {

&#x20; private servers = new Map\<string, LspServer>()

&#x20; async start(config: { command: string; args: string\[]; cwd: string }): Promise\<string> {

&#x20;   const id = crypto.randomUUID()

&#x20;   const process = spawn({

&#x20;     cmd: \[config.command, ...config.args],

&#x20;     cwd: config.cwd,

&#x20;     stdin: 'pipe',

&#x20;     stdout: 'pipe',

&#x20;   })

&#x20;   const connection = createMessageConnection(

&#x20;     new StreamMessageReader(process.stdout),

&#x20;     new StreamMessageWriter(process.stdin),

&#x20;   )

&#x20;   connection.listen()

&#x20;   await connection.sendRequest('initialize', {

&#x20;     processId: process.pid,

&#x20;     capabilities: {},

&#x20;     rootUri: 'file://' + config.cwd,

&#x20;   })

&#x20;   connection.sendNotification('initialized')

&#x20;   this.servers.set(id, { process, connection })

&#x20;   return id

&#x20; }

&#x20; async request(serverId: string, method: string, params: any): Promise\<any> {

&#x20;   const server = this.servers.get(serverId)

&#x20;   if (!server) throw new Error(\`LSP server \${serverId} not found\`)

&#x20;   return server.connection.sendRequest(method, params)

&#x20; }

&#x20; dispose(serverId: string): void {

&#x20;   const server = this.servers.get(serverId)

&#x20;   server?.connection.sendNotification('shutdown')

&#x20;   server?.process.kill()

&#x20;   this.servers.delete(serverId)

&#x20; }

}
```

#### Agent 客户端（dsh 子进程管理）



```
// src/main/agent/client.ts

import { spawn } from 'bun'

import { createInterface } from 'node:readline'

export class DshAgentClient {

&#x20; private process: Subprocess | null = null

&#x20; private requestId = 0

&#x20; private pending = new Map\<number, { resolve: Function; reject: Function }>()

&#x20; private streamCallbacks = new Map\<string, (event: any) => void>()

&#x20; constructor(

&#x20;   private dshPath: string,

&#x20;   private profile: string = 'sdk',

&#x20;   private workspaceRoot: string,

&#x20; ) {}

&#x20; async start(): Promise\<void> {

&#x20;   this.process = spawn({

&#x20;     cmd: \[this.dshPath, '--profile', this.profile],

&#x20;     cwd: this.workspaceRoot,

&#x20;     env: {

&#x20;       ...process.env,

&#x20;       IDE\_WORKSPACE\_ROOT: this.workspaceRoot,

&#x20;     },

&#x20;     stdin: 'pipe',

&#x20;     stdout: 'pipe',

&#x20;     stderr: 'inherit',

&#x20;   })

&#x20;   this.listen()

&#x20; }

&#x20; async createSession(options?: { model?: string; provider?: string }): Promise\<string> {

&#x20;   const result = await this.request('sessions.create', options || {})

&#x20;   return result.sessionId

&#x20; }

&#x20; async sendMessage(sessionId: string, content: string): Promise\<void> {

&#x20;   await this.request('sessions.sendMessage', { sessionId, content })

&#x20; }

&#x20; onStream(sessionId: string, callback: (event: any) => void): void {

&#x20;   this.streamCallbacks.set(sessionId, callback)

&#x20; }

&#x20; async stop(): Promise\<void> {

&#x20;   this.process?.kill()

&#x20;   this.process = null

&#x20; }

&#x20; private request(method: string, params: any): Promise\<any> {

&#x20;   if (!this.process) throw new Error('dsh not started')

&#x20;   const id = ++this.requestId

&#x20;   const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

&#x20;   this.process.stdin.write(message)

&#x20;   return new Promise((resolve, reject) => {

&#x20;     this.pending.set(id, { resolve, reject })

&#x20;   })

&#x20; }

&#x20; private listen(): void {

&#x20;   if (!this.process) return

&#x20;   const rl = createInterface({ input: this.process.stdout })

&#x20;   rl.on('line', (line) => {

&#x20;     try {

&#x20;       const message = JSON.parse(line)

&#x20;       if (message.id && this.pending.has(message.id)) {

&#x20;         const { resolve, reject } = this.pending.get(message.id)!

&#x20;         this.pending.delete(message.id)

&#x20;         if (message.error) reject(new Error(message.error.message))

&#x20;         else resolve(message.result)

&#x20;       } else if (message.method === 'session/event') {

&#x20;         const callback = this.streamCallbacks.get(message.params.sessionId)

&#x20;         callback?.(message.params.event)

&#x20;       }

&#x20;     } catch (e) {

&#x20;       console.error('Failed to parse dsh message:', e)

&#x20;     }

&#x20;   })

&#x20; }

}
```

## 5. 关键集成点与注意事项

### 5.1 dsh 版本锁定

dsh 目前是 alpha 版本（0.1.3-alpha.2），API 可能变化。建议：



1. **锁定精确版本**：在 package.json 中使用精确版本号，不用 `^`

2. **固定 dsh 可执行文件**：将 dsh 打包到应用中，不依赖用户系统安装

3. **关注 breaking changes**：dsh 的 Session 格式有版本迁移机制，但 alpha 阶段可能有不兼容变更

### 5.2 原生模块兼容性

如果采用方案 A（Bun 直跑 dsh），需要验证以下原生模块在 Bun 1.4.x 下的兼容性：



| 模块         | 用途            | Bun 兼容性  | 验证方法                               |
| ---------- | ------------- | -------- | ---------------------------------- |
| `node-pty` | PTY 终端        | ✅ **Bun.Terminal 原生替代** | 见 07 文档 |
| `koffi`    | FFI (Windows) | ✅ **Bun.ffi 原生替代** | 见 07 文档 |
| `fs-ext`   | 文件锁           | ✅ **Bun 原生文件锁替代** | 见 07 文档 |
| `esbuild`  | 构建            | ✅ Bun 内置 | -                                  |

> **重要**：Bun 1.4.x 内置了大量原生 API，可以替代 dsh 中约 60% 的外部运行时依赖。最关键的是 `Bun.Terminal` 可以直接替代 `node-pty`（dsh 最大的原生模块依赖，跨平台 openpty/ConPTY，零构建），`Bun.YAML` 替代 `js-yaml`（Rust 实现），`Bun.Image` 替代 `sharp`（libjpeg-turbo/spng/libwebp 内置），`Bun.WebView` 替代 `puppeteer`（macOS 零依赖 WKWebView）。
>
> 完整的 Bun 原生 API 替代映射（12 个直接替代 + 8 个能力覆盖 + 6 个新增能力 + 不可替代依赖分析 + 三阶段替换路线图），见 [07-bun-native-api-mapping.md](./07-bun-native-api-mapping.md)。

**建议**：Bun 侧的 IDE Core 应该全部使用 Bun 原生 API，零外部依赖。dsh 子进程侧的原生模块替换需要创建 dsh 插件并在 Bun 下验证。

### 5.3 TypeScript 源码运行

dsh 开发时通过 `tsx` 直接运行 TypeScript 源码。Bun 原生支持 TypeScript，但需要注意：



1. **ESM-only 约束**：dsh 是纯 ESM，Bun 默认支持 ESM

2. `!!js`**&#x20;配置表达式**：Cordis 的 YAML 方言使用 `!!js`，需要在 Bun 中验证

3. **路径别名**：dsh 使用 tsconfig paths，Bun 支持但需要配置

### 5.4 会话数据共享

IDE 场景下，dsh 的会话数据存储在 `$DSH_HOME/sessions/`。建议：



1. **IDE 专用 DSH\_HOME**：使用应用专属的 DSH\_HOME，不与用户的 dsh CLI 共享

2. **会话导出 / 导入**：支持将会话导出为 JSON，方便在不同环境间迁移

3. **会话关联项目**：在 session header 中记录项目路径，方便按项目筛选会话

### 5.5 性能考虑



1. **dsh 启动时间**：dsh 启动需要加载 80+ 插件，首次启动可能需要 1-3 秒。建议：

* 应用启动时预启动 dsh 子进程

* 使用 sdk-minimal profile（更小的插件集）

* 考虑长期运行 dsh 进程，不随窗口关闭

1. **大文件处理**：dsh 的工具默认有大小限制。IDE 场景可能需要调整：

* `tool-fs` 的文件大小限制

* `spill-policy` 的大结果溢出阈值

* `compaction` 的上下文压缩阈值

1. **模型选择**：IDE 场景建议：

* 代码补全：快速模型（deepseek-v4-flash）

* 代码重构 / 分析：强模型（deepseek-v4）

* 可以通过 `agent-default-model` 配置默认，通过工具动态切换

## 6. 开发路线图建议

### Phase 1: 基础集成（2-3 周）



* [ ] 搭建 electrobun 项目骨架

* [ ] 实现 dsh 子进程管理（启动 / 停止 / 重启）

* [ ] 实现 JSON-RPC 客户端（Bun ↔ dsh）

* [ ] 实现 Renderer ↔ Bun 通信桥

* [ ] 基础 AI 对话面板（调用 dsh SDK）

* [ ] 验证 dsh 在子进程中稳定运行

### Phase 2: IDE 核心能力（4-6 周）



* [ ] 文件系统服务（Bun 侧）

* [ ] 文件树 UI（Renderer 侧）

* [ ] 编辑器集成（Monaco Editor）

* [ ] 终端管理（Bun PTY + xterm.js）

* [ ] LSP 客户端管理器

* [ ] dsh IDE 工具插件（文件编辑、终端、LSP）

* [ ] dsh ↔ Bun 桥接服务

### Phase 3: AI 深度集成（4-6 周）



* [ ] AI 代码补全（inline completion）

* [ ] AI 代码操作（重构、解释、生成测试）

* [ ] AI 终端助手（命令解释、错误修复）

* [ ] AI 项目级理解（代码库索引、RAG）

* [ ] 多 Agent 协作（subagent 能力）

* [ ] 会话管理（历史、搜索、导出）

### Phase 4: 产品化（持续）



* [ ] 插件系统（IDE 插件 + dsh 插件）

* [ ] 配置管理（设置 UI）

* [ ] 自动更新（electrobun 更新 + dsh 更新）

* [ ] 性能优化（启动速度、内存占用）

* [ ] 跨平台支持（macOS / Windows / Linux）

* [ ] 打包与发布

## 7. 参考资源

### dsh 官方文档



* `docs/architecture.md` — 架构总览

* `docs/cordis-primer.md` — Cordis 入门

* `docs/capability-seams.md` — 能力接缝

* `docs/agent-lifecycle.md` — Agent 生命周期

* `docs/tool-execution-pipeline.md` — 工具执行管道

* `docs/subsystems/` — 各子系统详细文档

* `docs/cookbook/` — 扩展食谱（添加工具、包、LLM 适配器）

### dsh 关键源码



* `packages/core/agent-loop/` — Agent 执行引擎

* `packages/core/session/` — 会话日志

* `packages/core/tools/` — 工具注册表

* `packages/llm/llm/` — LLM 服务定义

* `packages/boot/app-boot/` — 启动胶水

* `apps/desktop-host/` — Desktop Host 参考实现

* `packages/sdk/` — SDK 协议与客户端

### electrobun



* electrobun 官方文档（Electron + Bun 集成）

* Bun 1.4.x 文档（文件系统、子进程、PTY）