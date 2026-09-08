# DeepSeek Harness 架构深度分析

> 基于 deepseek-harness v0.1.3-alpha.2 源码的完整架构解剖
> 分析日期：2026-09-07

## 文档索引

| 序号 | 文档 | 内容概要 |
|---|---|---|
| 01 | [Cordis vs Pi-ai 澄清](./01-cordis-vs-pi-ai.md) | 回答核心疑问：Cordis 没有被抛弃，Pi-ai 是可选 LLM 后端，二者处于不同架构层级 |
| 02 | [完整架构分析](./02-architecture-analysis.md) | Monorepo 结构、核心分层、Cordis 机制、Profile/Bundle、能力接缝、核心包详解、多端架构、持久化、类型安全、构建系统 |
| 03 | [依赖分析](./03-dependency-analysis.md) | 依赖管理策略、外部运行时依赖全景、Vendored 框架、内部包依赖图、原生模块依赖、与 Bun 集成的依赖考量 |
| 04 | [执行过程分析](./04-execution-process.md) | 应用启动完整链路、插件激活机制、Agent Turn/Step 执行序列、工具执行管道、LLM 流式调用、会话持久化、Electron 桌面启动、SDK 通信 |
| 05 | [工程关键设计细节](./05-engineering-design-details.md) | 13 个核心设计决策：无特权核心、注册即效果、Model-visible⟺Logged、能力接缝三角色、层叠组合、双构建面、Typert、追加式日志、无端口桌面、凭证分层、遥测、质量门禁、非显而易见约束 |
| 06 | [electrobun 桌面端 IDE 集成指南](./06-electrobun-integration-guide.md) | 三种集成架构对比、推荐方案 C（混合架构）、进程拓扑、通信协议、IDE 专用 Profile 设计、Bun 侧 IDE Core 实现、关键集成点、开发路线图 |
| 07 | [Bun 原生 API 替代映射](./07-bun-native-api-mapping.md) | Bun 1.4.x 原生 API 与 dsh 依赖的完整对照：12 个直接替代（node-pty→Bun.Terminal、js-yaml→Bun.YAML、ws→原生WebSocket）、8 个能力覆盖（sharp→Bun.Image、puppeteer→Bun.WebView）、6 个新增能力、不可替代依赖分析、三阶段替换路线图 |
| 08 | [Bun 兼容性实证测试报告](./08-bun-compatibility-test-report.md) | **从怀疑开始的完整实证验证**：81 个测试用例（Terminal/YAML/Cordis/批量API/dsh包导入）、dsh 实际启动测试、fs-ext ABI 不匹配根因定位与修复验证、stripTypeScriptTypes 替代方案、最终结论与 electrobun 集成建议 |
| 09 | [Bun 原生重构精确清单与可靠性验证](./09-bun-refactoring-plan.md) | **性能对比实证**（Bun启动快33.5倍/内存少6.7倍/YAML快3-25倍）、**19项鲁棒性测试**、**14个可重构模块精确清单**（到包名+替代方案+优先级+验证状态）、**!!js必要性分析**（29处使用全部可替代，不建议用正则）、**18项未完成验证**、**替换可靠性保障检查清单** |
| 10 | [Electrobun + dsh 桌面 IDE 工程方案](./10-electrobun-dsh-ide-engineering-guide.md) | **Electrobun 2.0 架构深度解刨**（BrowserWindow/BrowserView/RPC/Tray/Menu/GlobalShortcut/Screen/Session/Updater/Utils/PATHS/Socket）、**dsh 扩展机制深度解刨**（Cordis插件/配置YAML+profiles+patches/工具系统/JSONL会话格式/LLM适配器/代码运行环境）、**IDE集成架构方案**（三层进程模型/dsh子进程管理器/JSON-RPC通信/终端管理器Bun.Terminal/渲染进程状态管理）、**功能模块工程细节**（聊天/编辑器Monaco/终端xterm/工具可视化/设置）、**工程落地清单**（项目结构/开发环境/测试策略/CI/跨平台/性能目标/风险缓解/4阶段里程碑） |
| 11 | [官方测试全量结果记录](./11-official-test-results.md) | 官方测试全量结果：957文件，15728测试，99.1%通过，9失败逐条分析（全部与修改无关） |
| 12 | [Electrobun Host 实现与验证报告](./12-electrobun-host-implementation.md) | **Electrobun + dsh 桌面端 Host 完整实现**：架构概览、项目结构、主进程实现、Bun 兼容性修复（fs-ext动态导入、client-modules webServer注入）、认证机制详解（process-token + signed cookie）、端到端验证结果（7项全部通过）、已知限制与后续工作、文件变更清单 |
| 13 | [Bun 内置替代「实测裁决」](./13-bun-builtin-replacement-verdict.md) | **以 Bun 1.4.2 实测+真实 API 使用面 grep 对 07 理论映射的最终纠偏**：已替代 6 项（fs-ext/node-pty/@noble/picomatch/chokidar/open）的证据与测试；open 被变量动态 import 隐藏的误判纠错与 macOS 原生命令零依赖重构；yaml/js-yaml/ws/undici/fflate/eventsource-parser/mdast/diff/anser/semver 逐个「为何保留」的 file:line 证据；CompressionStream 实测可用、Bun.Markdown 不存在等能力快照；死依赖搜索方法论清单 |

