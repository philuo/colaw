# DeepSeek Harness 依赖分析

> 版本：0.1.3-alpha.2 | 分析日期：2026-09-07

## 1. 依赖管理策略

### 1.1 包管理器与工作区



* **包管理器**：pnpm 11.7.0（`packageManager` 字段锁定）

* **Node 版本**：`^22.19.0 || >=24.0.0`

* **工作区配置**：`pnpm-workspace.yaml`



```
packages:

&#x20; - vendor/\*              # Vendored Cordis 框架

&#x20; - packages/\*/\*          # 所有 dsh 包（两级目录）

&#x20; - native/landlock-run   # 原生 addon

&#x20; - native/landlock-run/packages/\*

&#x20; - apps/\*                # 应用入口

&#x20; - benchmarks            # 性能基准

&#x20; - website               # 文档站

&#x20; - python/sdk-runtime    # Python 运行时部署根
```

### 1.2 严格构建脚本策略（strictDepBuilds）

pnpm 10+ 默认阻止任何带 install/build 脚本的依赖，除非显式审查。dsh 采用白名单策略：



```
allowBuilds:

&#x20; esbuild: true                    # 原生二进制，构建必需

&#x20; lefthook: true                   # Git hooks

&#x20; node-pty: true                   # PTY 后端（含 Windows ConPTY）

&#x20; koffi: true                      # Windows MoveFileExW 写穿透发布

&#x20; fs-ext: true                     # flock(2)/LockFileEx 会话写锁

&#x20; '@deepseek-ai/dsh-subprocess-local@file:...': true  # node-pty macOS spawn helper 可执行位

&#x20; # 以下被明确拒绝（no-op 脚本，不需要）

&#x20; '@google/genai': false

&#x20; protobufjs: false

&#x20; node-addon-require-builtin: false

&#x20; electron-winstaller: false

&#x20; msgpackr-extract: false
```

### 1.3 依赖类型区分

dsh 严格区分三种依赖：



| 类型                 | 用途               | 示例                                                      |
| ------------------ | ---------------- | ------------------------------------------------------- |
| `dependencies`     | 运行时必需，包发布时携带     | `zod`、`eventsource-parser`、`ws`、`koffi`                 |
| `peerDependencies` | 由宿主 / 组合方提供，包不自带 | `@deepseek-ai/cordis`、所有 `@deepseek-ai/dsh-*` 服务包       |
| `devDependencies`  | 仅开发 / 测试 / 构建需要  | `typescript`、`vitest`、`oxlint`、`@testing-library/react` |

**关键设计**：几乎所有 dsh 包都将 `@deepseek-ai/cordis` 和其他 dsh 服务包声明为 `peerDependencies`，而不是 `dependencies`。这意味着：



* 包本身不携带框架副本，避免版本冲突

* 组合方（profile/bundle）负责提供一致版本的所有服务

* 发布到 npm 后，用户安装时需要确保 peer 依赖满足

## 2. 外部运行时依赖全景

### 2.1 核心外部库



| 库                          | 版本            | 用途                      | 使用包                                 |
| -------------------------- | ------------- | ----------------------- | ----------------------------------- |
| `zod`                      | ^4.4.3        | 运行时类型验证（投影状态、配置）        | agent-loop, llm, 等                  |
| `@deepseek-ai/schemastery` | workspace     | Cordis 插件配置 Schema 验证   | 几乎所有包                               |
| `js-yaml`                  | ^4.2.0        | YAML 配置解析               | app-boot, desktop                   |
| `eventsource-parser`       | ^3.1.0        | SSE 流解析                 | llm-deepseek                        |
| `ws`                       | ^8.21.0       | WebSocket（API 网关远程流）    | api-gateway                         |
| `koffi`                    | ^3.1.0        | FFI（Windows 原生 API 调用）  | subprocess-local, persistence-jsonl |
| `node-pty`                 | 1.2.0-beta.15 | PTY 伪终端（跨平台）            | subprocess-local                    |
| `fs-ext`                   | 2.1.1         | 文件锁（flock/LockFileEx）   | persistence-jsonl                   |
| `compression`              | ^1.8.1        | HTTP 压缩                 | host-webserver                      |
| `negotiator`               | ^1.0.0        | HTTP 内容协商               | host-webserver                      |
| `resolve.exports`          | ^2.0.3        | package.json exports 解析 | app-boot                            |
| `@earendil-works/pi-ai`    | ^0.85.1       | 多供应商 LLM API 客户端        | llm-pi-ai（可选）                       |
| `electron`                 | ^44.0.0       | 桌面应用框架                  | desktop（dev）                        |
| `electron-builder`         | ^26.15.3      | 桌面应用打包                  | desktop（dev）                        |
| `electron-updater`         | ^6.8.9        | 自动更新                    | desktop                             |
| `semver`                   | ^7.8.5        | 版本比较                    | desktop                             |
| `msgpackr`                 | 2.0.4         | 高效序列化                   | desktop（dev）                        |
| `tar`                      | ^7.5.0        | tar 归档                  | desktop（dev）                        |
| `extract-zip`              | ^2.0.1        | ZIP 解压                  | desktop（dev）                        |

