# 13. Bun 内置替代「实测裁决」：依赖去外部化的证据矩阵与纠偏

> 运行时基准：**Bun 1.4.2**（`/usr/local/bin/bun`，NODE_MODULE_VERSION=147）、目标仅 **macOS arm64**、完全抛弃 Node.js
> 对象：deepseek-harness **v0.1.3-alpha.2**（分支 `feature/bun-runtime-detection`）
> 成文：2026-09-08
>
> **本文与 07 的关系**：07《Bun 原生 API 替代映射》是动手前的**理论映射**，其中若干判断（`js-yaml→Bun.YAML`、`ws→原生 WebSocket`、`sharp→Bun.Image`、"Bun.Markdown 可用"）在通读 Bun 文档、grep dsh **真实 API 使用面**、并在 Bun 1.4.2 实测后被**修正或推翻**。本文是用一手证据给出的**最终裁决**；当 07 与本文冲突时，以本文为准。

---

## 0. 方法论：为什么必须实测、为什么 grep 会骗人

用户的硬约束是"应替尽替，但必须非常可靠，靠证据说话，不能只 mock"。本轮三条方法论全部来自真实踩坑：

1. **官方文档也会过时，能力要在目标运行时实测。** 典型反例：Bun 的 Node API 兼容页长期把 `CompressionStream` 标为 🔴 未实现，但在 1.4.2 实测 gzip 压缩/解压往返**完全可用**（见 §5.4、测试 30）。反过来，07 想当然认为存在的 `Bun.Markdown`，在 1.4.2 实测是 `undefined`。
2. **判断"依赖是否被使用"必须覆盖全部引用形态，且要搜子路径。** 只搜 `from 'pkg'` 会漏掉：
   - 子路径导入：`eventsource-parser/stream`（一度因此误判 eventsource-parser 是死依赖，见 §5.5）；
   - `import.meta.resolve('pkg')` + **变量动态 import**：`open` 包因此一度被误判为"零引用死依赖"，删除后被官方 `transform-corpus` 测试拦截（见 §4）。
3. **能力存在 ≠ 能力够用。** 必须 grep 出 dsh 到底用了该包的**哪些 API**，再逐条对照 Bun 内置是否覆盖。`Bun.YAML` 有 parse/stringify，但 dsh 的 `yaml` 用的是 AST 层 `Document/parseDocument/isMap/isScalar`，二者不在一个层级（§5.1）。

> 可复跑的能力边界断言固化在仓库外 `bun-compat-tests/tests/30-bun-builtin-capability-snapshot.test.ts`（13 测 / 45 expect），升级 Bun 后重跑即可发现能力漂移。

---

## 1. 裁决总览矩阵

| 依赖 | dsh 真实用途（代表 file:line） | 裁决 | Bun 1.4.2 对应 / 处置 |
|---|---|---|---|
| `fs-ext` | POSIX 文件锁 `flock` | ✅ **已替代** | `Bun.FFI` 直调 libSystem `flock`（340 测试） |
| `node-pty` | PTY 伪终端 | ✅ **已替代** | `Bun.Terminal` + `Bun.spawn`（254 测试，12 skip） |
| `@noble/hashes` | webworker 沙箱同步摘要 | ✅ **已替代（Bun 分支）** | Bun 走 `node:crypto`；@noble 仅留 Node fallback（§6） |
| `picomatch` | glob 匹配 | ✅ **已替代** | `Bun.Glob`（picomatch-adapter） |
| `chokidar` ×3 消费包 | 文件/目录递归监听 | ✅ **已替代** | 原生 `fs.watch` 适配器（补齐 symlink 穿透 + 根存活轮询，1081 测试） |
| `open` | `dsh web` 拉起系统默认浏览器 | ✅ **原生重构（非删除）** | 直接 spawn macOS `/usr/bin/open`，去掉嵌套 runtime 子进程（§4） |
| `yaml` | **AST 级** YAML 编辑（保注释/锚点） | ⛔ **保留** | `Bun.YAML` 无 AST，无法替代（§5.1） |
| `js-yaml` | dsh 自用 `load` + **沙箱内供给用户 skill 代码** | ⛔ **保留** | 沙箱必须提供完整 js-yaml（§5.2） |
| `ws` | **服务端** `WebSocketServer({noServer})` 接管 http upgrade、pong 心跳 | ⛔ **保留（架构级）** | 全局 `WebSocket` 只是客户端；要替需把 http server 一起迁到 `Bun.serve`（§5.3） |
| `undici` | 按 origin 编程式代理/连接池 `Agent/Pool/ProxyAgent/GlobalDispatcher` | ⛔ **保留** | 原生 fetch 无 dispatcher 体系（§5.4） |
| `fflate` | **流式 ZIP 容器** `Zip/ZipDeflate`（中央目录） | ⛔ **保留** | CompressionStream/node:zlib 只给压缩算法，无 ZIP 封装（§5.4） |
| `eventsource-parser` | LLM SSE 分帧 `EventSourceParserStream`（子路径导入） | ⛔ **保留** | 零依赖、7.8KB；原生 EventSource 不支持 POST/Authorization（§5.5） |
| `mdast-util-*` | Markdown→**AST** 遍历变换（gfm/math） | ⛔ **保留** | `Bun.Markdown` 1.4.2 不存在，且只出 HTML 不产 AST（§5.6） |
| `diff` | `structuredPatch` 统一 diff | ⛔ **保留** | Bun 无内置（§5.7） |
| `anser` | ANSI 转 JSON 着色 | ⛔ **保留** | Bun 无内置（§5.7） |
| `semver` | 仅 `apps/desktop`（Electron 端）用 `valid` | ♻️ **随 Electron 废弃自然消除** | `Bun.semver` 仅 satisfies/order、无 valid（§5.8） |

