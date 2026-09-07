# DeepSeek Harness 工程关键设计细节

> 版本：0.1.3-alpha.2 | 分析日期：2026-09-07

本文档记录 dsh 中最关键、最非显而易见的工程设计决策。这些是理解"为什么 dsh 这样设计"的核心。

## 1. 插件即一切：无特权核心架构

### 1.1 设计原则

dsh 的核心设计哲学是：**没有特权核心，一切皆插件**。

- 模型适配器是插件（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）
- 工具注册表是插件（`dsh-tools`）
- 会话日志是插件（`dsh-session`）
- **Agent 循环本身也是插件**（`dsh-agent-loop`）

这意味着每个部分都可以通过配置替换，不需要 patch 核心代码。

### 1.2 实现机制

```typescript
// 每个插件都是一个函数，接收 Context 和 config，返回 disposer
function MyPlugin(ctx: Context, config: Config) {
  // 注册服务
  ctx.provide('myService', new MyService(ctx))
  
  // 监听事件
  ctx.on('some/event', (payload) => { ... })
  
  // 注册副作用（自动清理）
  ctx.effect(() => {
    const interval = setInterval(...)
    return () => clearInterval(interval)
  }, 'myPlugin.interval')
  
  // 返回 disposer（可选，Cordis 自动管理 effect）
}
```

**关键**：所有注册都是**效果（effects）**，当插件卸载时自动回滚。`ctx.effect()` 返回的 disposer 挂在 Fiber 上，Fiber dispose 时按注册逆序执行。

### 1.3 服务注入与依赖驱动激活

```typescript
class AgentLoop extends Service {
  // 声明依赖：这些服务必须先于 AgentLoop 激活
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
}
```

Cordis 的 `ReflectService` 在 `ctx.get(name)` 时：
1. 查找已注册的服务
2. 如果未注册，查找提供该服务的插件
3. 等待该插件激活（通过 Fiber state）
4. 返回服务实例

这形成了**依赖驱动的自动激活顺序**，无需手动排序插件。

## 2. 注册即效果：可逆的生命周期管理

### 2.1 设计原则

> "Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer."

每个注册都是可逆的。工具注册、事件监听、服务提供、prompt 段注册——全部返回 disposer，插件卸载时自动清理。

### 2.2 实现模式

```typescript
// 工具注册
const disposeTool = ctx.tools.register({
  name: 'my_tool',
  schema: {...},
  execute: async (args) => {...}
})
ctx.effect(() => disposeTool, 'myPlugin.tool')

// 事件监听
const disposeListener = ctx.on('agent/pre-step', waterfall, async (next, messages) => {
  // ...
  return next()
})
ctx.effect(() => disposeListener, 'myPlugin.preStep')

// Prompt 段
const disposeSection = ctx.systemPrompt.section({
  name: 'my-section',
  order: 100,
  text: '...'
})
ctx.effect(() => disposeSection, 'myPlugin.prompt')
```

### 2.3 Fiber 生命周期树

```
Root Fiber (Context)
├── Plugin A Fiber
│   ├── effect 1 (tool registration)
│   └── effect 2 (event listener)
├── Plugin B Fiber
│   ├── effect 1 (service provide)
│   └── Child Fiber (scoped context)
│       └── effect 1 (scoped registration)
└── ...
```

Fiber dispose 时：
1. 先 dispose 所有子 Fiber（递归）
2. 再按注册逆序执行本 Fiber 的所有 effect disposer
3. 状态变为 DISPOSED

这保证了**清理顺序与创建顺序相反**，避免依赖问题。

## 3. Model-visible ⟺ Logged：可重建性不变量

### 3.1 设计原则

> "Anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event."

任何到达模型请求的内容，必须能从会话日志重建。这是 dsh 最核心的不变量之一，由运行时断言强制执行。

### 3.2 为什么重要

1. **会话恢复**：从持久化日志恢复时，模型看到的历史必须完全一致
2. **可审计性**：所有模型输入都有持久记录
3. **调试**：可以从日志精确重放模型请求
4. **遥测**：OTel 导出会话日志前缀时，模型输入可追溯

### 3.3 实现机制