### 2.2 开发工具链



| 工具                       | 版本       | 用途                       |
| ------------------------ | -------- | ------------------------ |
| `typescript`             | ^6.0.3   | 类型检查 + 编译                |
| `tsdown`                 | ^0.22.2  | 基于 Rollup 的打包器           |
| `tsx`                    | ^4.22.4  | 开发时源码直接运行（ESM hook）      |
| `vitest`                 | ^4.1.8   | 测试框架                     |
| `@vitest/coverage-v8`    | ^4.1.8   | 覆盖率                      |
| `oxlint`                 | 1.76.0   | Linter（Rust 实现，极快）       |
| `oxlint-tsgolint`        | 7.0.2001 | TypeScript 专用 lint 规则    |
| `jscpd`                  | ^5.0.12  | 代码重复检测                   |
| `publint`                | ^0.3.21  | npm 包发布前验证               |
| `lefthook`               | ^2.1.9   | Git hooks 管理             |
| `mermaid`                | 11.16.0  | 文档图表渲染                   |
| `lightningcss`           | ^1.32.0  | CSS 处理                   |
| `fast-check`             | ^4.8.0   | 属性测试                     |
| `jsdom`                  | 29.1.1   | DOM 模拟（测试）               |
| `@testing-library/react` | ^16.3.2  | React 组件测试               |
| `@testing-library/dom`   | ^10.4.1  | DOM 测试                   |
| `@yao-pkg/pkg`           | 6.21.0   | 单文件可执行打包（Python runtime） |
| `@yarnpkg/cli-dist`      | 4.17.1   | Yarn CLI（依赖解析基准）         |

### 2.3 Vendored 框架依赖

`vendor/` 目录包含 9 个被 vendor 的 Cordis 生态包，全部 rescope 为 `@deepseek-ai/*`：



| Vendor 包                | 原包名                            | 角色                                     |
| ----------------------- | ------------------------------ | -------------------------------------- |
| `vendor/cordis`         | `cordis`                       | 核心元框架（Context, Fiber, Service, Events） |
| `vendor/cosmokit`       | `cosmokit`                     | 工具库（Dict, 等）                           |
| `vendor/schemastery`    | `schemastery`                  | Schema 验证库                             |
| `vendor/loader`         | `cordis-plugin-loader`         | 插件加载器                                  |
| `vendor/include`        | `cordis-plugin-include`        | YAML 配置包含 + 补丁                         |
| `vendor/group`          | `cordis-plugin-group`          | 插件分组                                   |
| `vendor/hmr`            | `cordis-plugin-hmr`            | 热模块重载                                  |
| `vendor/timer`          | `cordis-plugin-timer`          | 定时器服务                                  |
| `vendor/logger-console` | `cordis-plugin-logger-console` | 控制台日志输出                                |

**Vendor 同步策略**：



* `vendor/README.md` 记录上游 SHA 和同步流程

* 更新时通过同步流程，重新应用或退役已记录的本地修改

* 同步后必须重跑 `pnpm run test && pnpm run build`

* `pnpm-workspace.yaml` 的 `overrides` 强制所有 `@deepseek-ai/cosmokit` 和 `@deepseek-ai/schemastery` 解析到本地 vendor

## 3. 内部包依赖关系

### 3.1 核心依赖图（dsh-base bundle）



