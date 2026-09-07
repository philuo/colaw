# DeepSeek Harness 执行过程分析

> 版本：0.1.3-alpha.2 | 分析日期：2026-09-07

## 1. 应用启动流程（Boot Process）

### 1.1 CLI 启动完整链路

```
用户执行: dsh --profile web "任务"
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│ 1. bin.ts 入口 (apps/cli/src/bin.ts)                     │
│    - 解析命令行参数                                        │
│    - 确定 profile 名称 (web/headless/sdk/acp)            │
│    - 设置 DSH_HOME (默认 ~/.dsh)                          │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 2. loadLayeredEnv() (app-boot)                           │
│    - 解析 Harness home 路径 (~/.dsh)                      │
│    - 读取项目目录 .env (cwd)                               │
│    - 读取 Harness home .env (~/.dsh/.env)                 │
│    - 验证：拒绝 bootstrap-only 变量 (PATH, NODE_OPTIONS,  │
│      DEEPSEEK_BASE_URL, SSL_CERT_FILE 等)                 │
│    - 例外：home 层允许 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY  │
│    - 按优先级 materialize: 进程环境 > 项目 .env > home .env│
│    - 返回 LaunchEnvironmentSnapshot (记录每层来源)          │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 3. installFailLoud() (app-boot)                          │
│    - 注册 process.on('unhandledRejection') 处理器         │
│    - 任何插件初始化失败 → stderr 输出诊断 + exit(1)        │
│    - 可选 release 回调（终端所有者恢复终端状态）             │
│    - 2秒超时保护：挂起的 disposer 不能阻止退出              │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 4. resolveConfigPath() (app-boot)                        │
│    - 确定要加载的 cordis.yml 路径                          │
│    - snapshot 模式 ('replay'): 替换为 cordis.snapshot.yml │
│    - 正常模式: 使用原始路径                                 │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 5. Profile 层组合 (loadProfileDirectory)                 │
│    - 读取 profile manifest ($DSH_HOME/profiles/<name>/)  │
│    - 按顺序加载 profile 列出的每个 bundle                   │
│    - 每个 bundle 提供 cordis.patch.yml (PatchOptions[])   │
│    - 加载 profile 自己的 cordis.patch.yml                  │
│    - 加载 home 级别的 cordis.patch.yml                     │
│    - 加载 --patch 命令行覆盖                                │
│    - 层叠顺序: bundle1 → bundle2 → ... → profile → home → │
│                --patch (后者覆盖前者，按 id 替换整行 config)│
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 6. boot() (app-boot)                                     │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6a. new Context()                                  │ │
│    │     - 创建 Cordis 根上下文 (Proxy 对象)             │ │
│    │     - 初始化: fiber, reflect, registry, events,    │ │
│    │       logger                                        │ │
│    │     - ctx.baseUrl = 配置文件所在目录 URL             │ │
│    │     - ctx.provide('dshHomePath', dshHomePath)      │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6b. ctx.plugin(Loader)                             │ │
│    │     - 挂载 cordis-plugin-loader 插件                │ │
│    │     - 提供 ctx.loader 服务                          │ │
│    │     - 支持: create(entry), resolve(id), entries()  │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6c. prepare(ctx) — 可选宿主设置                     │ │
│    │     - Desktop: provideCmdline + launch environment │ │
│    │     - CLI: 提供命令行参数                             │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6d. mountRootInclude()                             │ │
│    │     - 设置 ctx.loader.builtins.include = Include   │ │
│    │     - 设置 ctx.loader.builtins.group = Group       │ │
│    │     - 创建根 Include entry (id='include',           │ │
│    │       name='cordis:include', config={path, patches})│
│    │     - Include 插件:                                  │ │
│    │       * 读取 cordis.yml (YAML 数组，entryListSchema) │ │
│    │       * 解析 !!js 表达式为可执行节点                  │ │
│    │       * 应用所有 patches (按 id 替换 config/插入新行) │ │
│    │       * 对每个 entry 调用 ctx.loader.create()        │ │
│    │       * 递归加载 group 子 entry                       │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6e. Loader 并发激活所有插件                          │ │
│    │     - 每个 entry: import 模块 → 实例化插件 →        │ │
│    │       执行插件函数 (ctx, config) → 返回 disposer    │ │
│    │     - 插件内: ctx.provide() 注册服务,               │ │
│    │       ctx.on() 监听事件, ctx.effect() 注册副作用    │ │
│    │     - 服务依赖驱动激活顺序 (static inject)           │ │
│    │     - 每个插件创建自己的 Fiber 节点                   │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6f. ctx.loader.await()                             │ │
│    │     - 等待所有插件 Fiber  settle                     │ │
│    └───────────────────────┬───────────────────────────┘ │
│                            ▼                               │
│    ┌───────────────────────────────────────────────────┐ │
│    │ 6g. assertEntriesActivated()                       │ │
│    │     - 检查所有 enabled entry 的 Fiber state === ACTIVE│
│    │     - FAILED: await fiber.await() 获取原始错误栈     │ │
│    │     - PENDING: 列出缺失的服务名                      │ │
│    │     - 任何失败 → throw (boot catch 后 dispose 根上下文)│
│    └───────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 7. 应用就绪                                               │
│    - 返回根 Context (所有服务已注册，所有事件已监听)        │
│    - CLI: 执行任务或启动交互循环                            │
│    - Web: 启动 HTTP 服务器                                 │
│    - Desktop: 通过 byte pipes 暴露 API                     │
│    - SDK: 启动 JSON-RPC stdio 服务器                       │
└─────────────────────────────────────────────────────────┘
```