```typescript
// runtime invariant: 断言模型可见输入已记录
// packages/core/agent-loop/src/invariant.ts

// 每个新的模型可见输入必须:
// 1. 扩展 SessionEventMap (声明合并)
// 2. 在事件发生时追加到会话日志
// 3. 在 deriveMessages() 中从日志投影为模型消息

// 示例: user/message 事件
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'user/message': {
      readonly content: string
      readonly attachments?: Attachment[]
    }
  }
}

// agent-loop 中:
session.append({ type: 'user/message', seq: nextSeq(), data: { content: enteredMessages } })

// deriveMessages() 中:
case 'user/message':
  messages.push({ role: 'user', content: event.data.content })
```

### 3.4 实时流 vs 持久消息的分离

dsh 明确区分两个通道：

| 通道 | 事件 | 持久性 | 消费者 |
|---|---|---|---|
| 实时流 | `agent/assistant-stream` (start/chunk/end) | 进程内，不持久 | 仅 Web Session-follow 适配器（UI 增量渲染） |
| 持久消息 | `assistant/message` / `assistant/attempt` | 追加到日志，可恢复 | 所有会话消费者 |

**关键设计**：循环在提交完整紧凑流作为一条消息之前，不发布 `agent/assistant-stream end`。硬进程丢失在提交前发生会留下没有持久尝试流的记录——这是刻意的设计决策，避免部分状态。

## 4. 能力接缝（Capability Seam）：三角色模式

### 4.1 设计原则

> "A capability seam comprises Service Definition / Service Provider / Consumer roles. It is complete, never one role; split only when roles evolve independently."

每个可交换能力必须包含三个角色，缺一不可。这是 dsh 扩展能力的标准模式。

### 4.2 三角色详解

```
┌─────────────────────────────────────────────────────┐
│              Service Definition                        │
│  (接口声明包，如 dsh-shell / dsh-fs / dsh-subprocess) │
│                                                       │
│  export interface ShellService {                      │
│    execute(request: ShellRequest): Promise<ShellResult>│
│    spawn(request: ShellSpawnRequest): ShellProcess    │
│  }                                                     │
│                                                       │
│  declare module '@deepseek-ai/cordis' {              │
│    interface Context {                                 │
│      shell: ShellService                              │
│    }                                                   │
│  }                                                     │
└───────────────────────┬─────────────────────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │Provider A│  │Provider B│  │Provider C│  ← 可交换实现
    │(本地 bash)│  │(远程沙箱)│  │(E2B)    │
    └──────────┘  └──────────┘  └──────────┘
          │             │             │
          └─────────────┼─────────────┘
                        ▼
                  ┌──────────┐
                  │ Consumer │  ← 面向模型的工具
                  │(tool_bash)│
                  └──────────┘
```

### 4.3 为什么这很强大

**提供者交换改变整个产品**：因为 FS 和 Subprocess provider 共享一个执行世界，将它们同时指向远程沙箱可以：
- Bash 工具自动使用远程沙箱
- PTY 终端自动使用远程沙箱
- LSP 语言服务器自动使用远程沙箱
- 无需修改任何 Consumer 代码

这就是"一个 provider swap 改变整个产品"的含义。

### 4.4 配置中的接缝表达

```yaml
# cordis.patch.yml 中
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'  # Service Provider

- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'        # Service Provider (组合)

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'          # Consumer
```

要切换到远程沙箱，只需 patch 替换 provider 行：
```yaml
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-remote'
  config:
    endpoint: https://sandbox.example.com
```

## 5. Profile/Bundle 层叠组合：可补丁的配置系统

### 5.1 设计原则

Profile 和 Bundle 系统使得 dsh 的整个插件树可以通过有序层叠的 YAML 补丁组合，每一层都可以被上层覆盖。

### 5.2 层叠顺序

```
空 entry 列表
  │
  ├─ Layer 1: bundle 1 的 cordis.patch.yml
  ├─ Layer 2: bundle 2 的 cordis.patch.yml
  ├─ ...
  ├─ Layer N: profile 的 cordis.patch.yml
  ├─ Layer N+1: home 级别的 cordis.patch.yml
  └─ Layer N+2: --patch 命令行覆盖
```

### 5.3 Patch 语义

