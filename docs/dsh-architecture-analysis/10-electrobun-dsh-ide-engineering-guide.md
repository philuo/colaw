# Electrobun + deepseek-harness 桌面 IDE 工程方案

> 基于 Electrobun 2.0.1（Bun@1.4.2 主进程）+ deepseek-harness v0.1.3-alpha.2
> 文档版本：1.0 | 日期：2026-09-08

---

## 一、架构总览

### 1.1 三层进程模型

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electrobun 桌面应用                            │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  主进程 (Bun@1.4.2)                                         │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │ 窗口管理  │ │ 终端管理  │ │ 文件系统  │ │ dsh 子进程管理│ │  │
│  │  │BrowserWin│ │Bun.Terminal│ │  Bun.fs  │ │JSON-RPC/stdio│ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────┬───────┘ │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │         │  │
│  │  │ 托盘/菜单 │ │全局快捷键 │ │自动更新  │        │         │  │
│  │  └──────────┘ └──────────┘ └──────────┘        │         │  │
│  └──────────────────────────────────────────────────┼─────────┘  │
│                                                      │            │
│  ┌──────────────────────────────────────────────────┼─────────┐  │
│  │  渲染进程 (系统 WebView / React 19)             │         │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │         │  │
│  │  │ 聊天面板 │ │ 编辑器  │ │ 终端面板 │ │工具面板│  │         │  │
│  │  └────────┘ └────────┘ └────────┘ └────────┘  │         │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐              │         │  │
│  │  │ 文件树  │ │ 设置面板 │ │ 会话列表│              │         │  │
│  │  └────────┘ └────────┘ └────────┘              │         │  │
│  └──────────────────────────────────────────────────┼─────────┘  │
│                                                      │            │
│  ┌──────────────────────────────────────────────────▼─────────┐  │
│  │  dsh Agent 子进程 (Node.js 或 Bun)                          │  │
│  │  ┌───────────────────────────────────────────────────────┐  │  │
│  │  │  Cordis 插件系统 → LLM适配器 → Agent循环 → 工具执行    │  │  │
│  │  │  会话持久化(JSONL) → 权限沙箱 → 代码运行环境           │  │  │
│  │  └───────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 为什么 dsh 作为子进程而不是内嵌库

| 方案 | 优点 | 缺点 |
|------|------|------|
| **子进程（推荐）** | ① 隔离崩溃（dsh 崩溃不影响 IDE）② 绕过 Bun 段错误 bug ③ 独立版本管理 ④ 可用 Node.js 官方支持环境 | ① IPC 开销（JSON-RPC over stdio，可忽略）② 进程管理复杂度 |
| 内嵌库 | ① 零 IPC 开销 ② 单进程简单 | ① Bun 段错误 bug 未修复 ② dsh 升级耦合 IDE ③ 崩溃影响整个应用 |

**结论**：dsh 作为子进程，通过 JSON-RPC over stdio 通信。Bun 段错误修复后可评估切换为内嵌。

### 1.3 技术栈选型

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 桌面框架 | Electrobun | 2.0.1 | 系统 WebView，~1.28 MiB |
| 主进程运行时 | Bun | 1.4.2 | 用户指定，快速启动 |
| 渲染框架 | React | 19.x | 模板用18，升级到19 |
| 样式 | Tailwind CSS | 4.x | 模板用3，升级到4 |
| 构建工具 | Vite | 7.x | HMR + 构建 |
| 编辑器 | Monaco Editor | 最新 | VS Code 同款编辑器 |
| 终端前端 | xterm.js | 最新 | 终端渲染 |
| 状态管理 | Zustand | 最新 | 轻量级状态管理 |
| 数据获取 | TanStack Query | 最新 | 异步状态管理 |
| dsh 运行时 | Node.js | 22.x LTS | 子进程，官方支持环境 |
| IPC 协议 | JSON-RPC 2.0 | - | dsh SDK 原生协议 |

---

## 二、Electrobun 架构深度解刨

