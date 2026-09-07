# DeepSeek Harness 完整架构分析

> 版本：0.1.3-alpha.2 | 分析日期：2026-09-07

## 1. 项目定位

DeepSeek Harness（dsh）是一个**全插件化的 AI Agent 运行时框架**，基于 Cordis 元框架构建。它提供了从 LLM 调用、工具执行、会话持久化到多端 UI（CLI/Web/Desktop/SDK）的完整 Agent 基础设施。

**核心设计哲学**：没有特权核心，一切皆插件。每个功能（模型适配器、工具注册表、会话日志、Agent 循环本身）都是可替换的 Cordis 插件。

## 2. Monorepo 结构

```
deepseek-harness/
├── vendor/              # Vendored Cordis 框架源码（9个包）
├── packages/            # 50+ 个 @deepseek-ai/dsh-* 工作区包
│   ├── core/           # 产品 API 脊柱
│   ├── api/            # 远程 BFF 组装 + Typert RPC 网关
│   ├── typert/         # 类型图生成器、加载器、运行时注册表
│   ├── llm/            # LLM 能力：服务定义 + DeepSeek/pi-ai 提供商
│   ├── shell/          # Bash 能力
│   ├── subprocess/     # 子进程能力 + 本地进程树提供商
│   ├── terminal/       # 持久终端会话
│   ├── fs/             # 文件系统能力 + 策略
│   ├── lsp/            # 语言服务器能力
│   ├── skill/          # Skill 提供商注册表
│   ├── web/            # Web 能力：搜索/抓取
│   ├── compaction/     # 上下文压缩
│   ├── subagent/       # 子 Agent 能力
│   ├── bundle/         # 可安装的 dsh profile 补丁层包
│   ├── workflow/       # 工作流能力
│   ├── session/        # 持久会话数据
│   ├── client/         # 客户端 UI 组件（React）
│   ├── host/           # 宿主端服务（Web服务器、目录选择等）
│   ├── boot/           # 共享 profile/应用启动胶水
│   ├── sdk/            # JSON-RPC 协议 + TypeScript 客户端/服务器
│   └── ...             # 更多能力包
├── apps/
│   ├── cli/            # dsh CLI 入口（`dsh` 命令）
│   ├── web/            # Web 前端应用
│   ├── desktop/        # Electron 桌面应用
│   └── desktop-host/   # 桌面端私有 Host 进程
├── native/
│   └── landlock-run/   # Linux Landlock 沙箱原生 addon
├── python/              # Python SDK/运行时
├── benchmarks/          # 性能基准测试
├── docs/                # 文档（架构、子系统、食谱）
├── scripts/             # 构建脚本、代码生成器、CI 门禁
└── website/             # VitePress 文档站
```

## 3. 核心架构分层

### 3.1 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│                        应用入口层                              │
│  CLI (dsh) │ Web UI │ Electron Desktop │ Python SDK │ ACP  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     Profile / Bundle 组合层                    │
│  Profile = 命名的插件树组合（web/headless/sdk/acp/desktop）  │
│  Bundle = Cordis 配置行 + 代码的分发包（可被上层 patch）      │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Cordis 插件运行时层                         │
│  Context（代理对象）· Fiber（生命周期树）· Service（服务）    │
│  Events（事件总线）· Registry（插件注册）· Reflect（注入）    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                       能力插件层（50+ 包）                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │  Agent   │ │   LLM    │ │  Tools   │ │   Session     │ │
│  │  Loop    │ │ Adapters │ │ Registry │ │  Persistence  │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │Subprocess│ │    FS    │ │  Shell   │ │   Web/Search  │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │ Subagent │ │  Skill   │ │ Workflow │ │   Compaction  │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Cordis 核心机制

#### Context（上下文代理）

`Context` 是一个 **Proxy 对象**，是所有插件共享的运行时容器：

```typescript
// vendor/cordis/src/context.ts
class Context {
  root: this                          // 根上下文引用
  baseUrl?: string                    // 插件/模块解析基路径
  events: EventsService               // 事件总线
  logger: LoggerService               // 日志服务
  reflect: ReflectService             // 服务注入/解析层
  registry: RegistryService           // 插件注册表
  fiber: Fiber                        // 当前生命周期节点

  // 核心方法
  extend(meta?)                       // 创建子上下文（原型继承）
  isolate(name, label?)               // 服务隔离（不同作用域）
  intercept(name, config)             // 服务配置拦截
  get(key)                            // 解析服务（通过 Reflect）
  provide(key, value)                 // 注册服务
  plugin(Plugin, config?)             // 挂载插件
  inject(deps, callback)              // 依赖注入式副作用
  effect(disposer, label?)            // 注册可逆副作用
  on(event, handler)                  // 监听事件
  emit(event, ...args)                // 触发事件
}
```