```yaml
# Patch 格式 (cordis.patch.yml)
- id: llm-deepseek              # 按 id 定位目标行
  config:                        # 替换整行 config（不是合并！）
    apiKeyEnv: MY_CUSTOM_KEY
    baseURL: https://my-proxy.com

- insert:                        # 插入新行
    - id: my-custom-tool
      name: '@my-org/dsh-tool-custom'
      config:
        option: value
```

**关键**：Patch 替换目标行的**整个 config**，不是深度合并。这意味着如果要修改一个字段，必须重述整行 config。这是刻意的设计——避免部分覆盖导致的配置不完整。

### 5.4 实时 Patch 重载

- `web` profile：支持实时 patch 重载（通过 HMR 监听文件变化）
- `headless`/`sdk`/`sdk-minimal`/`acp`：启动时一次性应用所有层（因为替换一次性应用的依赖会使生命周期无效）

### 5.5 `!!js` 表达式

Cordis 的 YAML 方言支持 `!!js` 标量，在加载时求值为表达式节点：

```yaml
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')   # 调用 ctx.dshHomePath('sessions')

- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()

- id: bash-sandbox
  disabled: !!js process.platform === 'win32'
```

**安全约束**：`!!js` 只允许在 plugin `config` 和 entry `disabled` 下使用，其他元数据保持字面量。

## 6. 双构建面：Host / Client 分离

### 6.1 设计原则

dsh 明确区分两个编译面，因为它们的运行环境完全不同：

| 构建面 | 运行环境 | 可用 API | 包 |
|---|---|---|---|
| **Host** | Node.js | fs, path, child_process, net | 所有后端包（agent-loop, llm, session, tools...） |
| **Client** | 浏览器/Electron Renderer | DOM, fetch, WebSocket | UI 组件包（ui-chat, ui-session, ui-settings...） |

### 6.2 TypeScript 项目布局

```
tsconfig.json              # solution-only root (仅引用)
├── tsconfig.base.json     # 共享基础配置
├── tsconfig.host.json     # Host 面项目引用
│   └── packages/*/*/tsconfig.json (host)
└── tsconfig.client.json   # Client 面项目引用
    └── packages/*/*/tsconfig.json (client)
```

**规则**：
- 同时有 Host 和 Client 程序的包暴露面特定的 leaf config 和 solution-only root
- 仓库级程序种子一个面 config，从不是 root solution
- 静态门禁和测试通过 tsconfig `paths` 解析 workspace 导入到 `src`
- 消费构建后 `lib/` 的门禁声明该依赖

### 6.3 构建命令

```bash
pnpm run build:lib:host     # tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
pnpm run build:lib:client   # tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client
pnpm run build:lib          # 两者都构建
```

## 7. 类型图驱动的 RPC：Typert

### 7.1 设计原则

Typert 是 dsh 的类型图系统，从 TypeScript 类型定义自动生成运行时 RPC 网关，使得 Host 和 Client 之间的通信完全类型安全。

### 7.2 架构

```
TypeScript 类型定义 (Host 服务接口)
       │
       ▼
┌──────────────────┐
│ typert-generator  │  代码生成器
│ (构建时)           │  从类型生成类型图 + 运行时代码
└────────┬─────────┘
         ▼
┌──────────────────┐
│ typert-registry   │  运行时类型注册表
│ (ctx.typert)      │  注册服务方法 + 类型 schema
└────────┬─────────┘
         ▼
┌──────────────────┐
│ typert-loader    │  加载器
│                    │  加载生成的类型图
└────────┬─────────┘
         ▼
┌──────────────────┐
│ api-gateway       │  RPC 网关
│ (ctx.typertGateway)│  - HTTP/JSON API (/api/*)
│                    │  - WebSocket 远程流
│                    │  - Desktop byte pipes
└──────────────────┘
```

### 7.3 优势

1. **零手写 API 层**：服务方法定义即 API 定义
2. **端到端类型安全**：Client 调用有完整类型检查
3. **自动序列化/反序列化**：参数和返回值自动验证
4. **流式支持**：AsyncGenerator 自动映射为远程流

## 8. 会话持久化：追加式日志 + 版本迁移

### 8.1 设计原则

会话日志是**只追加（append-only）**的不可变事件流。已提交的生成路径永远不会被重命名、替换或删除。

### 8.2 物理格式