体积基线（`.pnpm` 实测，KB）：undici 5944、js-yaml 1968、diff 1852、yaml 1276、fflate 828、semver 960、ws 196、eventsource-parser 160、anser 48、chokidar 268（+readdirp 84，仅余 vendor/hmr 与 webworker devDep）。

---

## 2. 已完成替代（生产代码，均有测试背书）

| 替代 | 实现位置 | 验证 |
|---|---|---|
| fs-ext → Bun.FFI flock | `session-persistence-jsonl/src/fs-ext-adapter.ts`、`lease.ts`（macOS `/usr/lib/libSystem.B.dylib`，LOCK_EX=2/NB=4/UN=8） | 340/340；测试 12/16 |
| node-pty → Bun.Terminal | `subprocess-local/src/{pty-adapter,node-pty-adapter,bun-pty-adapter}.ts` | 254（12 skip）；测试 01/26 |
| @noble/hashes → node:crypto | `webworker-runtime/src/node/builtin_modules/implemented/crypto.ts`（IS_BUN 分支 createHash） | 测试 30 哈希断言 |
| picomatch → Bun.Glob | `webworker-runtime/src/picomatch-adapter.ts`、`shell/expand.ts`、`shell/programs/files.ts` | webworker 套件 |
| chokidar → 原生 fs.watch | `util/home-paths/src/chokidar-adapter.ts`；消费包 settings-file/credentials-local/skill-filesystem | 五包 1081；测试 29（13 测） |

**fs.watch 迁移补的两个深层场景（本轮彻底收尾，均在 macOS arm64 / Node22 / Bun1.4.2 双跑对照）：**

- **followSymlinks 穿透**：recursive `fs.watch` **不会** follow 指向监听树外的 symlink，改 target 零事件。实现对 symlink 的 realpath target 单独建 recursive watcher，并用 `join(linkPath, targetRelative)` 把事件路径**映射回树内**（否则上层 `isRelevantWatchEvent` 因 `..` 丢弃事件）。`seen` Set 防环、递归上限 32；运行时新建 symlink 动态补 follow。
- **被监听根目录随父树 `rm -rf`**：原生 fs.watch **一个删除事件都不投递**（子项/根都不报），但句柄存活、同路径重建可恢复。实现 `startLivenessPoll`（`existsSync` 周期 clamp 20–1000ms、`unref` 不拖住事件循环），在"存在→消失"补 emit `unlinkDir(root)`、"消失→重建"补 emit `addDir(root)`，与 dsh 的 `handleWatchEvent` 状态机（unhealthy→rewatch/ancestor watchFile）对齐。

---

## 3. 验证总表（本轮结束时）

| 套件 | 运行器 | 结果 |
|---|---|---|
| settings-file + credentials-local + skill-filesystem + webworker-runtime + **web-app** 五包联合 | 官方 vitest（仓库根运行） | **49 文件 / 1081 测试全过** |
| 其中 transform-corpus（每个 built bundle 能否裸运行时 import） | vitest | 1/1（补了 ui-dockkit 的 .css 官方基线豁免） |
| bun-compat-tests 全量 01–30（逐文件独立跑，规避端到端用例 process.exit 截断） | `bun test` | **321 pass / 0 fail** |
| 新增 30 内置能力快照 | `bun test` | 13 测 / 45 expect |
| 严格类型 `tsc -b tsconfig.host.json --force` | tsc | **0 error** |
| `pnpm run build:lib:host` | tsdown | 成功（worker.js 712.96 kB / gzip 165.57） |
| lockfile 一致性 `pnpm install --frozen-lockfile` | pnpm | Already up to date |

