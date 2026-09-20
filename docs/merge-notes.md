# 合并须知（fork ← 官方 upstream）

本文只讲**怎么合、怎么验、哪些地方每次都会坏**。每次把官方代码合进这个 Bun-native fork 之前先读一遍；合完按第 4 节的四关验收。

## 0. 基线与裁决原则

| 角色 | 引用 | 说明 |
| --- | --- | --- |
| **裁决基准（唯一权威）** | 分支 `merge/official-master-20260910` @ `015ae91366`（"reconcile alpha.2"） | **上一轮合并调和后的结果**，用户认可的所有视觉与行为都以它为准；用户工作区即此分支 |
| 合并前快照（仅作参考） | `ee6950e87c`，tag `backup/pre-merge-official-882-20260918` | 合并**之前**的 fork。它**缺少**调和成果，**不能**当作样式/UI 的裁决基准 |
| 共同祖先 base | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` | |
| 官方 | `origin/master` | |
| 用户认可的可用产物 | 用 `015ae91366` 构建出来的 app | 视觉对比的唯一产物基准 |

**裁决原则（修正版，曾因写错而造成样式回归）**：

1. **"fork-wins" 的准确定义**：以**上一轮调和结果（015ae91366）**为基准裁决官方改动，**不是**回退到合并前的 fork 快照。合并调和里已经吸收、改进过的东西（如 `Menu.module.css` 的 `:focus-visible` 规则、`design-platform.css` 的令牌）就是基线的一部分，回退到 fork 快照 = 制造回归。
2. 混合体扫描里，一份文件的内容可能同时"既非 fork、也非官方"——**先和 015ae91366 比**：等于它就是合规基线；不等于它才需要裁决是"本轮有意改动"还是"被官方覆盖"。
3. 官方改动是 bug 修复且不违背硬约束时可以吸收，但**必须逐文件与 015 基线对照后决定**，不做整文件覆盖。

**硬约束（不可违背）**

1. 不重新引入已移除依赖（node-pty、fs-ext、sharp、koffi、`@earendil-works/pi-ai` …）——它们已 fork 自适配。
2. 不干预模型提供方处理：内置 `deepseek-official`（`packages/llm/llm-deepseek`，`PROVIDER = 'deepseek-official'`）必须按 fork 语义工作。
3. 不破坏 fork 功能：右侧栏、设置面板、回收站、主题。
4. 仅支持 macOS arm64。
5. 逐文件对比 fork 提交，不做凭感觉的"整文件覆盖"。

**反面基准**：同事的工作区源码**不能**当基准——它也是合并产物、可能已被污染。只有 fork 基线的 commit 和**用基线构建出来的 app**能当基准。

## 1. 铁律（每次合并都要做）

1. **先扫"混合体"，再谈别的。** 自动三方合并会产出既不是 fork 也不是官方的第三种内容（本文称之为混合体）。它们不报错、能编译、看起来正常，但语义是错的。**这是历次合并出问题的主要来源。**
2. **`fork-delta > 0` 的包整包 checkout fork 基线**，再单独把官方真正的 bug 修复补回去（例如 `messagesApiRoot()`，见 3-C）。
3. **三类文件永远要人工过一遍**：样式/主题变量、装配层 overlay、请求体字段。
4. **验收必须四关全过**（第 4 节），任何一关都不能跳。
5. **改完必须让运行中的 app 完全退出重启。** 已运行的进程在内存里持着旧模块，替换磁盘文件不生效。用户两次反馈"没有任何改观"都是这个原因——先怀疑没重启，再怀疑修复无效。

## 2. 第一步：混合体扫描

脚本：`scripts/merge-hygiene.sh`（`bash scripts/merge-hygiene.sh`），内部等价于对 `git ls-tree -r <fork> <pkg>` 的每个受跟踪文件比较三方 md5。

判定：`current != fork && current != official && fork != official` ⇒ 混合体，必须逐个裁决。

用法与过滤：默认跳过 `*.md`／`*.i18n.yaml`／`package.json`／lockfile；`FORCE=1` 时全量输出。**注意**：`app 目录 / lib 产物 / node_modules` 不参与比对，它们是生成物。

裁决顺序（按风险从高到低）：

1. 运行时语义文件（协议、序列化、请求体、env 构造）→ 逐个 diff fork 与官方，**取 fork 语义 + 只吸收官方明确的修复**。
2. 样式与主题 → 回退 fork（第 3-A 节）。
3. 装配层 overlay → 回退 fork，但把官方新增的插件挂载**单独审查**（第 3-B 节）。
4. 纯文档、`.d.ts`、构建产物 → 忽略。

### 2.1 混合体不等于"全是错误"

扫描把"内容既不是 fork 也不是官方"的文件全列出来，其中必然包含**本次有意做的本地改动**。判断一个条目属于哪一类，只看一句话：**这个 diff 是不是我/上一个里程碑故意做的？**

| 属于"有意改动"（登记后放行） | 属于"事故"（必须处理） |
| --- | --- |
| 打包/构建脚本（`scripts/*`）、tsconfig、lockfile 的适配 | 运行时语义文件被官方内容覆盖（协议、序列化、env） |
| overlay 里 fork 特意关掉的插件与 shell 配置 | 样式/主题令牌被官方设计改写 |
| 主动移除依赖时改到的清单与导出面（例如移除 `@earendil-works/pi-ai`） | 组件与它的 `*.module.css` 只回退了一半 |
| 测试断言随行为同步更新的改动 | 装配层官方新增的插件挂载（默认值随官方走） |

**怎么快速分辨**：`git log -p -- <file>` 看该文件的最近改动是不是自己的里程碑提交；若是，登记为有意改动并跳过；若不是，按第 3 节三类重灾区处理。

扫描输出里"跳过 N 个文档/清单"的数字很大（数千）是正常的——fork 与官方的 README、`*.i18n.yaml` 本来就大面积不同，它们不参与运行时，无需裁决。**看的是被列出来的那份名单，不是跳过数。**


## 3. 三类重灾区（都是真实事故）

### A. 样式与主题

**症状**：暗色模式下菜单/面板样式变了、下拉菜单焦点框消失、明明"没人动过 UI"。

**机制**：官方 alpha 版本会重做设计令牌，回退时只回退 CSS 但**组件也在官方版**，于是类名与结构对不上；或者只回退了组件而 CSS 仍是官方的。

| 真实案例 | 官方改动 | 修复 |
| --- | --- | --- |
| `packages/client/ui-theme/src/styles/design-platform.css` | 新增 `--dsw-alias-bg-document-preview` 等 4 行 | 回退 fork（主题变量数应回到 357） |
| `packages/client/ui-primitives/src/Menu.module.css` | 菜单项 `:focus-visible { outline: none }` —— 移除焦点轮廓 | 回退 fork |
| `ui-conversation`／`ui-workspace`／`ui-settings-models` 的 `*.module.css` | 大幅重排（单个文件最多 156 行） | 回退 fork |

**验证手法**

- **裁决基准是 015ae91366（调和结果），不是 fork 快照**——曾按 fork 快照回退这些文件，结果把用户认可的 `:focus-visible` 规则与主题令牌一起回退掉了（截图里菜单变成浅色半透明）。
- **不要比对类名**：CSS Modules 的 hash 每次构建都变，比出来全是差异。要比**变量的定义与值**，或规则的**文本内容**。
- 类名一致性检查：从组件里抽 `css.X`／`styles.X` 的引用集合，与 CSS 里定义的类名集合做差集。**注意变量名可能是 `css` 而不是 `styles`**——搞错变量名会得到"零差异"的假结果。
- 最终判据：`ui-theme` 的令牌数量与变量名集合要和 fork 基线的 app 完全一致。

### B. 装配层 overlay

**位置**：`apps/electrobun-host/config/electrobun.cordis.patch.yml`（桌面版 overlay，打包时并入 `Resources/app/config/`）。

**症状**：桌面端行为与 web 版不同、装/卸插件失效、请求里多出字段。

**机制**：官方会**新增插件挂载**或在 bundle 里改动同一行；overlay 里的 `disabled: true`／`config: { enabled: false }` 是 fork 特意关掉的东西，很容易在合并中被"补回来"。

**要点**

- 新增的官方插件挂载必须**逐个判断**是否适合本 fork（第 3-C 节就是漏判的后果）。
- 改完 overlay 后，**到产物里复核**：`grep -A2 'id: <plugin>' <app>/Contents/Resources/app/config/electrobun.cordis.patch.yml`。

### C. 协议与私有请求字段

**症状**：DeepSeek 报 `HTTP 400 INVALID_REQUEST`，且错误信息看不出原因。

**机制**：官方会通过 request extensions 往请求体塞**官方端点私有**的顶层字段；第三方中转站（以及任何兼容网关）不认识就整条拒绝。历次事故字段：

| 字段 | 注入方 | 处置 |
| --- | --- | --- |
| `dsh_session_log` | `packages/session/session-log-deepseek` | overlay 里 `disabled: true` |
| `dsh_plugin_packages` | `packages/llm/plugin-package-inventory-deepseek` | overlay 里 `config: { enabled: false }` |

**同时要吸收官方真正的修复**（不能一刀切回退）：fork 的 Messages 路径硬编码 `/v1`，baseURL 自带 `/v1` 时会拼成 `/v1/v1/messages`；官方的 `messagesApiRoot()` 正是修这个——**取官方的 URL 逻辑，保留 fork 的 Bun `textStream()` 读取**。

**错误可读性**：适配器原先只解析 `{ error: { message } }`，而兼容网关用**顶层** `{ code, message }`，导致永远只能看到 `HTTP 400`。已补 `topLevelError()`（`protocols/chat-completions/adapter.ts` 导出，responses 适配器复用）。**合并时不要把这个回退掉**——它是定位此类问题的唯一线索。

## 4. 验收四关（缺一不可）

```bash
# ① 双 typecheck：必须双 0
bun node_modules/typescript/bin/tsc -b tsconfig.client.json --pretty false
bun node_modules/typescript/bin/tsc -b tsconfig.host.json  --pretty false

# ② 受影响包的测试（改了行为就连 spec 断言一起改）
bun node_modules/vitest/vitest.mjs run packages/llm/llm-deepseek/tests/ packages/credentials/

# ③ 打包（内部会跑 build:lib + web dist + 闭包审计）
bun scripts/pack-stable-app.ts

# ④ 产物审计：契约文件、私有字段、主题令牌
APP=apps/electrobun-host/build/stable-macos-arm64/Colaw.app
grep -A2 'id: session-log-deepseek' "$APP/Contents/Resources/app/config/electrobun.cordis.patch.yml"
```

第 ⑤ 关（不能省）：**真实请求 smoke**。用真实凭据、真实端点、**从会话里取出的真实请求体**发一次。判据是 `HTTP 200`，不是"看起来对"。

> 构建命令注意：`bun scripts/build.ts` 会因缺 `npm_execpath` 直接失败，必须经包管理器触发：
> `bun /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs run build:lib`（或 `run build`）。

## 4.5 迁移结账（相对官方 origin/master 的功能账）

**核实方法**：`git diff --diff-filter=D --name-only origin/master..HEAD -- packages apps`（删除）+ 包组目录 diff + overlay 的 `disabled` 行 + `OPTIONAL_BUNDLES`。

### 我们主动关闭的官方功能（有意为之）

| 位置 | 项 | 原因 |
| --- | --- | --- |
| overlay `disabled: true` | `session-log-deepseek` | 私有请求字段 `dsh_session_log`，兼容网关 400 |
| overlay `config.enabled: false` | `plugin-package-inventory-deepseek` | 私有请求字段 `dsh_plugin_packages`，兼容网关 400 |
| overlay `disabled: true` | `session-log-download` | 桌面壳只保留"本地打开"与右栏开关 |
| overlay `disabled: true` | `command-feedback` | 桌面产品有自己的支持渠道，composer 里的反馈命令是噪音 |
| overlay `disabled: true` | `session-telemetry-otel` | 个人构建不向外发送遥测；OTLP 树已从闭包排除 |
| 打包排除 | `@deepseek-ai/dsh-session-telemetry-otel` 及其 `@opentelemetry` 树 | 同上（`pack-stable-app.ts` 有断言：两处必须一致） |

### 官方有、我们尚未吸收

| 项 | 状态 |
| --- | --- |
| `packages/document/office-to-pdf` | 官方 **alpha.2 新增**（base/015/fork 均无），**无人引用**，未吸收；吸收它需要连带接入 provider 与 UI |
| **Office 文档能力（docx/pptx/xlsx）** | 见下方专节——**不是"漏了一个包"，而是官方整条 Electron 链路**，我们这套 Electrobun 构建里没有对应层 |

#### Office 文档能力：官方是三层，我们一层都没有

官方桌面版（`apps/desktop/` + `apps/desktop-host/`，Electron）把 Office 能力拆成三层：

| 层 | 官方组件 | 职责 | 我们的状态 |
| --- | --- | --- | --- |
| ① 技能指令 | `packages/skill/skill-office`（`assets/office-{docx,pptx,xlsx}/SKILL.md` + `assets/scripts/check_office.py`） | 教模型怎么写/改/检查 Office 文件；checker 只用 Python 标准库 | **官方新增**（base/015/fork 均无） |
| ② 依赖查询工具 | `apps/desktop-host/src/workspace-dependencies.ts` → 工具 `load_workspace_dependencies` | 返回**内置** Python/Node/pnpm 的绝对路径与已装库版本 | **无**（desktop-host 已被本 fork 移除） |
| ③ 内置 Python 运行时 | `apps/desktop-host/src/primary-runtime.ts` + 安装器 payload | 离线安装带 **numpy / pandas / python-docx / python-pptx / openpyxl / Pillow / lxml / XlsxWriter** 的 Python 发行版 | **无**（需要构建产物：Python 发行版 + wheels） |

**为什么没有直接吸收**：SKILL.md 明确要求"用 `load_workspace_dependencies` 返回的 Python 执行，**不要**安装包、不要探测系统 Python"。只把 ① 拉进来会得到一个**看起来能用、实际缺 Python 依赖**的假能力——比缺失更糟。要真正支持，需要新增 ③ 那套 payload 的构建与分发（Python 发行版 + 一组 wheel，随 app 打包），这是**独立里程碑**，不是合并动作。

**当前状态**：已从 `packages/skill/` 与 overlay 中移除（不留半成品）；仓库里已内置的 skill 是 `skill-badge`、`skill-filesystem`、`skill-baidu-netdisk`，以及 cordis preset 的两个开发 skill。

> 其余官方包组与包**已全部吸收**（包组目录 diff 为空）。

### 待办（按优先级）

1. **移除 agent-team 可选功能**（用户明确不要 team）：
   `packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 里两项
   （`dsh-experimental-agent-team-profile`、`dsh-experimental-agent-team-web-profile`）
   当前**默认关闭但暴露在插件管理器**；移除后其 5 个包可从闭包排除。
2. **测试缺口**（当前已知失败，均为**预存在**、非本轮引入，但迁移未完成前应逐一裁定）：
   - `subprocess-local/control.spec.ts`：4 failed / 6（managed control pipe，macOS 语义差异）
   - `api/terminal-controller/controller.spec.ts`：1 failed / 48（"runs a real interactive shell" 真 shell 交互）
   - `terminal/terminal-bash/tests`：3 failed / 112
3. **`PROMPT_COMMAND` 残留风险**：zsh-only 变量已按 shell 类型门控，但**用户实测反馈的"`line 5/6` 语法错误"在修复前出现过**；需要在真机 bash tab 复验一次（预期已消失）。
4. **未验证面**（迁移远未结束的实证）：
   - 真实凭据 smoke（第 ⑤ 关）在本轮**未重新执行**（上一次 200 是修 400 时做的）
   - 右侧栏各面板、设置面板、回收站、主题切换等 fork 功能**未做回归清单式验证**
   - 打包产物的 `.map` 门禁、bun 钉死一致性门禁已加，但**没有 CI 承接**

### 4.6 Bun 平台边界：Node 内部模块加载器（已查清，非缺陷）

**事实**：`node-addon-require-builtin` 通过 V8 的 current-context 符号访问 Node 内部加载器
（`internal/modules/esm/loader` 等）。**Bun 用 JavaScriptCore，没有这些符号**，因此
`requireBuiltin()` 在 Bun 下必然抛：

```
node-addon-require-builtin unsupported: Unsupported/no-context
  (required V8 current-context symbols were not found)
```

**实测证据**：

- 在包内的 Bun 里直接调用 → 抛上述错误（可复现）
- 但**打包后的 App 启动日志里该错误计数为 0**：`PluginPackages` 只在
  `config.generation !== undefined` 时安装该 resolver，而 Electrobun 的 web profile
  不传 generation（这套机制服务于 Node CLI 的多 profile 场景）
- 该 addon 与 `profile-resolution-bootstrap.js` 虽在包内，但**运行时不被走到**

**受影响的测试**（`packages/boot/app-boot/tests`，共 67 项）：

| 表现 | 数量 |
| --- | --- |
| `require-builtin unsupported`（V8 符号缺失） | 62 |
| `Node module internals are unreachable`（同一根因，措辞不同） | 1 |
| 依赖上述机制的断言（`expected undefined to be true`） | 4 |

**裁定**：这是**平台边界**，不是迁移缺陷，也不是待办。用 Node 跑这套测试时它们会失败，
用 Bun 跑同样失败（符号缺失与运行时无关，取决于 addon 自身）。**不要**为了让它们变绿
去改产品代码；若将来 Bun 支持该机制，这 67 项应自然恢复。

**复核方式**（任何时候可重新确证）：

```bash
# 1) 机制本身不可用
APP=apps/electrobun-host/build/stable-macos-arm64/Colaw.app
"$APP/Contents/MacOS/bun" -e 'const m=require("'"$PWD"'/'"$APP"'/Contents/Resources/app/node_modules/node-addon-require-builtin"); try{m.requireBuiltin("internal/modules/esm/loader")}catch(e){console.log(e.message)}'
# 2) App 运行时不走该路径：启动日志里该错误应为 0
```

## 5. 排查纪律（踩过的坑）

- **别按错误文案猜代码路径。** `DeepSeek API error (HTTP` 只出现在 chat／responses 适配器，messages 适配器用的是另一套文案——只看文案会一路查错方向。
- **手工构造的请求不等于真实请求。** 自己拼的 body 永远"通过"，因为它缺的正是要查的那个字段。真实请求要从会话日志取：`~/.colaw/sessions/<project>/session-<id>/session.v3.jsonl.zstd`（用 app 内置的 `Contents/MacOS/zig-zstd decompress -i <in> -o <out>` 解压），看 `request/header`（config + tools）与 `request/context` 事件。
- **逐字段对照，而不是整包替换。** 定位上游拒绝时，拿真实的 `tools`／`messages`／system 原文发对照实验，一次只变一个字段。
- **大文件编辑用精确锚点或按行删除，禁用贪婪正则。** 曾用 `re.sub(r',(\s*[}\]])', ...)` 处理整份 `tsconfig`，把四万多行压成了几行。改完必须复核行数。
- **改了运行时行为就同步 spec 断言**（例如 reasoning 字段的构造方式变了，`messages/serialize.spec.ts` 与 `adapter.spec.ts` 要一起改），否则测试会指着过时的期望。
- **判断"哪份代码在跑"看产物时间戳**：`ls -l <app>/Contents/Resources/app/node_modules/@deepseek-ai/<pkg>/lib/index.js`。进程在运行 ≠ 跑的是新代码。
- **文本脚本的 `.filter()` 别用变量名当后缀匹配**：`str.replace` 的锚点要整行匹配，否则会命中长文件里同名的注释。

## 6. 交付前清单

- [ ] `scripts/merge-hygiene.sh` 输出的混合体已全部裁决，或已在本文档登记例外
- [ ] `fork-delta > 0` 的包已整包对齐 fork 基线
- [ ] 三类重灾区（样式／overlay／请求字段）已逐一核对
- [ ] 双 typecheck 为 0
- [ ] 受影响测试通过；因行为变更而更新的 spec 已同步
- [ ] 已打包，且产物审计通过（契约 overlay、无 `pi-ai`／`node-pty` 残留、主题令牌数与基线一致）
- [ ] 已用真实凭据＋真实请求体发过一次 smoke 请求并成功
- [ ] 已提醒：**完全退出并重启** app 后再验证