### 2.1 核心组件

#### BrowserWindow（窗口管理）

```typescript
import { BrowserWindow } from "electrobun/main";

const win = new BrowserWindow({
  title: "DSH IDE",
  url: "views://mainview/index.html",
  frame: { x: 100, y: 100, width: 1400, height: 900 },
  titleBarStyle: "hiddenInset",  // 隐藏标题栏，保留交通灯按钮
  transparent: false,
  sandbox: false,                  // 信任本地内容，启用 RPC
  renderer: "native",             // 系统 WebView（macOS WKWebView）
  preload: null,                  // 预加载脚本
});

// 窗口事件
win.on("close", () => {});
win.on("focus", () => {});
win.on("blur", () => {});
win.on("resize", (frame) => {});
win.on("move", (frame) => {});

// 窗口控制
win.show();
win.hide();
win.focus();
win.minimize();
win.maximize();
win.unmaximize();
win.close();
win.setTitle("新标题");
win.setFrame({ x, y, width, height });
```

**关键特性**：
- `titleBarStyle: "hiddenInset"`：自定义标题栏，保留 macOS 交通灯按钮
- `sandbox: true`：不可信内容（远程 URL）禁用 RPC，只允许事件发射
- `renderer: "native"`：系统 WebView；`"cef"`：打包 Chromium
- 多窗口支持：`BrowserWindowMap` 管理所有窗口

#### BrowserView（嵌入式 WebView）

```typescript
import { BrowserView } from "electrobun/main";

// 在窗口内创建嵌入式 WebView（用于多标签页、分屏等）
const view = new BrowserView({
  windowId: win.id,
  url: "views://editor/index.html",
  frame: { x: 0, y: 0, width: 800, height: 600 },
});

view.setBounds({ x, y, width, height });
view.loadURL("views://terminal/index.html");
view.remove();
```

#### RPC（类型安全的 IPC）

Electrobun 提供类型安全的 RPC 机制，主进程↔渲染进程通信：

```typescript
// 共享类型定义（shared/rpc.ts）
export type AppRPC = {
  requests: {
    "dsh/sendPrompt": {
      params: { sessionId: string; prompt: string };
      response: { messageId: string };
    };
    "dsh/listSessions": {
      params: {};
      response: { sessions: Array<{ id: string; title: string }> };
    };
    "file/openDialog": {
      params: { filters?: Array<{ name: string; extensions: string[] }> };
      response: { filePaths: string[] };
    };
  };
  messages: {
    "dsh/sessionEvent": { type: string; data: unknown };
    "dsh/assistantMessage": { content: string };
    "terminal/data": { data: string };
  };
};

// 主进程注册 RPC handler
import { defineElectrobunRPC } from "electrobun/main";

const rpc = defineElectrobunRPC<AppRPC>({
  requests: {
    "dsh/sendPrompt": async (params) => {
      return dshManager.sendPrompt(params.sessionId, params.prompt);
    },
    "dsh/listSessions": async () => {
      return { sessions: dshManager.listSessions() };
    },
    "file/openDialog": async (params) => {
      return Utils.showOpenDialog({ filters: params.filters });
    },
  },
});

// 渲染进程调用
import { createRPC } from "electrobun/view";

const rpc = createRPC<AppRPC>();
const result = await rpc.request("dsh/sendPrompt", { sessionId: "s1", prompt: "hello" });
rpc.on("dsh/assistantMessage", (data) => {
  console.log(data.content);
});
```

**RPC 传输层**：基于 WebSocket（主进程监听本地端口），支持请求/响应/消息三种模式，类型安全。

#### 其他核心 API