**关键设计**：
- `Context` 构造函数返回的是 `new Proxy(this, ReflectService.handler)`，属性读取被拦截，通过 `ReflectService` 解析服务
- `extend()` 使用原型继承（`Object.create()`），子上下文继承父上下文所有属性，own 属性覆盖
- `isolate()` 创建服务隔离作用域，同一服务名在不同 label 下可以有不同实现
- `intercept()` 为下游插件的服务配置添加合并项

#### Fiber（生命周期树）

Fiber 是 Cordis 的**生命周期管理单元**，形成一棵树：

- 每个插件挂载时创建一个 Fiber 节点
- Fiber 有状态机：PENDING → ACTIVE → UNLOADING → DISPOSED / FAILED
- `ctx.effect()` 注册的 disposer 挂在 Fiber 上，Fiber dispose 时按注册逆序执行
- 父 Fiber dispose 时级联 dispose 所有子 Fiber

#### Service（服务基类）

所有 `ctx.xxx` 服务都继承自 `Service`：

```typescript
class Service {
  static inject = ['dep1', 'dep2']   // 声明依赖的服务名
  static Config = z.object({...})     // 配置 Schema（schemastery）
  
  constructor(ctx, config) {
    super(ctx, 'serviceName')          // 注册到 ctx
  }
}
```

服务通过 `ctx.provide('name', instance)` 注册，通过 `ctx.get('name')` 或直接 `ctx.name` 解析。

#### Events（事件总线）

Cordis 事件支持三种模式：
- **emit**：普通广播，监听器同步/异步执行
- **parallel**：并行执行所有监听器
- **waterfall**：瀑布流，每个监听器必须调用 `next()` 才能传递给下一个，返回值可被前一个修改

dsh 大量使用 waterfall 事件作为扩展点：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`。

### 3.3 Profile 与 Bundle 组合机制

#### Profile（配置文件）

Profile 是一个**命名的插件树组合**，存储在 Harness home（`~/.dsh/profiles/`）中：

- 列出它堆叠的 bundles
- 持有任何 out-of-tree 插件
- 保留用户自己的 `cordis.patch.yml`

**内置 Profile 模板**：
| Profile | 用途 | 特性 |
|---|---|---|
| `web` | Web 应用 | 实时 patch 重载，启动 HTTP 服务器 |
| `headless` | 一次性任务运行 | 无服务器，启动时应用所有层 |
| `sdk` | SDK JSON-RPC 服务器 | stdio 通信 |
| `sdk-minimal` | 最小 SDK | 不应用 dsh-base，独立完整树 |
| `acp` | 自动化 ACP 服务器 | Agent Client Protocol |
| `desktop` | Electron 桌面 | 私有 profile，Electron 独占 |

#### Bundle（分发包）

Bundle 是 **Cordis 配置行 + 代码**的分发格式，使得它插入的任何内容都可以被上层 patch。

每个 bundle 在 `package.json` 的 `dsh` 字段中声明：
- `dsh.profile`：列出 profile 的 bundles
- `dsh.bundle`：指向 bundle 的 patch 文件

**核心 Bundle**：
| Bundle | 角色 |
|---|---|
| `dsh-base` | 所有 profile 的共享第一层：模型适配器、工具、持久化、沙箱、审批策略、设置、凭证、遥测 |
| `dsh-web-app` | 添加浏览器应用（Web 服务器 + 前端） |
| `dsh-headless` | 添加一次性运行器 |
| `dsh-sdk-app` | 添加 SDK JSON-RPC 服务器 |
| `dsh-acp-app` | 添加自动化 ACP 服务器 |
| `dsh-sdk-minimal` | 独立完整 SDK 树（不应用 dsh-base） |

#### 层叠应用顺序

```
空 entry 列表
  ↓
1. profile 中按顺序列出的每个 bundle 的 patch
  ↓
2. profile 的 cordis.patch.yml
  ↓
3. home 级别的 cordis.patch.yml
  ↓