```
$DSH_HOME/sessions/<session-id>/
├── session.v1.jsonl          # 当前版本（v1）
├── session.v1.jsonl.zst      # 可选 zstd 压缩
├── session.jsonl              # 旧版本（v0，迁移后保留）
└── header.json                # 会话元数据
```

- v0: `session.jsonl[.zstd]`
- v1+: `session.vN.jsonl[.zstd]`（小写 v）

### 8.3 版本迁移机制

```
读取旧版本会话
    │
    ▼
stat/list: 选择数字最高的规范 generation
    │
    ▼
open: 解码 + 组合静态相邻迁移链
    │
    ├─ v0 → v1 迁移包
    ├─ v1 → v2 迁移包
    └─ ...
    │
    ▼
返回验证后的当前逻辑事件（内存中）
    │
    ├─ 读打开: 不发布后继文件
    └─ 写打开: 编码 → 验证 → 独占发布最终版本命名的后继文件
                (源文件不变，新文件 beside 源文件)
```

**关键规则**：
- body 读取可以添加版本命名的后继，但永远不移动、覆盖或删除已提交的生成
- 前驱版本不暗示回退或降级支持
- 每个相邻迁移包只负责一个 `vN → vN+1` 步骤
- SQLite domains 使用单调 `SCHEMA_VERSION`

### 8.4 中断修复

```
检测到未关闭的 turn (有 turn/start，无 turn/end)
    │
    ▼
interruptedTurnClosers(events)
    │
    ├─ 缺失的 tool/result → 合成错误结果
    ├─ 缺失的 step/end → 合成 step/end
    └─ 缺失的 turn/end → 合成 turn/end
    │
    ▼
通过 handle.append() 持久化修复事件
```

**约束**：迁移只为有界的已发布重启（已被后续 turn/start 密封）插入缺失的 turn/end。普通未密封中断 tail 的修复是 handle consumer 的责任。

## 9. 桌面端：无端口架构 + 事务激活

### 9.1 无监听端口设计

dsh Desktop 的核心安全设计是**不开任何监听端口**：

| 传统 Electron 应用 | dsh Desktop |
|---|---|
| 启动 localhost HTTP 服务器 | 无 Web 服务器 |
| Renderer 通过 http://localhost:PORT 通信 | 通过 dsh-app:// 自定义协议 |
| 需要处理 CORS、认证、端口冲突 | 协议处理程序天然隔离 |
| 端口暴露给其他进程 | 无端口可暴露 |

### 9.2 Framed Byte Pipes

Electron 主进程与 Desktop Host 子进程之间通过**文件描述符管道**通信：

- FD 3: 请求管道（Electron → Host）
- FD 4: 响应管道（Host → Electron）

```
请求帧格式:
┌──────────┬──────────┬──────────────────────┐
│ type     │ streamId │ payload               │
│ (start/  │ (uint32) │                       │
│  data/   │          │ start: url, method,   │
│  end/    │          │   headers, hasBody    │
│  cancel) │          │ data: chunk bytes     │
└──────────┴──────────┴──────────────────────┘

响应帧格式:
┌──────────┬──────────┬──────────────────────┐
│ type     │ streamId │ payload               │
│ (start/  │ (uint32) │                       │
│  data/   │          │ start: status, headers│
│  end/    │          │ data: chunk (<=64KB)  │
│  error)  │          │ error: message         │
└──────────┴──────────┴──────────────────────┘
```

**背压控制**：响应管道写入时检查 `responsePipe.write()` 返回值，如果缓冲区满则等待 `drain` 事件。请求管道在请求体消费慢时暂停（`requestPipe.pause()`）。

### 9.3 事务激活与回滚

Desktop 的 dsh 运行时安装/更新使用事务机制：

```
staging 目录准备
    │
    ├─ 1. 提取 seed store shards
    ├─ 2. 合并 pnpm store
    ├─ 3. 创建 staging profile
    ├─ 4. pnpm install --offline
    ├─ 5. 恢复旧插件版本
    └─ 6. 健康检查 (启动 staging 后端 → 停止)
    │
    ▼
成功?
    ├─ 是 → 持久化激活阶段 → 移动 active → rollback
    │                    → 移动 staging → active
    │
    └─ 否 → 删除 staging → active 不变
```

**回滚**：如果激活中断，恢复日志 + 实际目录状态可以恢复或保留完整 profile。