---

## 4. 重要纠错：`open` 不是死依赖，而是被"变量动态 import"藏起来了

### 4.1 误判过程（教训）

第一轮全仓搜 `from 'open'` / `require('open')` / `import('open')` **字面量**，结论是"零引用死依赖"，遂从 `packages/bundle/web-app/package.json` 删除。但五包联合回归时，官方 **transform-corpus** 测试立刻失败：

```
packages/bundle/web-app/lib/index.js: Cannot find package 'open'
```

源码真相（`packages/bundle/web-app/src/index.ts`）：

```ts
const BROWSER_OPENER_MODULE = import.meta.resolve('open')      // 路径先解析成字符串
const { default: open } = await import(/* 变量 */ BROWSER_OPENER_MODULE)
```

引用被拆成"**`import.meta.resolve` 拿路径字符串 + 对变量做动态 import**"，字面量 grep 完全匹配不到。**这是本轮最有价值的一次自我纠错：判定死依赖前必须额外搜 `import.meta.resolve('pkg')`，且删除后必须跑覆盖构建产物的测试。**

### 4.2 它到底做什么

`dsh web` 启动本地 Web 服务后，需要拉起系统默认浏览器打开带 token 的 URL。原实现：父进程 spawn 一个**嵌套的 `process.execPath --input-type=module --eval <程序字符串> -- <url>` 子进程**，子进程里再 `import open` 打开浏览器；用 `scrubbedParentEnv()` 剥离 `DEEPSEEK_API_KEY/DSH_HOME`，避免凭证泄露给浏览器启动链。

### 4.3 零依赖原生重构（仅 macOS arm64，Linux 开发零成本保留）

macOS 打开默认浏览器本就是系统命令 `/usr/bin/open <url>`，**既不需要 npm 包，也不需要再套一层 runtime eval 子进程**。重构后：

```ts
const PLATFORM_BROWSER_OPENER = {
  darwin: { command: 'open',    prefixArgs: [] },
  linux:  { command: 'xdg-open', prefixArgs: [] },
} satisfies Record<string, { command: string, prefixArgs: readonly string[] }>

function spawnBrowserLauncher(url) {
  const opener = PLATFORM_BROWSER_OPENER[process.platform]
  if (!opener) throw new Error(`no native browser opener for platform ${process.platform}`)
  return spawn(opener.command, [...opener.prefixArgs, url], {
    env: scrubbedParentEnv(),                 // ← 凭证剥离这一安全属性完整保留
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}
```

- `openBrowser` 的 close/error/stderr 透传、非零退出转 manual-URL 警告等逻辑**一行未动**；
- 删除 `BROWSER_OPENER_MODULE` 与整段 `BROWSER_OPENER_PROGRAM`（含只为 Windows PowerShell 服务的 `launcher.ref()` 分支——目标不含 Windows）；
- 同步更新 `tests/web-app.spec.ts` 的形态断言（仍校验 env 不含密钥、stdio 形态），`browser-open.spec.ts` 因整体 stub `openBrowser` 不受影响；
- **实测证据**：`/usr/bin/open` 存在（306 KB 系统二进制）；Bun spawn 能正确传参并回收 exit code/stderr（非法参数回显了传入参数、退出码 1，证明进程通道与错误路径均工作）。
- **与 dsh 官方惯例一致的旁证**：`packages/host/open-in-app`（"在外部 App 打开"）本就**不依赖 open npm 包**——它经 `@deepseek-ai/dsh-native-command` 解析出 argv（macOS 即 `open -a <app>`），用 `child_process.spawn(command, args, { 凭证清洗环境 })` detached 启动（`open-in-app/src/resolver.ts:15/76`）。本次 web-app 改造正是对齐这一既有模式。
- 结果：web-app 4 文件/21 测试全过，重建后 `web-app/lib/index.js` 对 open 的引用为 **0**；`open` 整条传递链（open/default-browser/define-lazy-prop/is-in-ssh/is-inside-container/powershell-utils/wsl-utils/is-wsl 共 10 包）从 lock 与物理 store 全部清除，`require.resolve('open')` → **MODULE_NOT_FOUND**。

---

## 5. 经实测"保留 / 不可简单替代"的依赖（逐个给证据）