| 模块 | 功能 | 关键方法 |
|------|------|---------|
| `Tray` | 系统托盘 | `new Tray({ icon, tooltip })`, `setContextMenu()`, `on("click")` |
| `ApplicationMenu` | 应用菜单 | `setApplicationMenu([...])`, `on("click")` |
| `ContextMenu` | 右键菜单 | `popup({ x, y, items })` |
| `GlobalShortcut` | 全局快捷键 | `register("Cmd+Shift+P", handler)`, `unregister()` |
| `Screen` | 屏幕信息 | `getPrimaryDisplay()`, `getAllDisplays()`, `getCursorPoint()` |
| `Session` | 会话管理 | `getDefaultSession()`, `cookies`, `clearCache()` |
| `Updater` | 自动更新 | `checkForUpdates()`, `downloadUpdate()`, `on("update-available")` |
| `Utils` | 工具函数 | `showOpenDialog()`, `showSaveDialog()`, `showMessageBox()`, `quit()` |
| `PATHS` | 路径管理 | `appData()`, `userData()`, `temp()`, `home()` |
| `Socket` | WebSocket | `new Socket(url)`, `send()`, `on("message")` |

### 2.2 构建和打包

#### Hutch 构建系统

```bash
# 开发模式（热重载）
hutch electrobun dev --watch

# 生产构建
hutch electrobun build --env=stable

# Canary 渠道构建
hutch electrobun build --env=canary
```

#### 配置文件

```typescript
// electrobun.config.ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "DSH IDE",
    identifier: "com.dsh.ide",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",                    // 使用 Bun 运行时
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    mac: { bundleCEF: false },             // 使用系统 WebView
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
```

#### 打包产物

| 平台 | 格式 | 大小（系统 WebView） |
|------|------|---------------------|
| macOS | DMG（代码签名+公证） | ~1.28 MiB |
| Windows | 安装程序（代码签名） | ~15 MiB（Cottontail） |
| Linux | 自解压安装程序 | ~15 MiB（Cottontail） |

#### 差分更新

- 基于 `zig-bsdiff` 的二进制差分更新
- 更新可小至 4 KB
- 自带 S3/R2/静态文件托管，无需更新服务器
- 全量下载作为 fallback

---

## 三、dsh 扩展机制深度解刨

### 3.1 Cordis 插件系统

dsh 基于 Cordis（vendor 到 `vendor/cordis`，v4.0.2），所有功能都是插件：

```typescript
// 插件定义示例
import { Context, Service } from "@deepseek-ai/cordis";

class MyPlugin extends Service {
  static inject = { required: ["llm", "session"] };

  constructor(ctx: Context) {
    super(ctx);
  }

  async start() {
    // 插件启动逻辑
  }

  async stop() {
    // 插件停止逻辑
  }
}

// 注册插件
ctx.plugin(MyPlugin, { config: {} });
```

**插件生命周期**：`load` → `start` → `stop` → `unload`

**依赖注入**：`static.inject` 声明依赖，Cordis 自动解析和注入。

### 3.2 配置系统（YAML + profiles + patches）

dsh 使用 YAML 配置文件，支持 profiles 和 patches：

```yaml
# profiles/sdk-minimal.yml
plugins:
  - id: llm-deepseek
    name: '@deepseek-ai/dsh-llm-deepseek'
  - id: session-persistence-jsonl
    name: '@deepseek-ai/dsh-session-persistence-jsonl'
    config:
      root: "{{DSH_HOME}}/sessions"
  - id: agent-loop
    name: '@deepseek-ai/dsh-agent-loop'
  - id: tools-builtin
    name: '@deepseek-ai/dsh-tools-builtin'
```

**配置加载流程**：
1. 加载 base profile
2. 应用 patches（`cordis.patch.yml`）
3. 解析 `!!js` 表达式（不推荐，可用白名单变量替代）
4. 按顺序加载插件

### 3.3 工具系统

dsh 工具基于 JSON Schema 定义，支持内置工具和自定义工具：

```typescript
// 工具定义
const myTool = {
  name: "read_file",
  description: "读取文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
  },
  async execute(args: { path: string }): Promise<string> {
    return await Bun.file(args.path).text();
  },
};

// 注册工具
ctx.tools.register(myTool);
```