### 9.4 运行时隔离

| 隔离维度 | 实现 |
|---|---|
| Node.js 运行时 | bundled upstream Node.js（非 Electron Node.js，非系统 Node） |
| 包管理器 | bundled pnpm（非系统 pnpm） |
| pnpm store | `$DSH_HOME/desktop/pnpm/store`（私有） |
| Profile | `$DSH_HOME/profiles/desktop`（Electron 独占） |
| 进程锁 | Electron 单实例锁 + 事务锁 |
| 与 CLI 共享 | 仅产品数据（sessions, settings, credentials），不共享可执行包 |

## 10. 凭证与环境：分层加载 + 不 materialize

### 10.1 环境变量分层加载

```
优先级 (高 → 低):
1. 进程继承环境 (process.env)
2. 项目目录 .env (cwd/.env)
3. Harness home .env (~/.dsh/.env)
```

**Bootstrap-only 变量**（只能来自进程继承环境，不能来自 .env）：
- 进程启动：`PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `NODE_PATH`
- 解释器钩子：`BASH_ENV`, `PYTHONPATH`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`
- VCS/编辑器：`GIT_SSH`, `GIT_CONFIG_GLOBAL`, `EDITOR`, `VISUAL`
- 网络/信任：`DEEPSEEK_BASE_URL`, `SSL_CERT_FILE`, `HTTP_PROXY`, `NODE_TLS_REJECT_UNAUTHORIZED`
- dsh 内部：所有 `DSH_*` 前缀变量

**例外**：Harness home .env 允许设置 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`（因为代理选择的是每个请求的路由，home 文件是用户自己的）。

### 10.2 凭证不 materialize

```yaml
# 配置中引用凭证，不内联密钥
- id: llm-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY    # 引用，不是值
```

运行时：
1. 每次 LLM 请求时，通过 `ctx.credentials` 解析 `apiKeyEnv` 引用
2. 凭证来源：进程环境 > `$DSH_HOME/.credentials.yaml` > 项目 .env > home .env
3. 解析结果**不写入 process.env**，直接用于请求
4. 引用解析为空 → `MISSING_CREDENTIAL` 错误

**优势**：
- 密钥不留在进程环境中（子进程不会继承）
- 凭证文件可以单独管理权限
- Web Models 页面只写 managed document，不 materialize

## 11. 遥测：默认仅反馈触发

### 11.1 设计原则

OTel 遥测**默认仅在用户明确反馈后才导出会话日志前缀**，普通活动永远不触发捕获。

### 11.2 配置

```yaml
- id: session-telemetry-otel
  config:
    mode: FEEDBACK_ONLY              # 默认：仅用户反馈后导出
    shutdownTimeoutMillis: 3000      # 关闭超时
    exporter:
      url: https://harness-telemetry.deepseeksvc.com/v1/logs
      compression: gzip
      timeoutMillis: 1000
    processor:
      scheduledDelayMillis: 10000
      maxQueueSize: 2048
      maxExportBatchSize: 2048
      exportTimeoutMillis: 1500