### 5.1 `yaml`：dsh 用的是 AST 层，Bun.YAML 没有 AST

- 真实用法：
  - `settings-file/src/index.ts:14` `import { Document, parseDocument } from 'yaml'`
  - `credentials-local/src/index.ts:42` `import { Document, isMap, isScalar, parseDocument, type YAMLError } from 'yaml'`
  - `skill-filesystem/src/index.ts:19` 用到 `parse`
- settings/credentials 是**读-改-写**用户配置文件，需要 `Document` AST 在保留注释/键顺序/锚点的前提下定点修改节点（`isMap/isScalar` 判断节点类型）。
- Bun 1.4.2 实测 `Object.getOwnPropertyNames(Bun.YAML) === ['parse','stringify']`：**没有** `Document/parseDocument/isMap/isScalar/YAMLError`，且 `stringify` 输出是 flow 风格（`{a: 1,b: [2,3]}`），不做注释保持。
- **裁决：保留 `yaml`。** 只有"一次性整体 parse/stringify、不在乎注释与排版"的边角才可用 Bun.YAML，替换 settings/credentials 会破坏用户配置文件。

### 5.2 `js-yaml`：一半自用，一半是沙箱供给用户代码的"内置模块"

- dsh 自用：`app-boot/src/index.ts:13`、`agent-presets/src/composition-inventory.ts:14`（`load`）、`webworker-packer/src/pack.ts:25`。
- 关键：`webworker-runtime/src/worker-host.ts:379` 通过 `loader.resolve('js-yaml', root)` 把**完整 js-yaml 作为可加载模块提供给沙箱里的用户 skill 代码**。用户代码可能调用 `dump`、`SCHEMA`、`Type` 等 Bun.YAML 不具备的 API。
- **裁决：保留 `js-yaml`。** dsh 自用的 `load` 理论上可换 `Bun.YAML.parse`，但要逐个验证 schema 行为且收益极小；沙箱供给面决定了这个包不能移除。

### 5.3 `ws`：dsh 用的是服务端 upgrade，全局 WebSocket 是客户端，替代属架构级

- 生产用法：
  - `api/gateway/src/stream-server.ts:5` `import WebSocket, { WebSocketServer, type RawData } from 'ws'`
  - `experimental/inspector/src/worker/bridge/endpoint.ts:6` `import { WebSocketServer, type RawData, type WebSocket } from 'ws'`
- 用法是 `new WebSocketServer({ noServer: true })` 从**外部 node:http server 接管 upgrade 事件**、手动 `handleUpgrade`、`on('pong')` 心跳、读 `readyState/isBinary/RawData`。
- Bun 的全局 `WebSocket` 是**客户端类**；Bun 的服务端 WS 能力绑定在 `Bun.serve`（uWebSockets）的 `websocket` 选项里。要替代 `ws`，必须把底层 node:http server **一起迁移**到 `Bun.serve` 并重写 upgrade 路由、心跳、多路复用流。
- **裁决：本轮保留。** 这是网络核心的架构级改动，不在"等价替换"范畴；若推进需单独立项并对 noServer upgrade、ping/pong、背压做充分测试。

### 5.4 `undici` 与 `fflate`：编程式代理体系 / ZIP 容器，均非"压缩流"层面能解决

**undici（保留）**
- `util/http-proxy/src/install.ts:10/144/145`：`Agent/Pool/ProxyAgent` + `getGlobalDispatcher/setGlobalDispatcher`，按 origin 匹配做编程式代理与连接池策略（注释明确说明 `EnvHttpProxyAgent` 表达不了其 matcher 语义）。
- 原生 `fetch` 没有 dispatcher 抽象，无法按 origin 注入不同代理。**保留。**

**fflate（保留，但要澄清一个文档误区）**
- `session-query/session-log-export/src/archive.ts:24/441/460/488/552/566`：`new Zip(...)` + 多个 `new ZipDeflate(entry.path,{level})`，做**分块 push、可 abort 的流式 ZIP 容器**（要写 local file header、中央目录、EOCD）。
- 实测澄清：Bun 1.4.2 的 `CompressionStream/DecompressionStream('gzip'|'deflate-raw')` **确实可用**（兼容页"未实现"已过时，测试 30 有往返断言），`node:zlib` 也 98% 可用——但它们只提供**纯 deflate/gzip 算法流**，**没有 ZIP 容器封装**。用它们替代 fflate 等于自己实现 ZIP 格式（中央目录/CRC64/分片），风险与收益不匹配。**保留 fflate。**

### 5.5 `eventsource-parser`：子路径导入，曾差点被当死依赖删掉