**内置工具**：文件读写、shell 执行、代码运行、网页浏览、搜索等。

**工具沙箱**：支持 `workspace-write`、`read-only`、`full-access` 等权限模式。

### 3.4 会话格式（JSONL）

dsh 会话使用 JSONL（JSON Lines）格式持久化：

```jsonl
{"seq":0,"type":"session/start","data":{"id":"sess-1","createdAt":1788798404845}}
{"seq":1,"type":"turn/start","data":{"turn":1}}
{"seq":2,"type":"user/message","data":{"content":[{"type":"text","text":"What is 2+2?"}],"role":"user"}}
{"seq":3,"type":"request/header","data":{"config":{"provider":"deepseek-official","model":"deepseek-chat"}}}
{"seq":4,"type":"assistant/message","data":{"content":[{"type":"text","text":"4"}],"role":"assistant"}}
{"seq":5,"type":"turn/end","data":{"turn":1}}
```

**会话事件类型**：
- `session/start`, `session/end`
- `turn/start`, `turn/end`
- `user/message`, `assistant/message`
- `request/header`, `request/context`, `request/complete`
- `tool/start`, `tool/end`, `tool/output`
- `session/title`
- `agent/inbox/spliced`

### 3.5 LLM 适配器系统

dsh 支持多 LLM 提供商，通过适配器模式扩展：

```typescript
// 适配器接口
interface LlmAdapter {
  generate(options: GenerateOptions): AsyncGenerator<StreamChunk>;
  supportsModel(model: string): boolean;
}

// 内置适配器
// - llm-deepseek: DeepSeek 官方 API
// - llm-pi-ai: 多提供商客户端（OpenAI/Anthropic等），默认休眠

// 自定义适配器
class MyLlmAdapter implements LlmAdapter {
  async *generate(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // 调用自定义 LLM API
  }
  supportsModel(model: string): boolean {
    return model.startsWith("my-model-");
  }
}
```

### 3.6 代码运行环境

dsh 支持多种代码运行环境：

| 运行时 | 包 | 说明 | Bun 兼容性 |
|--------|-----|------|-----------|
| worker_threads | `code-runtime-worker-thread` | Node.js Worker Threads | ✅ 基本功能正常（16/16 压力测试通过）；⚠️ `eventLoopUtilization()` 未实现，computeMs 预算不生效（功能降级，不崩溃） |
| child_process | `code-runtime-child-process` | 子进程隔离 | ✅ 完全兼容 |
| WebWorker | `code-runtime-webworker` | 浏览器端（实验性） | N/A |
| Python | `code-runtime-python` | Python 代码（实验性） | N/A |

**Bun 下 worker_threads 实证结论**（2026-09-08，Bun 1.4.2，16 项压力测试全部通过）：
- ✅ 基本执行、复杂计算、异常处理、async/await、Promise.all 全部正常
- ✅ 快速连续创建 50 个 Worker、10 个 Worker 并发、20 轮创建/销毁循环全部正常
- ✅ Worker 与 fetch 并发、terminate 后立即创建新 Worker 全部正常
- ✅ `resourceLimits`（maxOldGenerationSizeMb）正常工作
- ✅ stdout/stderr 管道捕获正常
- ⚠️ `worker.performance.eventLoopUtilization()` 未实现（NotImplementedError），但不崩溃，返回全 0；dsh 的 computeMs 预算因此不生效（active 永远为 0），但 maxWallMs 预算仍然有效
- ❌ **之前"worker_threads 导致段错误"的结论是错误的**：sdk-minimal profile 根本不包含 code-runtime-worker-thread，之前遇到的 Bun 段错误发生在 LLM 响应处理阶段，与 worker_threads 无关

**建议**：Bun 下可以正常使用 `code-runtime-worker-thread`，无需强制切换到 child_process。但需注意 computeMs 预算不生效的限制——如果需要精确的计算时间预算，可考虑：① 等待 Bun 实现 eventLoopUtilization；② 自行用 wall-clock 时间近似；③ 使用 child_process 运行时。