```
dsh-base (cordis.patch.yml 插入 \~80 个插件行)

│

├── 框架层

│   ├── cordis-plugin-timer (timer)

│   ├── cordis-plugin-hmr (hmr, 默认 disabled)

│   └── cordis-plugin-loader / include / group (boot 时内置)

│

├── 基础服务层

│   ├── dsh-llm (ctx.llm) ← LLM 服务定义

│   ├── dsh-deepseek-llm-api-extensions ← DeepSeek API 线扩展

│   ├── dsh-session (ctx.sessions) ← 会话事件日志

│   ├── dsh-session-log-deepseek ← DeepSeek 会话日志格式

│   ├── dsh-typert-registry (ctx.typert) ← 类型图注册表

│   ├── dsh-typert-loader ← 类型图加载器

│   ├── dsh-api-gateway (ctx.typertGateway) ← Typert RPC 网关

│   ├── dsh-session-title ← 会话标题生成

│   ├── dsh-session-title-first-prompt-llm ← LLM 标题生成

│   ├── dsh-user-questions ← 用户提问

│   ├── dsh-agent (ctx.agents) ← Agent 注册表

│   ├── dsh-plugin-package-inventory-deepseek ← 插件清单

│   ├── dsh-agent-default-model ← 默认模型选择

│   ├── dsh-jobs-local (ctx.jobs) ← 后台任务

│   └── dsh-llm-retry ← LLM 重试

│

├── 配置与凭证层

│   ├── dsh-settings-file (ctx.settings) ← 用户设置（YAML，热重载）

│   └── dsh-credentials-local (ctx.credentials) ← 凭证管理

│

├── LLM 适配器层

│   ├── dsh-llm-deepseek (默认，直连 DeepSeek)

│   └── dsh-llm-pi-ai (可选，默认休眠，pi-ai 多供应商)

│

├── 持久化层

│   ├── dsh-session-persistence-jsonl (ctx.sessionPersistence)

│   ├── dsh-attachment-local (ctx.attachments) ← 附件存储

│   ├── dsh-session-query-sqlite (ctx.sessionQuery, 默认 never)

│   ├── dsh-session-projection (ctx.sessionProjections)

│   ├── dsh-storage (ctx.storage) ← KV 存储 hub

│   ├── dsh-storage-json ← JSON 后端

│   ├── dsh-storage-domain ← 域表单

│   └── dsh-session-projection-cache ← 投影缓存

│

├── 遥测层

│   └── dsh-session-telemetry-otel (OTel，默认 FEEDBACK\_ONLY)

│

├── 执行环境层

│   ├── dsh-subprocess-local (ctx.subprocess) ← 子进程

│   ├── dsh-sandbox-local (ctx.sandbox) ← 沙箱

│   ├── dsh-sandbox-policy ← 沙箱策略

│   ├── dsh-bash-sandbox (macOS/Linux) / dsh-pwsh-sandbox (Windows)

│   ├── dsh-user-approval (ctx.approval) ← 用户审批

│   ├── dsh-permission-presets ← 权限预设

│   └── dsh-shell-env ← Shell 环境

│

├── 工具层

│   ├── dsh-tool-bash (macOS/Linux) / dsh-tool-pwsh (Windows)

│   ├── dsh-tool-jobs

│   ├── dsh-fs-observation-policy

│   ├── dsh-tool-fs

│   ├── dsh-tool-fs-search

│   ├── dsh-tool-todo

│   ├── dsh-tool-goal

│   ├── dsh-tool-ralph

│   ├── dsh-tool-web (search + fetch)

│   ├── dsh-tool-subagent (spawn + fork)

│   ├── dsh-tool-subagent-control

│   ├── dsh-tool-subagent-list-agents

│   ├── dsh-tool-workflow

│   ├── dsh-tool-skill

│   └── dsh-repeat-tool-reminder

│

├── Agent 能力层

│   ├── dsh-agent-instructions ← Agent 指令

│   ├── dsh-agent-loop (ctx.agentLoop) ← Agent 执行引擎

│   ├── dsh-system-prompt (ctx.systemPrompt) ← 系统提示组装

│   ├── dsh-tools (ctx.tools) ← 工具注册表

│   ├── dsh-compaction-basic ← 上下文压缩

│   ├── dsh-token-meter ← Token 计量

│   ├── dsh-subagent (ctx.subagents) ← 子 Agent

│   ├── dsh-subagent-spawn-in-process

│   ├── dsh-subagent-fork-in-process

│   ├── dsh-workflow-worker-thread (ctx.workflows)

│   ├── dsh-goal (ctx.goals) ← 目标管理

│   ├── dsh-goal-round-driver

│   ├── dsh-plan-mode ← 计划模式

│   ├── dsh-commands (ctx.commands) ← 斜杠命令

│   ├── dsh-command-feedback

│   ├── dsh-command-goal

│   ├── dsh-command-compact

│   └── dsh-skill (ctx.skills) ← Skill 系统

│

├── Web 能力层

│   ├── dsh-web (ctx.web) ← Web 服务

│   ├── dsh-web-search-deepseek ← DeepSeek 搜索

│   └── dsh-web-fetch-http ← HTTP 抓取

│

└── 保护与策略层

&#x20;   ├── dsh-tool-call-timeout-policy ← 工具超时

&#x20;   ├── dsh-spill-local (ctx.spill) ← 大结果溢出

&#x20;   ├── dsh-spill-policy

&#x20;   ├── dsh-session-checkpoint-policy ← 检查点

&#x20;   └── dsh-compaction-tool-result-pruner ← 工具结果裁剪
```