## 快速回答

### Q: dsh 升级后抛弃 Cordis 改用 Pi 了吗？

**没有。** Cordis 是 dsh 的元框架（插件运行时、依赖注入、事件总线、生命周期管理），被 vendor 到本地（v4.0.2，rescope 为 `@deepseek-ai/cordis`），是整个系统的骨架。Pi-ai（`@earendil-works/pi-ai`）是一个可选的多供应商 LLM API 客户端库，作为 `dsh-llm-pi-ai` 插件的依赖，默认休眠，用户配置后才激活。二者处于完全不同的架构层级，不存在替换关系。

详见 [01-cordis-vs-pi-ai.md](./01-cordis-vs-pi-ai.md)。

### Q: dsh 的核心架构是什么？

dsh 是一个**全插件化的 AI Agent 运行时**，基于 Cordis 元框架。核心设计：
- **一切皆插件**：模型适配器、工具注册表、会话日志、Agent 循环本身都是可替换的 Cordis 插件
- **能力接缝**：每个可交换能力包含 Service Definition / Service Provider / Consumer 三角色
- **Profile/Bundle 层叠组合**：通过有序 YAML 补丁组合插件树，每层可被上层覆盖
- **Model-visible ⟺ Logged**：任何到达模型的内容必须可从会话日志重建
- **追加式会话日志**：不可变事件流 + 版本迁移机制

详见 [02-architecture-analysis.md](./02-architecture-analysis.md)。

### Q: 如何基于 dsh + electrobun (Bun@1.4.x) 构建桌面 IDE？

推荐**纯 Bun 架构**：Electrobun 主进程直接用 Bun 运行时，dsh 作为内嵌库在同一进程中运行（不需要 Node.js 子进程）。段错误已通过 Bun.FFI flock 替代 fs-ext 完全解决。需要为 IDE 创建专用 dsh Profile，开发 IDE 专用 dsh 工具插件（文件编辑、LSP、终端、代码搜索），并充分利用 Bun 原生能力（Bun.Terminal 终端、Bun.WebView UI、bun:sqlite 存储、Bun.serve API）。

详见 [06-electrobun-integration-guide.md](./06-electrobun-integration-guide.md) 和 [10-electrobun-dsh-ide-engineering-guide.md](./10-electrobun-dsh-ide-engineering-guide.md)。

### Q: dsh 真的能在 Bun 下运行吗？有没有实证？

**有完整实证，173个测试用例全部通过（0失败），纯 Bun 方案完全可行！** 关键结论：
- ✅ **sdk-minimal profile 在纯 Bun 1.4.2 下完整运行**，initialize 成功，LLM 适配器加载，Agent 循环完整执行
- ✅ **LLM 流式响应正常**：TextDecoderStream + EventSourceParserStream 在 Bun 下工作正常，SSE 解析 + translate 转换完整，Assistant 消息正常生成（回复"2"）
- ✅ **段错误已完全解决**：根因是 `fs-ext` 原生模块的异步回调在 Bun 下导致内存损坏，用 `Bun.FFI` 动态链接 libc 的 `flock(2)` 替代后，段错误完全消失
- ✅ **不需要 Node.js 子进程 workaround**，纯 Bun 方案完全可行
- ✅ Cordis框架、dsh核心包、worker_threads（16/16压力测试通过）、bun:sqlite（快1.4-1.7倍）、Bun.serve（快1.78倍）、Bun.Terminal（8/8）、Bun.FFI文件锁（10进程500条零损坏）全部验证通过
- 需要2处源码修补：
  1. `session-persistence-jsonl/lease.ts`：用 Bun.FFI flock 替代 fs-ext（段错误完全解决）
  2. `code-runtime-worker-thread/index.ts`：stripTypeScriptTypes 用 Bun.Transpiler fallback
- 启动快33.5倍，初始内存少6.7倍

详见 [08-bun-compatibility-test-report.md](./08-bun-compatibility-test-report.md) 和 [09-bun-refactoring-plan.md](./09-bun-refactoring-plan.md)。

## 分析方法

本分析基于对 deepseek-harness 仓库的完整源码探查，包括：

- 根目录 `package.json`、`pnpm-workspace.yaml`、`AGENTS.md`
- `vendor/cordis/` 核心框架源码（Context、Fiber、Service、Events、Registry）
- `packages/core/` 核心包（agent-loop、session、tools、system-prompt、agent）
- `packages/llm/` LLM 包（llm、llm-deepseek、llm-pi-ai）
- `packages/bundle/base/cordis.patch.yml` 基础组合（~80 个插件行）
- `packages/boot/app-boot/src/index.ts` 启动流程
- `apps/desktop/` 和 `apps/desktop-host/` 桌面端实现
- `docs/architecture.md` 官方架构文档
- `docs/subsystems/` 各子系统文档

所有结论均来自源码实证，非推测。