### 1.2 插件激活的内部机制

当 Loader 激活一个插件时：

```typescript
// 伪代码：Loader 激活一个 entry
async function activateEntry(entry) {
  // 1. 导入插件模块
  const pluginModule = await import(entry.options.name)
  const Plugin = pluginModule.default ?? pluginModule
  
  // 2. 创建子上下文（继承根上下文，携带 entry 配置）
  const childCtx = rootCtx.extend({
    [symbols.config]: entry.options.config,
  })
  
  // 3. 创建 Fiber 节点
  const fiber = childCtx.fiber
  fiber.state = PENDING
  
  // 4. 解析依赖 (static inject)
  const deps = {}
  for (const depName of Plugin.inject ?? []) {
    deps[depName] = childCtx.get(depName)  // 触发依赖插件先激活
  }
  
  // 5. 验证配置 (static Config schema)
  const config = Plugin.Config 
    ? Plugin.Config.parse(entry.options.config) 
    : entry.options.config
  
  // 6. 执行插件函数
  fiber.state = ACTIVE
  const disposer = await Plugin(childCtx, config)
  
  // 7. 注册 disposer 到 Fiber
  if (typeof disposer === 'function') {
    fiber._disposables.add(disposer)
  }
}
```

**关键**：插件的 `static inject` 数组声明依赖的服务名。Cordis 的 ReflectService 在 `ctx.get(name)` 时，如果服务尚未注册，会等待提供该服务的插件激活。这形成了**依赖驱动的激活顺序**，无需手动排序。

## 2. Agent Turn/Step 执行流程

### 2.1 核心概念

- **Step（步）**：一次模型请求 + 它调用的工具。一个 Step 包含：prompt 组装 → LLM 调用 → 工具调用（0~N 次）。
- **Turn（轮）**：零或多个 Step。Turn 在第一个输入被认领前打开，在没有任何待处理事项时关闭。

### 2.2 完整执行序列