---

## 四、IDE 集成架构方案

### 4.1 dsh 子进程管理器

```typescript
// src/bun/dsh-manager.ts
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

interface DshSession {
  id: string;
  title: string;
  createdAt: number;
}

class DshManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, (response: any) => void>();
  private stdoutBuffer = "";

  async start(): Promise<void> {
    this.process = spawn("node", [
      "--import", "tsx",
      "apps/cli/src/bin.ts",
      "--profile", "sdk-minimal",
    ], {
      cwd: DSH_ROOT,
      env: {
        ...process.env,
        DSH_HOME: "~/.dsh-ide",
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (data) => {
      this.stdoutBuffer += data.toString();
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pendingRequests.has(msg.id)) {
            this.pendingRequests.get(msg.id)!(msg);
            this.pendingRequests.delete(msg.id);
          } else if (msg.method) {
            this.emit("notification", msg);
          }
        } catch {}
      }
    });

    // 等待 initialize
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      cwd: process.cwd(),
      provider: "deepseek-official",
      model: "deepseek-chat",
    });
    this.notify("notifications/initialized", {});
  }

  async request(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.process!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timeout`));
        }
      }, 60000);
    });
  }

  notify(method: string, params: any): void {
    this.process!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<{ messageId: string }> {
    return this.request("session/prompt", {
      sessionId,
      contentBlocks: [{ type: "text", text: prompt }],
    });
  }

  async shutdown(): Promise<void> {
    await this.request("shutdown", {});
    this.process?.kill();
  }
}

export const dshManager = new DshManager();
```

### 4.2 主进程入口

```typescript
// src/bun/index.ts
import { BrowserWindow, app } from "electrobun/main";
import { dshManager } from "./dsh-manager";
import { terminalManager } from "./terminal-manager";
import { fileManager } from "./file-manager";

async function main() {
  // 启动 dsh 子进程
  await dshManager.start();

  // 转发 dsh 事件到渲染进程
  dshManager.on("notification", (msg) => {
    mainWindow.rpc?.notify("dsh/event", msg.params);
  });

  // 创建主窗口
  const mainWindow = new BrowserWindow({
    title: "DSH IDE",
    url: "views://mainview/index.html",
    frame: { width: 1400, height: 900 },
    titleBarStyle: "hiddenInset",
  });

  console.log("DSH IDE started!");
}

main();
```

### 4.3 终端管理器（Bun.Terminal）

```typescript
// src/bun/terminal-manager.ts
import { Terminal } from "bun";

interface TerminalInstance {
  id: string;
  terminal: Terminal;
  cwd: string;
}

class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();

  create(id: string, cwd: string): TerminalInstance {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      data(term, data) {
        // 转发到渲染进程
        mainWindow.rpc?.notify("terminal/data", { id, data: new TextDecoder().decode(data) });
      },
      exit(term, code) {
        mainWindow.rpc?.notify("terminal/exit", { id, code });
      },
    });

    terminal.setRawMode(true);

    const shell = process.env.SHELL || "/bin/zsh";
    Bun.spawn([shell, "-i"], {
      terminal,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    const instance = { id, terminal, cwd };
    this.terminals.set(id, instance);
    return instance;
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.terminal.resize(cols, rows);
  }

  destroy(id: string): void {
    this.terminals.get(id)?.terminal.close();
    this.terminals.delete(id);
  }
}
```

### 4.4 渲染进程状态管理

```typescript
// src/mainview/store.ts
import { create } from "zustand";
import { createRPC } from "electrobun/view";

interface AppState {
  sessions: Array<{ id: string; title: string }>;
  activeSessionId: string | null;
  messages: Array<{ role: string; content: string }>;
  isStreaming: boolean;
  terminals: Array<{ id: string; cwd: string }>;
  activeTerminalId: string | null;
}

const rpc = createRPC<AppRPC>();