4. --patch 命令行覆盖
```

Patch 通过 `id` 定位目标行并**替换其整个 config**（不是合并），或插入新行。

### 3.4 能力接缝（Capability Seam）

dsh 的核心抽象是**能力接缝**：每个可交换能力包含三个角色：

1. **Service Definition**：声明接口（`ctx.xxx` 的类型和方法）
2. **Service Provider**：实现接口（具体后端）
3. **Consumer**：使用接口（通常是面向模型的工具）

```
┌─────────────────────────────────────────────┐
│              Service Definition               │
│  (接口声明，如 ctx.shell / ctx.fs / ctx.llm) │
└──────────────────┬──────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌─────────┐  ┌─────────┐  ┌─────────┐
│Provider1│  │Provider2│  │Provider3│  ← 可交换实现
│(本地)    │  │(远程沙箱)│  │(E2B)   │
└─────────┘  └─────────┘  └─────────┘
                   │
                   ▼
            ┌──────────┐
            │ Consumer │  ← 面向模型的工具
            │ (tool_*) │
            └──────────┘
```

**关键洞察**：因为 FS 和 Subprocess provider 共享一个执行世界，将它们指向远程沙箱可以同时移动 Bash、PTY 和 LSP，无需 provider fork。

### 3.5 核心包详解

#### Agent Loop（`packages/core/agent-loop`）

Agent Loop 是 dsh 的**执行引擎**，实现 `Agent` 接口的默认驱动。

**核心类**：`AgentLoop extends Service implements AgentFactory`

```typescript
class AgentLoop {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
  
  // 配置
  config: {
    maxParallelToolCalls: number   // 每步最大并行工具调用数
    agents: AgentOptions[]          // 启动时创建/恢复的 agents
  }
  