```
turn/start (持久会话事件)
  │
  ├─ 1. 认领输入 (claim next-step input + one queued message)
  │     - 从 agent.inbox 队列取下一条消息
  │     - 注入的上下文等待在 inbox 中，直到另一条消息唤醒
  │
  ├─ 2. 组装 prompt sections + tool schemas
  │     - ctx.systemPrompt 收集所有注册的 section（按 order 排序）
  │     - ctx.tools 收集当前 agent 作用域内的工具 schema
  │     - 替换变量（{provider}, {model}, {cwd}）
  │
  ├─ 3. agent/pre-step (waterfall 事件)
  │     - 监听器可以重写认领的消息，或直接拒绝
  │     - 被拒绝或空的首次认领仍然关闭一个花费了 0 step 的持久 turn
  │     - enter 决策可以设置 startsRequestSeries 开始新的模型消息系列
  │     - 每个监听器必须调用 next() 才能传递
  │
  ├─ 4. step/start (持久会话事件)
  │
  ├─ 5. 将进入的消息追加为 user/message (持久)
  │
  ├─ 6. 从日志推导模型历史 (deriveMessages)
  │     - 投影所有持久会话事件为模型消息格式
  │     - assistant/message 嵌入精确的紧凑计时流
  │     - assistant/attempt 保留失败/重试/取消尝试（不加入模型历史）
  │
  ├─ 7. agent/request (waterfall 事件)
  │     - 拦截/修改模型请求
  │     - 监听器必须调用 next()
  │
  ├─ 8. llm/stream (waterfall 事件)
  │     - 选择 LLM 适配器（基于 provider 路由）
  │     - 适配器执行实际 HTTP 请求（SSE 流）
  │     - llm-deepseek: 直连 DeepSeek API
  │     - llm-pi-ai: 通过 pi-ai 库连接多供应商
  │     - llm-retry: 重试策略包装
  │
  ├─ 9. agent/assistant-stream start (实时事件，仅进程内)
  │
  ├─ 10. agent/assistant-stream chunk* (实时事件)
  │      - 每个 SSE chunk 发布一次
  │      - Web Session-follow 适配器是唯一远程消费者
  │      - UI 增量渲染来自这些实时帧
  │
  ├─ 11. assistant/message | assistant/attempt (持久会话事件)
  │      - 循环提交完整的紧凑流作为一条消息
  │      - 或记录为仅日志的 attempt（失败/取消/流错误）
  │      - agent/assistant-stream end (实时事件)
  │
  ├─ 12. 工具调用循环 (0~N 次)
  │      │
  │      ├─ tool/call (持久会话事件)
  │      │
  │      ├─ tools/pre-execute (waterfall)
  │      │   - 审批检查 (ctx.approval)
  │      │   - 权限策略检查 (ctx.permission)
  │      │   - 沙箱策略 (ctx.sandbox)
  │      │   - 超时策略 (ctx.timeout)
  │      │
  │      ├─ tools/execute (waterfall)
  │      │   - 查找工具实现 (ctx.tools)
  │      │   - 验证参数 (JSON Schema)
  │      │   - 执行工具函数
  │      │   - 并行调度 (受 maxParallelToolCalls 限制)
  │      │
  │      ├─ tools/post-execute (waterfall)
  │      │   - 结果裁剪 (compaction-tool-result-pruner)
  │      │   - 大结果溢出 (spill)
  │      │   - 检查点 (session-checkpoint-policy)
  │      │
  │      └─ tool/result (持久会话事件)
  │
  ├─ 13. step/end (持久会话事件)
  │
  ├─ 14. 检查是否需要继续
  │      - 工具返回了另一个请求？→ 认领 → 下一个 step (回到步骤 1)
  │      - inbox 中有新到达的 next-step 输入？→ 继续
  │      - 否则 → 进入 turn 停止
  │
  ├─ 15. agent/turn-stopping (serial 事件，无 next)
  │      - 最后机会停止/修改 turn 结果
  │
  └─ 16. turn/end (持久会话事件)
```

### 2.3 工具执行管道详解

工具执行是一个三层 waterfall 管道：

```
模型返回 tool_calls
       │
       ▼
┌──────────────────┐
│ tools/pre-execute │  waterfall
│ (执行前拦截)       │
│  - 审批: ask_user │
│  - 权限: read-only│
│  - 沙箱: argv 包装│
│  - 超时: 设置截止  │
│  - 可拒绝执行      │
└────────┬─────────┘
         │ next()
         ▼
┌──────────────────┐
│  tools/execute    │  waterfall
│  (实际执行)        │
│  - 参数 JSON Schema│
│  - 查找工具实现    │
│  - 并行调度        │
│  - 执行工具函数    │
│  - 返回原始结果    │
└────────┬─────────┘
         │ next()
         ▼
┌──────────────────┐
│ tools/post-execute│  waterfall
│ (执行后处理)       │
│  - 结果大小裁剪    │
│  - 大结果溢出存储  │
│  - 持久化检查点    │
│  - 可修改返回结果  │
└────────┬─────────┘
         │
         ▼
  tool/result (持久事件)
```

**并行工具调用**：
- `maxParallelToolCalls` 控制每步最大并行数（默认值在 `constants.ts`）
- 用户可通过设置修改（`agent-loop.maxParallelToolCalls`）
- 设置变更影响下一个工具组，不干扰正在进行的组
- 工具组内按依赖关系调度（无依赖的并行执行）