export const useStore = create<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  terminals: [],
  activeTerminalId: null,

  async sendPrompt(prompt: string) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    set({ isStreaming: true });
    await rpc.request("dsh/sendPrompt", { sessionId: activeSessionId, prompt });
  },
}));

// 订阅 dsh 事件
rpc.on("dsh/event", (event) => {
  if (event.type === "assistant/message") {
    useStore.setState((state) => ({
      messages: [...state.messages, { role: "assistant", content: event.data.content }],
    }));
  }
  if (event.type === "turn/end") {
    useStore.setState({ isStreaming: false });
  }
});
```

---

## 五、功能模块工程细节

### 5.1 聊天面板

**组件结构**：
- `ChatSidebar`：会话列表、新建会话、搜索
- `ChatMessage`：消息渲染（Markdown、代码高亮、工具调用）
- `ChatInput`：输入框（多行、快捷键、附件）
- `ToolCallView`：工具调用可视化（参数、输出、状态）

**关键实现**：
- Markdown 渲染：`react-markdown` + `rehype-highlight`
- 代码块：复制按钮、语言标签、运行按钮
- 流式输出：增量渲染，自动滚动到底部
- 工具调用：展开/折叠，实时输出，错误高亮

### 5.2 代码编辑器

**组件结构**：
- `FileTree`：文件树（展开/折叠、右键菜单、拖放）
- `EditorTabs`：标签页（切换、关闭、脏标记）
- `MonacoEditor`：Monaco 编辑器实例
- `EditorPanel`：编辑器面板（分屏、最小化）

**关键实现**：
- Monaco Editor：`@monaco-editor/react`
- 文件系统：通过 RPC 调用主进程 Bun.fs
- 语法高亮：Monaco 内置
- 智能提示：dsh 提供上下文感知补全（未来）
- 分屏：`BrowserView` 多实例或 Monaco 分屏

### 5.3 终端面板

**组件结构**：
- `TerminalTabs`：终端标签页
- `XtermTerminal`：xterm.js 实例
- `TerminalManager`：主进程 Bun.Terminal 管理

**关键实现**：
- 前端渲染：`xterm` + `xterm-addon-fit` + `xterm-addon-web-links`
- 后端：Bun.Terminal（已验证 8/8 测试通过）
- 数据流：键盘输入 → RPC → Bun.Terminal.write → PTY → 输出 → data 回调 → RPC → xterm.write
- 尺寸同步：窗口 resize → xterm.resize → RPC → Bun.Terminal.resize

### 5.4 工具调用可视化

**组件结构**：
- `ToolCallCard`：单个工具调用卡片
- `ToolCallTimeline`：工具调用时间线
- `ToolOutputView`：工具输出（文本、表格、图片、文件）

**关键实现**：
- 实时状态：pending → running → success/failed
- 参数展示：JSON 格式化，可折叠
- 输出展示：根据输出类型选择渲染器
- 重试/复制：操作按钮

### 5.5 设置面板

**设置分类**：
- 通用：主题、语言、默认模型
- 模型：API Key、模型选择、参数配置
- 工具：启用/禁用工具、权限配置
- 终端：默认 shell、字体、颜色方案
- 编辑器：字体、制表符、自动保存
- 关于：版本、更新、许可证

**关键实现**：
- 配置持久化：`bun:sqlite` 或 JSON 文件
- 实时生效：大部分设置无需重启
- 导入/导出：配置备份

---

## 六、工程落地清单

### 6.1 项目结构

```
dsh-ide/
├── src/
│   ├── bun/                    # 主进程（Bun）
│   │   ├── index.ts            # 入口
│   │   ├── dsh-manager.ts      # dsh 子进程管理
│   │   ├── terminal-manager.ts # 终端管理（Bun.Terminal）
│   │   ├── file-manager.ts     # 文件系统管理
│   │   ├── rpc-handlers.ts     # RPC 处理器
│   │   └── config.ts           # 配置管理
│   ├── mainview/               # 渲染进程（React）
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── chat/           # 聊天面板
│   │   │   ├── editor/         # 编辑器
│   │   │   ├── terminal/       # 终端
│   │   │   ├── tools/          # 工具可视化
│   │   │   ├── settings/       # 设置
│   │   │   └── common/         # 通用组件
│   │   ├── store/              # 状态管理
│   │   ├── hooks/              # 自定义 Hooks
│   │   ├── types/              # 类型定义
│   │   └── utils/              # 工具函数
│   └── shared/                 # 共享类型
│       └── rpc.ts              # RPC 类型定义
├── public/                     # 静态资源
├── electrobun.config.ts        # Electrobun 配置
├── hutch.config.ts             # Hutch 配置
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