- `llm/llm-deepseek/src/sse.ts:14`：`import { EventSourceParserStream } from 'eventsource-parser/stream'`，配合原生 `TextDecoderStream` 做 SSE 分帧（多 `data:` 行拼接、注释、跨 chunk/CRLF/UTF-8 边界）。
- 这是 **LLM 流式输出的核心链路**。第一轮只搜包名 `eventsource-parser` 漏掉了 `/stream` 子路径，误判零引用；用"含子路径"重搜才定位。
- 原生 `EventSource` 只支持 GET + 自动重连，**不支持 POST/Authorization 头**，LLM 调用用不了；手写跨 chunk SSE 状态机风险高，而该包核心仅 7.8KB、**零依赖**。**保留。**

### 5.6 `mdast-util-*`：要的是 Markdown AST，不是 HTML

- `client/ui-primitives/src/markdown/parse.ts:12/27/40` 用 `fromMarkdown` + `gfmFromMarkdown` + `mathFromMarkdown` 把 Markdown 解析成 mdast `Root` 节点树做遍历/变换（代码块、CJK 加粗等定制），另有 `cjkFriendlyStrong.ts` 的 micromark 扩展。
- 实测 **`Bun.Markdown` 在 1.4.2 为 `undefined`（尚不存在）**；即便未来存在，Markdown→HTML 也不产出可遍历 AST，方向不同。**保留。**

### 5.7 `diff` / `anser`：Bun 无对应内置

- `diff`：`fs/tool-fs/src/diff.ts:7/34` 与 `client/ui-trajectory/src/client/TrajectoryTable.tsx:16/1317` 用 `structuredPatch` 生成统一 diff（带 context 行）。Bun 无内置。
- `anser`：`client/ui-primitives/src/ansi.ts:4/432` 用 `Anser.ansiToJson(...,{json:true,remove_empty:true})` 把终端 ANSI 转成带色 JSON 段。Bun 无内置。
- **均保留。**

### 5.8 `semver`：只服务将被废弃的 Electron 端，迁移时自然消失

- 全 src 唯一生产 import：`apps/desktop/src/release.ts:3` `import { valid } from 'semver'`；声明仅在 `apps/desktop/package.json`。
- `apps/desktop` 是将被 Electrobun 取代的 **Electron** 壳，废弃后该依赖自然消除。
- 实测 `Bun.semver` 只有 `satisfies/order`（性能约 20x），**没有** `valid/clean/inc/major/minor/patch/prerelease/parse`；若其它路径将来需要 `valid`，需自行实现或保留，不能直接用 Bun.semver 顶上。

---

## 6. 待评估项：`@noble/hashes` 的 Node fallback 分支

`webworker-runtime/.../implemented/crypto.ts` 目前是**双运行时分支**：Bun 走原生 `node:crypto.createHash`（已验证 sha256 等同步 digest 正确），Node 分支才 `require('@noble/hashes/...)`。既然目标是**完全抛弃 Node**，理论上可删除 Node 分支并把 `@noble/hashes` 从 webworker-runtime 的 dependencies 移除。本轮**暂不动**：它属于"删生产依赖 + 改双运行时结构"，需要同步确认沙箱内用户 skill 代码不存在间接依赖，并补回归。列为下一步可安全收敛项（预计只减体积、不改 Bun 行为）。

---

## 7. 给后续替换的检查清单（避免重蹈本轮误判）

1. 搜使用面必须同时覆盖：`from 'p'`、`from 'p/sub'`（**子路径**）、`require('p')`、`import('p')`、**`import.meta.resolve('p')` + 变量动态 import**。
2. 删依赖前先确认构建产物（`lib/`）里是否还有它，并跑**会加载 built bundle 的测试**（transform-corpus 这类），不能只看 src grep。
3. 判能力要在 Bun 1.4.2 实跑（存在性 + 真实往返），并把结论沉淀进 30 号快照测试；文档兼容表只作线索不作结论。
4. 区分"算法/数据格式能力"与"容器/协议/AST/调度体系"：后者往往不是内置 API 能等价替换的（ZIP 容器、WS 服务端、SSE 状态机、YAML/mdast AST、dispatcher）。
5. 动网络核心（ws/undici）与删生产依赖前，先说明范围与风险，优先走适配器 + 真实运行时测试，禁止只用 mock 下结论。
6. 非必要不用正则；YAML 非必要不支持 `!!js`——实测 Bun.YAML 本就把 `!!js/regexp` 当**普通字符串**（`"/ab+c/i"`），不会构造 RegExp，与该诉求天然一致。