## 3. LLM 流式调用流程

### 3.1 适配器选择与路由

```
agent-loop 构造 LLM 请求 (GenerateOptions)
       │
       ├─ options.provider = "deepseek-official" (默认)
       │     → ctx.llm 查找已注册的 "deepseek-official" 路由
       │     → llm-deepseek 适配器处理
       │
       ├─ options.provider = "openai" (用户配置了 pi-ai)
       │     → ctx.llm 查找已注册的 "openai" 路由
       │     → llm-pi-ai 适配器处理 (通过 @earendil-works/pi-ai)
       │
       └─ 未找到 provider → 报错 MISSING_PROVIDER
```

### 3.2 llm-deepseek 适配器内部流程

```
stream(request, signal)
  │
  ├─ 1. 凭证解析
  │     - 从 ctx.credentials 解析 apiKeyEnv 引用
  │     - 引用解析为空 → MISSING_CREDENTIAL 错误
  │     - 不 materialize 到 process.env
  │
  ├─ 2. 请求构造
  │     - DeepSeek Chat Completions API 格式
  │     - 应用 API 扩展 (deepseek-llm-api-extensions)
  │     - 图片处理 (attachment 解析、像素预算、字节限制)
  │     - reasoning_effort 设置
  │
  ├─ 3. HTTP 请求 (SSE)
  │     - fetch(url, { method: 'POST', headers, body, signal })
  │     - stream: true
  │
  ├─ 4. SSE 解析 (eventsource-parser)
  │     - 解析每个 data: 行
  │     - [DONE] → 结束
  │
  ├─ 5. 流转换
  │     - DeepSeek API chunk → dsh LLMStreamChunk
  │     - 内容增量、工具调用增量、推理内容
  │     - 用法统计 (prompt_tokens, completion_tokens)
  │
  └─ 6. 返回异步生成器 (AsyncGenerator<LLMStreamChunk>)
        - agent-loop 消费每个 chunk
        - 发布 agent/assistant-stream chunk 事件
        - 累积为完整 assistant/message
```

### 3.3 重试机制 (llm-retry)

```
原始 stream 请求
    │
    ▼
┌──────────────────┐
│  llm-retry 包装   │
│  - retryPolicy    │
│    mode: normal   │
│    maxRetries: 5  │
│  - 可重试错误:     │
│    429, 500, 502, │
│    503, 504,      │
│    网络错误        │
│  - 指数退避        │
└────────┬─────────┘
         │
         ▼
   实际适配器调用
```

## 4. 会话持久化流程

### 4.1 事件写入流程

```
agent-loop 产生会话事件 (turn/start, user/message, ...)
       │
       ▼
┌──────────────────────────┐
│ ctx.sessions.enter(session)│  注册 session 到内存存储
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ session.append(event)     │  追加到内存事件数组
│  - 分配 seq (单调递增)     │
│  - 验证事件类型 (SessionEventMap)│
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ session/event 事件广播     │  ctx.emit('session/event', event)
│  - 实时消费者: UI, 投影    │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ session-persistence-jsonl 持久化      │
│  (通过 mounted backend 的 write handle)│
│                                        │
│  1. handle.append(events)             │
│     - 序列化为 JSONL (每行一个事件)     │
│     - 可选 zstd 压缩                   │
│     - 写入 session.vN.jsonl[.zstd]   │
│                                        │
│  2. 写入原子性                          │
│     - flock(2) / LockFileEx 写锁      │
│     - Windows: MoveFileExW 写穿透发布  │
│     - 追加写入，不修改已有内容           │
│                                        │
│  3. 投影更新                            │
│     - sessionProjections 增量折叠事件  │
│     - projection-cache 节流写回 (200事件/5秒)│
└──────────────────────────────────────┘
```

### 4.2 会话恢复流程 (resume)