### 6.2 开发环境

```bash
# 安装依赖
hutch install

# 开发模式（热重载）
hutch run dev

# 或分开运行
hutch run hmr    # Vite HMR 服务器
hutch run start  # Electrobun dev
```

### 6.3 测试策略

| 层级 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Bun test | 工具函数、状态管理、RPC 类型 |
| 集成测试 | Bun test + dsh mock | dsh-manager、terminal-manager |
| E2E 测试 | Playwright + Electrobun | 完整用户流程 |
| dsh 回归测试 | Bun test | 157 个 Bun 兼容性测试 |

### 6.4 CI/CD

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with: { bun-version: 1.4.2 }
      - run: hutch install
      - run: bun test
      - run: hutch electrobun build --env=stable
```

### 6.5 跨平台注意事项

| 平台 | 注意事项 |
|------|---------|
| **macOS** | 系统 WebView (WKWebView)，代码签名+公证，交通灯按钮位置 |
| **Windows** | WebView2 运行时（Win10+ 内置），代码签名，安装程序 |
| **Linux** | WebKitGTK 依赖，AppImage/deb/rpm 包，桌面文件 |

### 6.6 性能目标

| 指标 | 目标 |
|------|------|
| 冷启动时间 | < 2s（Electrobun + Bun 快速启动） |
| 初始内存 | < 100MB（系统 WebView + Bun） |
| 包体积 | < 50MB（系统 WebView，不含 dsh） |
| dsh 响应延迟 | < 500ms（首 token） |
| 终端延迟 | < 16ms（60fps） |

### 6.7 已知风险和缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Bun 段错误（dsh LLM 响应） | 🔴 高 | dsh 作为 Node.js 子进程运行，不内嵌 |
| dsh 升级兼容性 | 🟡 中 | 锁定 dsh 版本，回归测试 |
| Electron→Electrobun 迁移 | 🟡 中 | 渐进式，先核心功能 |
| 跨平台差异 | 🟡 中 | CI 三平台测试，抽象平台差异 |
| 大文件/大会话性能 | 🟡 中 | 虚拟滚动，分页加载，bun:sqlite 索引 |

---

## 七、里程碑计划

### M1：基础框架（2周）
- [ ] Electrobun + React + Tailwind 项目搭建
- [ ] dsh 子进程管理（启动/停止/重启）
- [ ] JSON-RPC 通信层
- [ ] 基础聊天界面（发送/接收消息）
- [ ] 会话列表管理

### M2：核心功能（4周）
- [ ] 流式输出渲染
- [ ] 工具调用可视化
- [ ] 代码编辑器（Monaco + 文件树）
- [ ] 终端面板（Bun.Terminal + xterm.js）
- [ ] 设置面板

### M3：增强体验（4周）
- [ ] 多窗口/分屏
- [ ] 系统托盘
- [ ] 全局快捷键
- [ ] 自动更新
- [ ] 会话搜索/导出
- [ ] 主题切换

### M4：生产就绪（2周）
- [ ] 代码签名+公证
- [ ] 三平台打包发布
- [ ] 性能优化
- [ ] 错误监控
- [ ] 文档和帮助

---

*文档版本：1.0 | 最后更新：2026-09-08*