### 3.2 关键包的 peer 依赖链

#### agent-loop（执行引擎）



```
peerDependencies:

&#x20; @deepseek-ai/cordis              ← 框架

&#x20; @deepseek-ai/dsh-agent           ← Agent 接口/注册表

&#x20; @deepseek-ai/dsh-invariants      ← 运行时不变量

&#x20; @deepseek-ai/dsh-llm             ← LLM 服务

&#x20; @deepseek-ai/dsh-scope           ← per-agent 作用域

&#x20; @deepseek-ai/dsh-session         ← 会话日志

&#x20; @deepseek-ai/dsh-session-persistence  ← 持久化

&#x20; @deepseek-ai/dsh-session-projection   ← 投影

&#x20; @deepseek-ai/dsh-settings        ← 用户设置

&#x20; @deepseek-ai/dsh-system-prompt   ← 系统提示

&#x20; @deepseek-ai/dsh-tools           ← 工具注册表

dependencies:

&#x20; @deepseek-ai/dsh-brand           ← 品牌 ID 类型

&#x20; @deepseek-ai/dsh-util-values     ← 工具值

&#x20; @deepseek-ai/schemastery         ← 配置 Schema

&#x20; zod                               ← 投影状态验证
```

#### llm-deepseek（默认 LLM 适配器）



```
peerDependencies:

&#x20; @deepseek-ai/cordis

&#x20; @deepseek-ai/dsh-anonymous-user-id    ← 匿名用户 ID

&#x20; @deepseek-ai/dsh-atomic-write         ← 原子写

&#x20; @deepseek-ai/dsh-attachment           ← 附件

&#x20; @deepseek-ai/dsh-credentials          ← 凭证

&#x20; @deepseek-ai/dsh-deepseek-llm-api-extensions  ← API 扩展

&#x20; @deepseek-ai/dsh-fs                   ← 文件系统

&#x20; @deepseek-ai/dsh-home-paths           ← 家目录路径

&#x20; @deepseek-ai/dsh-launch-environment   ← 启动环境快照

&#x20; @deepseek-ai/dsh-llm                  ← LLM 服务定义

&#x20; @deepseek-ai/dsh-settings             ← 设置

&#x20; @deepseek-ai/dsh-timeout              ← 超时

dependencies:

&#x20; @deepseek-ai/dsh-brand

&#x20; @deepseek-ai/dsh-util-values

&#x20; @deepseek-ai/schemastery

&#x20; eventsource-parser                     ← SSE 解析
```

#### app-boot（启动胶水）



```
peerDependencies:

&#x20; @deepseek-ai/cordis

&#x20; @deepseek-ai/cordis-plugin-group

&#x20; @deepseek-ai/cordis-plugin-hmr

&#x20; @deepseek-ai/cordis-plugin-include

&#x20; @deepseek-ai/cordis-plugin-loader

&#x20; @deepseek-ai/dsh-launch-environment

&#x20; @deepseek-ai/dsh-home-paths

&#x20; @deepseek-ai/dsh-system-prompt

dependencies:

&#x20; @deepseek-ai/dsh-atomic-write

&#x20; @deepseek-ai/dsh-package-manifest

&#x20; js-yaml

&#x20; resolve.exports
```

### 3.3 原生模块依赖

dsh 依赖几个原生 Node.js 模块，这些是跨平台桌面 / 服务端运行的关键：