```
agentLoop.resume({ resumeSessionId, agentOptions, setup })
       │
       ▼
┌──────────────────────────────────────┐
│ 1. 获取写所有权 (persistence.open)    │
│    - 打开 session 目录                 │
│    - 选择数字最高的规范 generation      │
│    - 获取写锁 (排除并发 resume)        │
└───────────┬──────────────────────────┘
            ▼
┌──────────────────────────────────────┐
│ 2. 冷读取 (handle.read)               │
│    - 读取所有持久事件                   │
│    - 解码/解压 (zstd)                  │
│    - 版本迁移 (如需要): v0→v1→v2...   │
│      每个相邻迁移包负责一步              │
│      只添加后继文件，不修改源文件        │
└───────────┬──────────────────────────┘
            ▼
┌──────────────────────────────────────┐
│ 3. 中断修复 (interruptedTurnClosers)  │
│    - 检测未关闭的 turn (有 turn/start  │
│      无 turn/end)                      │
│    - 插入合成的关闭事件:                 │
│      - 缺失的 tool/result (错误)       │
│      - step/end                        │
│      - turn/end                        │
│    - 通过同一 handle 追加 (持久化)      │
└───────────┬──────────────────────────┘
            ▼
┌──────────────────────────────────────┐
│ 4. 构造内存 Session                     │
│    - SessionPreparation.create()       │
│    - seed: 所有持久事件 + 修复事件      │
│    - meta: session header (cwd, etc.) │
│    - inheritedEventCount: 继承事件数    │
└───────────┬──────────────────────────┘
            ▼
┌──────────────────────────────────────┐
│ 5. prepare() 构造 ReactLoopAgent       │
│    - 创建 per-agent 作用域上下文        │
│    - 注册到 ctx.agents / ctx.sessions  │
│    - 发布 agent/session-start 事件      │
│    - 执行 setup 回调 (可选)             │
└───────────┬──────────────────────────┘
            ▼
┌──────────────────────────────────────┐
│ 6. Agent 就绪，可接受新输入             │
│    - inbox 队列开始接收消息             │
│    - 从持久历史继续执行                 │
└──────────────────────────────────────┘
```

## 5. Electron 桌面应用启动流程

### 5.1 完整启动序列

```
用户双击 .app / 执行 dsh-desktop
       │
       ▼
┌─────────────────────────────────────────────┐
│ 1. Electron 主进程启动 (main.ts)             │
│    - 单实例锁 (requestSingleInstanceLock)     │
│    - 检查自动更新 (10秒后)                     │
│    - 初始化 locale (en/zh)                    │
└──────────────┬──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ 2. Seed 安装/协调 (seed-store.ts)            │
│    - 读取激活日志 (中断恢复)                   │
│    - 验证 seed 完整性 (integrity.json)        │
│    - 版本匹配检查 (seed version === app version)│
│    - 已安装匹配版本 → 跳过                     │
│    - 否则 → 事务安装:                          │
│      a. 提取 16 个 store shards 到 staging    │
│      b. 合并 pnpm store (SQLite 包索引)       │
│      c. 创建 staging profile 项目              │
│      d. pnpm install --offline --frozen-lockfile│
│         (使用 bundled Node.js + bundled pnpm)  │
│      e. 恢复旧 profile 的插件版本               │
│      f. 健康检查: 启动 staging 后端 → 停止      │
│      g. 移动 active → rollback, staging → active│
└──────────────┬──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ 3. 启动 Desktop Host 子进程 (host-process.ts)│
│    - 进程: bundled upstream Node.js           │
│    - 入口: @deepseek-ai/dsh-desktop-host     │
│    - 参数: projectDir ($DSH_HOME/profiles/desktop)│
│    - 标准 IPC: Node IPC (生命周期控制)         │
│    - FD 3: 请求管道 (framed byte pipe)        │
│    - FD 4: 响应管道 (framed byte pipe)        │
└──────────────┬──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ 4. Desktop Host 内部启动 (index.ts)           │
│    ┌───────────────────────────────────────┐ │
│    │ 4a. 写空 root config (desktop.cordis.yml)│ │
│    └───────────────┬───────────────────────┘ │
│                    ▼                           │
│    ┌───────────────────────────────────────┐ │
│    │ 4b. loadLayeredEnv()                   │ │
│    └───────────────┬───────────────────────┘ │
│                    ▼                           │
│    ┌───────────────────────────────────────┐ │
│    │ 4c. desktopPatches()                   │ │
│    │  - 加载 profile directory (bundles + patches)│ │
│    │  - 验证所有 bundle 在 project 目录内      │ │
│    │  - 加载 desktop.cordis.patch.yml 覆盖    │ │
│    │  - 注入 agent-presets 根路径              │ │
│    └───────────────┬───────────────────────┘ │
│                    ▼                           │
│    ┌───────────────────────────────────────┐ │
│    │ 4d. boot() → Cordis 插件树激活          │ │
│    │  - 提供 launch environment + cmdline     │ │
│    │  - 所有 dsh-base 插件激活                 │ │
│    │  - ctx.connection, ctx.clientModules,    │ │
│    │    ctx.typertGateway 就绪                │ │
│    └───────────────┬───────────────────────┘ │
│                    ▼                           │
│    ┌───────────────────────────────────────┐ │
│    │ 4e. 创建三个 fetch handler               │ │
│    │  - API handler: /api/* → Typert RPC    │ │
│    │  - Asset handler: /* → 静态前端资源      │ │
│    │  - Stream handler: /.dsh/remote-stream  │ │
│    │    → gateway.wireStream.open()           │ │
│    └───────────────┬───────────────────────┘ │
│                    ▼                           │
│    ┌───────────────────────────────────────┐ │
│    │ 4f. 发送 ready 事件 (Node IPC)          │ │
│    │  { type: 'ready', protocolVersion,      │ │
│    │    dshVersion }                          │ │
│    └───────────────────────────────────────┘ │
└──────────────┬──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ 5. Electron 创建 BrowserWindow                 │
│    - 注册 dsh-app:// 自定义协议                │
│    - 加载 dsh-app://index.html                 │
│    - preload 脚本注入安全 API                   │
└──────────────┬──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ 6. Renderer 进程 (React UI)                    │
│    - 注入 __DSH_TRANSPORT__ 全局对象           │
│    - 所有 fetch 走 dsh-app:// 协议             │
│    - Electron 主进程拦截 → 转发到 Host 子进程   │
│    - Host 子进程处理 → 通过响应管道返回          │
│    - 无 Web 服务器，无监听端口                   │
└─────────────────────────────────────────────┘
```