```

**环境变量覆盖**：
- `DSH_TELEMETRY_MODE`：覆盖 mode（默认 `FEEDBACK_ONLY`）
- `DSH_TELEMETRY_OTLP_URL`：覆盖导出端点
- `DSH_TELEMETRY_DISABLED`：非空值（包括 '0'/'false'）选择退出

### 11.3 匿名用户身份

- `$DSH_HOME/.anonymous-user-id`：随机 UUID
- 删除文件可重置身份
- 作为 OTel Resource 的 `user.id`

## 12. 代码质量：100% 覆盖率 + 50+ 验证脚本

### 12.1 覆盖率门禁

CI 覆盖率要求：`packages/*/*/src` 每文件 **100%** 覆盖率。

```bash
pnpm run test:coverage   # CI 覆盖率门禁
```

### 12.2 验证脚本体系

dsh 有 50+ 个验证脚本，每个负责一个特定的不变量：

| 类别 | 脚本 | 验证内容 |
|---|---|---|
| 包验证 | `verify-package-dependencies` | 依赖声明正确性 |
| | `verify-runtime-closure` | 运行时闭包完整 |
| | `verify-application-entrypoints` | 应用入口合法 |
| | `verify-package-invariants` | 包不变量 |
| | `verify-built-package-invariants` | 构建后包不变量 |
| | `verify-optional-dependency-imports` | 可选依赖导入 |
| Cordis | `verify-cordis-config` | bare 插件在 resolver manifest dependencies 中 |
| | `verify-cordis-catalog` | Cordis 插件目录 |
| | `verify-cordis-api` | Cordis API 文档 |
| | `verify-no-bare-dispatcher` | 无裸 dispatcher |
| 客户端 | `verify-client-packages` | 客户端包 |
| | `verify-client-ui-i18n` | UI 文案国际化（无硬编码） |
| | `verify-client-domain-graph` | 客户端域图 |
| 文档 | `verify-doc-refs` | 文档引用 |
| | `verify-md-links` | Markdown 链接 |
| | `verify-mermaid` | Mermaid 图表 |
| | `verify-doc-budgets` | 文档字数预算 |
| | `verify-subsystem-pages` | 子系统页面 |
| 类型 | `verify-export-jsdoc` | 导出 JSDoc |
| | `verify-type-equiv` | 类型等价 |
| | `verify-node-next-types` | NodeNext 类型 |
| 生成 | `verify-tool-catalog` | 工具目录 |
| | `verify-config-catalog` | 配置目录 |
| | `verify-persistence-catalog` | 持久化目录 |
| | `verify-session-format-catalog` | 会话格式目录 |
| | `verify-module-graph` | 模块图 |
| | `verify-scoped-events` | 作用域事件 |
| 发布 | `verify-dsh-package-licenses` | 包许可证 |
| | `verify-npm-install-layout` | npm 安装布局 |
| | `verify-vendored-links` | vendor 链接 |
| | `verify-package-readme-limitations` | README 限制 |
| | `verify-package-readme-model-experience` | README 模型体验 |
| Agent | `verify-agent-note-classification` | Agent Note 分类 |
| | `verify-agent-note-format` | Agent Note 格式 |
| | `verify-archived-agent-notes` | 归档 Agent Note |

### 12.3 Lint：oxlint + 自定义规则

- `oxlint`：Rust 实现的极快 linter
- `oxlint-tsgolint`：TypeScript 专用规则
- `.oxlintrc.json`：12KB 的详细规则配置
- 代码重复检测：`jscpd`

## 13. 非显而易见的工程约束

### 13.1 配置中无硬编码可调参数

> "No hardcoded tunables in plugins: deployment-varying choices are validated Config fields changeable from cordis.yml; a DEFAULT_* constant or test hook is not configurability."

部署相关的选择必须是可验证的 Config 字段，可以从 cordis.yml 修改。`DEFAULT_*` 常量或测试钩子不算可配置性。协议常量、外部规范和安全不变量保持固定。

### 13.2 配置错误立即失败

> "Misconfiguration fails loud at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent."

配置错误在加载时立即失败（如果自包含），否则在最早可解析点失败。永远不静默跳过缺失的引用。

### 13.3 跨边界 ID 是品牌类型

> "Opaque cross-boundary ids are branded (Branded<B> from dsh-brand), never bare string."

不透明的跨边界 ID 使用品牌类型，从不是裸 string。这防止不同类型的 ID 混淆。

### 13.4 信任类型化同进程边界

> "Trust TypeScript at typed same-process boundaries. Do not add runtime validation, fallback behavior, or hostile-input tests solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries."

在类型化的同进程边界信任 TypeScript。只在解析器/配置、队列、模型/工具 JSON、持久化/文件、worker、进程和线路边界添加运行时验证。

### 13.5 空 catch 必须命名吞掉了什么

> "An empty catch names what it swallows and why nothing else can reach it; keep the try to one statement."

### 13.6 Waterfall 监听器必须调用 next()

> "Waterfall listeners MUST call next() to delegate; returning without it short-circuits the chain."

这是最常见的 bug 来源之一。dsh 的 waterfall 事件（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`）的每个监听器必须调用 `next()`，否则链被短路。

### 13.7 新行为走扩展点，不改循环

> "Plugins, not loop changes: new behavior goes on documented extension points; changing agent-loop requires updating docs/architecture.md."

新行为附加到文档化的扩展点。改变 agent-loop 本身需要更新架构文档。