| 原生模块                                   | 平台    | 用途                                | 构建方式                            |
| -------------------------------------- | ----- | --------------------------------- | ------------------------------- |
| `node-pty`                             | 全平台   | PTY 伪终端（Bash、终端工具）                | node-gyp 编译（allowBuilds 白名单）    |
| `koffi`                                | 全平台   | FFI 调用原生 API（Windows MoveFileExW） | 预编译二进制                          |
| `fs-ext`                               | 全平台   | 文件锁（flock/LockFileEx）             | node-gyp 编译                     |
| `@deepseek-ai/node-addon-landlock-run` | Linux | Landlock 沙箱                       | 原生 addon（`native/landlock-run`） |

**补丁依赖**：



```
patchedDependencies:

&#x20; '@yao-pkg/pkg@6.21.0': patches/@yao-pkg\_\_pkg@6.21.0.patch

&#x20; node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch
```

## 4. 依赖验证与门禁

dsh 有一套完整的依赖验证体系：



| 验证脚本                                          | 用途                                                          |
| --------------------------------------------- | ----------------------------------------------------------- |
| `verify-package-dependencies`                 | 验证包依赖声明正确性                                                  |
| `verify-runtime-closure`                      | 验证运行时闭包（所有 import 可解析）                                      |
| `verify-application-entrypoints`              | 验证应用入口                                                      |
| `verify-client-packages`                      | 验证客户端包                                                      |
| `verify-optional-dependency-imports`          | 验证可选依赖导入                                                    |
| `verify-npm-install-layout`                   | 验证 npm 安装布局                                                 |
| `verify-package-invariants`                   | 验证包不变量                                                      |
| `verify-built-package-invariants`             | 验证构建后包不变量                                                   |
| `verify-cordis-config`                        | 验证 Cordis 配置（bare 插件必须在 resolver manifest 的 dependencies 中） |
| `verify-vendored-links`                       | 验证 vendor 链接                                                |
| `constraints` (`check-workspace-constraints`) | 验证工作区约束                                                     |
| `hygiene`                                     | publint + 工作区 / 包 / 依赖检查 + NodeNext 消费者检查                   |

## 5. 与 electrobun (Bun@1.4.x) 集成的依赖考量

### 5.1 dsh 对 Node.js 的依赖

dsh 明确要求 Node `^22.19.0 || >=24.0.0`，并使用了多个 Node.js 专属 API：



| API                           | 用途                  | Bun 兼容性            |
| ----------------------------- | ------------------- | ------------------ |
| `process.loadEnvFile()`       | 加载 .env             | Bun 支持             |
| `node:module` `createRequire` | CommonJS 兼容 require | Bun 支持             |
| `node:fs` 文件描述符（FD 3/4）       | Desktop byte pipes  | Bun 支持             |
| `node:child_process`          | 子进程管理               | Bun 支持             |
| `node-pty` 原生模块               | PTY                 | **需要 Bun 兼容的原生模块** |
| `koffi` FFI                   | 原生 API 调用           | **需要验证 Bun 兼容性**   |
| `fs-ext` 文件锁                  | flock               | **需要验证 Bun 兼容性**   |
| `@yao-pkg/pkg` 单文件打包          | Python runtime      | Node 专属，Bun 不可用    |

### 5.2 关键风险点



1. **原生模块兼容性**：`node-pty`、`koffi`、`fs-ext` 是 Node.js 原生 addon，Bun 对 N-API 的兼容性需要验证。Bun 声称支持大部分 N-API 模块，但这些特定模块需要实测。

2. **TypeScript 源码运行**：dsh 开发时通过 `tsx`（基于 esbuild）直接运行 TypeScript 源码。Bun 原生支持 TypeScript，但需要确保 ESM-only 约束和 `!!js` 配置表达式的兼容性。

3. **Electron 集成**：dsh 的桌面端使用 Electron + bundled upstream Node.js。如果改用 electrobun，需要重新设计 Host 进程通信层。

4. **pnpm workspace**：dsh 使用 pnpm workspace 管理 50+ 包。Bun 也支持 workspace，但 `strictDepBuilds`、`overrides`、`peerDependencyRules` 等 pnpm 专属功能需要 Bun 等价配置。

### 5.3 建议的集成路径

详见 `06-electrobun-integration-guide.md`。