  // 工厂方法
  async create(id, options, meta)     // 创建新 agent + session
  async createAgent(ownerCtx, options) // 创建带 setup 的 agent
  async resume(ownerCtx, options)      // 从持久化恢复 agent
}
```

**内部执行单元**：`ReactLoopAgent`（`agent.ts`）

每个 agent 有自己的：
- `inbox`：输入队列（消息、注入上下文）
- `scope`：per-agent 作用域上下文（`ctx.isolate()`）
- 独立的工具调用调度器

**生命周期管理**：`FactoryOwnership` 类管理所有 live agent 的 teardown，支持：
- 调用者取消信号
- owner fiber 卸载
- factory teardown
三者融合为一个 AbortSignal

#### Session（`packages/core/session`）

Session 是**追加式事件日志**和内存存储：

- `SessionEvent`：不可变事件，追加到日志
- `deriveMessages()`：从日志投影模型历史
- `assistant/message`：嵌入产生其内容的精确紧凑计时流
- `assistant/attempt`：保留已结算的失败/重试/取消/流错误尝试

**核心原则：Model-visible ⟺ logged**
任何到达模型请求的内容必须可以从会话日志重建。新的模型可见输入需要新的会话事件。

#### Tools（`packages/core/tools`）

工具注册表和受保护的执行管道：

- 作用域工具注册（per-agent 隔离）
- 工具 Schema 组装（进入 system prompt）
- 执行管道：`tools/pre-execute` → `tools/execute` → `tools/post-execute`（全部 waterfall）
- 并行工具调用调度（受 `maxParallelToolCalls` 限制）

#### LLM（`packages/llm/llm`）

LLM 服务定义和适配器接缝：

- `ctx.llm`：LLM 服务，管理适配器注册表
- 适配器实现 `LLMAdapter` 接口：`stream()` 方法返回异步生成器
- `llm-deepseek`：默认 DeepSeek 直连适配器
- `llm-pi-ai`：可选 pi-ai 多供应商适配器（默认休眠）
- `llm-retry`：重试策略包装

#### System Prompt（`packages/core/system-prompt`）

Prompt 段和工具 Schema 组装：

- `section()`：注册命名 prompt 段（带 order）
- `variable()`：注册变量（如 `{provider}`、`{model}`、`{cwd}`）
- 组装时按 order 排序所有段，替换变量

## 4. 事件体系

dsh 的事件分为三个域：

### 4.1 Session 事件（持久化）

追加到日志，可在重载后恢复：
- `turn/start` / `turn/end`
- `step/start` / `step/end`
- `user/message`
- `assistant/message` / `assistant/attempt`
- `tool/call` / `tool/result`
- `request/header`

### 4.2 Agent 事件（实时扩展点）

携带 live Agent，用于观察或拦截进行中的工作：
- `agent/pre-step`（waterfall）— 决定模型看到什么，可重写或拒绝
- `agent/request`（waterfall）— 拦截模型请求
- `agent/assistant-stream` — 实时流帧（start/chunk/end），仅 Web Session-follow 适配器消费
- `agent/turn-stopping`（serial，无 next）— 停止 turn
- `agent/session-start` / `agent/disposed`

### 4.3 能力事件（策略/适配器挂载）

不导入 loop 即可挂载策略和适配器：
- `fs/*`、`tools/*`、`telemetry/*`、`llm/*`

## 5. 多端架构

### 5.1 CLI

入口：`apps/cli/src/bin.ts`，通过 `node --import tsx/esm` 源码启动（开发）或构建后 `lib/` 启动。

命令：`dsh web`、`dsh --profile headless "task"`、`dsh --profile sdk` 等。

### 5.2 Web 应用

- `dsh-web-frontend`：React 前端（`packages/client/web`）
- `dsh-host-webserver`：HTTP 服务器（`packages/host/webserver`）
- `dsh-api-gateway`：Typert RPC 网关（`packages/api/gateway`）
- 通过 `dsh web` 启动，监听 HTTP 端口

### 5.3 Electron 桌面应用（重点）

**架构决策：不开任何监听端口**

```
┌──────────────────────────────────────────────────────┐
│                  Electron 主进程                        │
│  ┌────────────┐  ┌─────────────┐  ┌───────────────┐ │
│  │ 窗口管理    │  │ 自动更新     │  │ 单实例锁      │ │
│  │ 菜单/对话框 │  │ electron-   │  │ 插件管理 UI   │ │
│  │            │  │ updater     │  │               │ │
│  └─────┬──────┘  └─────────────┘  └───────┬───────┘ │
│        │                                      │         │
│        │  Node IPC (仅生命周期控制)            │         │
│        ▼                                      ▼         │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Desktop Host 子进程                     │  │
│  │  (bundled upstream Node.js，非 Electron Node)     │  │
│  │                                                    │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │         dsh 后端 (Cordis 插件树)            │  │  │
│  │  │  ctx.apiGateway / ctx.connection /          │  │  │
│  │  │  ctx.clientModules / ctx.typertGateway      │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐  │
│  │  Framed Byte Pipes (请求/响应分块，带背压)        │  │
│  │  FD 3: 请求管道  │  FD 4: 响应管道                │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐  │
│  │  dsh-app:// 自定义协议处理器                        │  │
│  │  /api/* → Typert RPC                              │  │
│  │  /.dsh/remote-stream → 远程流                     │  │
│  │  /* → 静态前端资源                                 │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐  │
│  │              Renderer 进程 (React UI)              │  │
│  │  注入 __DSH_TRANSPORT__ 全局对象                   │  │
│  │  通过 fetch(dsh-app://...) 与后端通信              │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**关键技术决策**：

| 决策 | 原因 | 后果 |
|---|---|---|
| 版本绑定 | Shell API、Web 客户端、后端、插件图作为一个组合验证 | Electron 和 dsh 始终同版本，dsh 升级即 Desktop 发布 |
| 运行时隔离 | Electron 的 Node.js 带补丁/fuses/ABI/生命周期约束 | dsh 运行在 bundled upstream Node.js 下，所有包操作用 bundled pnpm |
| 无监听端口 | 避免端口所有权、认证、CORS、暴露问题 | `dsh-app://` 承载 Web 资产和 Fetch，framed byte pipes 承载请求/响应 |
| 状态隔离 | 共享可执行依赖图会让 CLI 和 Desktop 互相改变版本 | Electron 独占 `$DSH_HOME/profiles/desktop`，与 CLI 共享产品数据但不共享可执行包 |
| 事务激活 | 依赖解析、生命周期脚本、原生模块、插件启动可能失败 | Release/插件变更在 staging 安装，健康检查通过后才替换 active profile，支持回滚 |

**Desktop Host 进程**（`apps/desktop-host`）：
- 私有包，不发布到 npm
- 入口：`src/index.ts` 的 `runDesktopHost()`
- 通过 `boot()` 启动 dsh 后端（使用 desktop 专属 patch）
- 暴露三个 fetch handler：API（`/api`）、静态资源、远程流（`/.dsh/remote-stream`）
- 通过 framed byte pipes 与 Electron 主进程通信
- 协议版本：`DESKTOP_HOST_PROTOCOL_VERSION`

### 5.4 SDK

- TypeScript SDK：`packages/sdk/client` + `packages/sdk/protocol` + `packages/sdk/server`
- Python SDK：`python/` 目录，打包 dsh CLI 为 runtime wheel
- JSON-RPC over stdio 通信

## 6. 持久化架构

### 6.1 Session 持久化

- **JSONL 格式**：`session.vN.jsonl[.zstd]`（v0 用 `session.jsonl[.zstd]`）
- **版本迁移**：相邻迁移包，每个负责一个 `vN → vN+1` 步骤
- **生成选择**：`stat`/`list` 重新扫描每个 Session 目录，选择数字最高的规范 generation
- **写入原子性**：先编码验证，再独占发布最终版本命名的后继文件，源文件不变
- **中断修复**：未密封的中断 tail 由 handle consumer 负责；迁移仅为已密封的重启插入缺失的 `turn/end`

### 6.2 其他持久化

| 存储 | 后端 | 用途 |
|---|---|---|
| Session | JSONL + zstd | 会话事件日志 |
| Attachment | 本地文件系统 | 持久图片字节（内容寻址引用） |
| Storage | JSON (dsh-storage-json) | 通用 KV 存储 |
| Session Query | SQLite (可选) | 全文搜索、精确读取、标题、谱系追踪 |
| Projection Cache | Storage domain | 会话列表投影列的节流写回缓存 |
| Settings | YAML 文件 (`$DSH_HOME/settings.yaml`) | 用户设置，热重载 |
| Credentials | YAML 文件 (`$DSH_HOME/.credentials.yaml`) | 凭证，不 materialize 到 process.env |

## 7. 类型安全与代码生成

dsh 有一套完整的类型驱动代码生成体系：

| 生成器 | 脚本 | 输出 |
|---|---|---|
| Cordis Catalog | `gen-cordis-catalog` | 插件目录文档 |
| Cordis API | `gen-cordis-api` | Cordis API 文档 |
| Client Catalog | `gen-client-catalog` | 客户端组件目录 |
| Tool Catalog | `gen-tool-catalog` | 工具目录文档 |
| Config Catalog | `gen-config-catalog` | 配置项目录 |
| Persistence Catalog | `gen-persistence-catalog` | 持久化格式目录 |
| Session Format Catalog | `gen-session-format-catalog` | 会话格式目录 |
| Module Graph | `gen-module-graph` | 模块依赖图 |
| Doc Graphs | `gen-doc-graphs` | 文档关系图 |
| Scoped Events | `gen-scoped-events` | 作用域事件类型 |
| Typert | `packages/typert/generator` | 类型图 → RPC 网关 |

**Typert** 是 dsh 的类型图系统：从 TypeScript 类型生成运行时 RPC 网关，使得 Host 和 Client 之间的通信完全类型安全。

## 8. 构建系统

### 8.1 双构建面（Host / Client）

dsh 明确区分两个编译面：
- **Host**：Node.js 运行时代码（`tsconfig.host.json`）
- **Client**：浏览器/React UI 代码（`tsconfig.client.json`）

每个同时有 Host 和 Client 程序的包暴露面特定的 leaf config 和 solution-only root。

### 8.2 构建工具链

- **TypeScript 6.0**：类型检查 + `lib/` 输出
- **tsdown**：基于 Rollup 的打包器，打包运行时
- **tsx**：开发时源码直接运行（ESM-only hook）
- **oxlint**：Linter（替代 ESLint，极快）
- **vitest**：测试框架
- **pnpm 11.7**：包管理器（workspace + strictDepBuilds）

### 8.3 构建命令

```bash
pnpm run build              # 完整构建（tsx scripts/build.ts）
pnpm run build:lib          # 构建库（host + client）
pnpm run build:lib:host     # 仅 host 面
pnpm run build:lib:client   # 仅 client 面
pnpm run build:web          # 构建 Web 前端
pnpm run build:desktop      # 构建桌面应用
```

## 9. 测试与质量门禁

### 9.1 测试类型

| 测试 | 命令 | 用途 |
|---|---|---|
| 单元测试 | `pnpm test` | vitest 单元测试 |
| 覆盖率 | `pnpm test:coverage` | CI 覆盖率门禁：`packages/*/*/src` 每文件 100% |
| E2E | `pnpm test:e2e` | 真实 API 测试（无 DEEPSEEK_API_KEY 时自跳过） |
| Snapshot | `pnpm test:snapshot` | 无密钥录制会话重放 |
| Expected | `pnpm test:expected` | owner-local 进程期望 |
| Web | `pnpm test:web` | Web UI 快照测试 |
| Bench | `pnpm test:bench` | 性能基准 |

### 9.2 CI 门禁（`scripts/run-gates.ts`）

- `check:ci`：CI 主门禁
- `check:ci:static`：静态检查
- `check:ci:lint`：Lint（contracts-ready）
- `check:ci:coverage`：覆盖率
- `check:ci:bench`：性能
- `check:ci:snapshot`：快照
- `check:ci:artifacts`：构建产物
- `check:ci:consumers`：消费者兼容性
- `check:windows-wine`：Windows 兼容性（仅诊断已知 Windows 失败时）

### 9.3 验证脚本（50+ 个）

包括：包依赖验证、运行时闭包验证、应用入口验证、客户端包验证、Cordis 配置验证、导出 JSDoc 验证、类型等价验证、文档引用验证、Mermaid 验证等。