### 5.2 请求/响应管道协议

```
Renderer fetch("dsh-app://api/sessions")
       │
       ▼
Electron 主进程 protocol handler
       │
       ▼
请求管道 (FD 3, framed chunks)
  ┌─────────────────────────────────┐
  │ start frame: streamId, url,     │
  │   method, headers, hasBody       │
  │ data frame: streamId, chunk bytes│
  │ end frame: streamId              │
  │ cancel frame: streamId           │
  └─────────────────────────────────┘
       │
       ▼
Desktop Host (DesktopHostRequestDecoder)
       │
       ├─ /api/* → connection.createSharedFetchHandler → Typert RPC
       ├─ /.dsh/remote-stream → gateway.wireStream.open() → NDJSON
       └─ /* → 静态资源 (dsh-web-frontend/dist)
       │
       ▼
响应管道 (FD 4, framed chunks, 背压)
  ┌─────────────────────────────────┐
  │ start: streamId, status, headers │
  │ data: streamId, chunk (64KB max) │
  │ end: streamId                     │
  │ error: streamId, message          │
  └─────────────────────────────────┘
       │
       ▼
Electron 主进程 → Response 对象 → Renderer
```

## 6. SDK 通信流程

### 6.1 TypeScript SDK

```
SDK Client (用户代码)
  │
  ├─ new DshClient({ profile: 'sdk' })
  │    - 解析同版本 dsh 依赖
  │    - 启动 dsh --profile sdk 子进程
  │    - stdin/stdout 作为 JSON-RPC 通道
  │
  ├─ client.sessions.create({ ... })
  │    - 构造 JSON-RPC 请求
  │    - 写入子进程 stdin
  │    - 等待 stdout 响应
  │
  └─ client.sessions.stream(sessionId)
       - JSON-RPC 通知 (notifications)
       - 实时事件流
```

### 6.2 Python SDK

```
Python Client
  │
  ├─ 安装 deepseek-harness-sdk-runtime-<platform>-<arch>.whl
  │    - 内含打包的 dsh CLI 单文件可执行
  │
  ├─ client = DeepSeekHarness(profile='sdk-minimal')
  │    - 启动 dsh --profile sdk-minimal 子进程
  │    - 显式 Harness home (默认)
  │
  └─ 与 TypeScript SDK 相同的 JSON-RPC 协议
```

**sdk-minimal 特殊之处**：不应用 dsh-base，是一个独立完整的 SDK 树，拥有自己的 bundle，明确列出所有依赖。
