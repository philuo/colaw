# Agent Note：stable 应用以「分析式最小化 bundle + 单一共享模块平面」打包

Status: implemented

[English](2026-09-11-stable-app-bundled-packaging.md) | 中文

## 问题

`scripts/pack-stable-app.ts` 此前把 pnpm 生产闭包物化进 `Contents/Resources/app`（pnpm `deploy --prod --legacy`、对 `.pnpm` 全量无差别 hoist、vendor 拷贝、链接重指向），产出 452 MiB，且有三个结构性缺陷：

- **把运行时从不作为代码执行的代码发了进去。** 工作区包按发布树原样到达——dev 形态 `files`/`exports` 指向 `src/` 的包带着全部源码，每个包的 `lib/` 含未被导入的入口，测试与文档只靠一份随例外不断膨胀的剪枝清单移除。
- **体积属于依赖图，不属于组合。** deploy 从 CLI 锚点走 manifest `dependencies`；而应用只 boot 一个组合出的 profile，任何 profile 可能挂载的每个包都为此付了体积。
- **自包含是结构性的，不是被验证的。** 闭包符号链接有「不逃出应用」的审计，但 client-module 解析从 profile 目录经 `~/.dsh/profiles/node_modules` 上溯——由 CLI 而非应用负责 heal——干净机器上的 stable 应用可能 boot 成功而浏览器插件图无处解析。

## 决策

stable 应用**bundle 化，不再 deploy 化**。`pack-stable-app.ts` 用 `dsh-app-boot` 自己的组合逻辑合成被发布 profile 实际挂载的条目清单（web 模板 bundle + Electrobun overlay），然后：

1. **按 import 走查做闭包分析，不走 manifest。** 种子为组合条目名、两个 bundle 包、宿主入口文件。每个被扫描文件贡献其导入（Bun `Transpiler.scanImports`，外加对 `require.resolve('…')` 字面量与 `new URL('./…', import.meta.url)` worker 引用的文本检测——它们不出现在任何导入表里）。没有包到达它，它就不进包；web profile 闭包 262 个包，对照 deploy 的全图闭包。
2. **每个包入口点一个最小化 ESM bundle**（`Bun.build`、摇树、`minify: true`），**所有跨包裸导入一律 external**，产出到扁平的 `Resources/app/node_modules` 树（生成 manifest + bundle 代码）。loader 的动态 `import(name)` 从宿主 bundle 按普通上溯穿过该树解析——这正是 cordis `Symbol` 键要求的单实例保证（2026-09-09 的双模块平面事故就是此处必须防住的失败模式）。
3. **替换 Electrobun 构建的全内联 dev main**：宿主 bundle 按同一 external 平面重建，宿主代码与插件代码共享同一份 cordis 及其余全部库。Electrobun SDK 以 `electrobun` 包名从 Hutch devkit 解析并随包。
4. **运行时数据随代码发布：** 每个包的非代码发布文件（bundle 的 `cordis.patch.yml`、`presets/`、`assets/`、浏览器 `lib/client.js` bundle——做最小化、web 前端 `dist/`、仅 darwin-arm64 的原生 `bin/*.node`），外加生成的 `install/package.json` 锚点，其扁平依赖清单点名每个发布包。
5. **宿主在 bundled 启动时 heal 模块 fallback**（以应用内锚点调 `healProfilesModuleFallback`），client-module 解析与树外插件随之自包含；dev 与源码运行保持 checkout 平面。
6. **stable 拷贝抹掉 dev 标记**——`version.json` 通道、`build.json` 环境、`Colaw-dev` 包名改为 `stable`/`Colaw`，Electrobun SDK 的 install-root 名不再授权构建机上启动仓库 dev watcher。
7. **审计把门：** `Resources/app` 下零符号链接、零 TypeScript/sourcemap/元数据文件，且每个发布 bundle 的每个裸导入必须在应用内可解析（仓库安装本身解析不到的 specifier——sharp 的跨平台原生件——列为未发布可选项而非失败）。

### 分析必须自行掌握的解析规则

- **手工 `node_modules` 走查，绝不用 Bun 解析器。** Bun 对所有解析形态施加 tsconfig `paths`（`resolveSync`、`createRequire().resolve` 皆然），会把分析悄悄翻到 src 平面；打包器自己实现 Node 的父级走查，覆盖 `exports` 的精确键、通配键与无 exports 子路径。**无扩展的相对 require**（`require('./x')` 指向 `x.js`）按 Node 的 CJS 规则解析——漏掉这一个探测会在入口从未点名的 npm 包处静默切断依赖链。
- **数据声明的 loader 行进入闭包。** 预设组合是 import 图看不见的 YAML 条目清单；点名未发布插件的预设会在发现处行校验失败（「标准模式 加载失败」症状），发布后则在会话域按名挂载。每个闭包包已发布的 YAML 都按 `name: '@scope/pkg'` 行扫描，点名的包作为种子，迭代至不动点。**代码内的字符串字面量名与之同列**：directory-picker-auto 的 `BACKEND_PACKAGES` 表这类运行时按名挂载，任何 import 或 YAML 行都不点名，因此已扫代码中每个 `@deepseek-ai/*` 字面量同样作为种子。
- **发布包的声明导出面随包发布。** 约定在运行时按名解析子路径：typert-loader 发现 `./typert` 类型图，并对缺该导出的包**静默跳过**——类型图留空且无任何诊断。非浏览器包的每个非通配代码导出目标各自成为 unit。声明 `dsh.client` 的包除外——其 node 面没有运行时消费者，为其播种会把浏览器专属树（shiki 语言、katex、pdf worker）拉进应用。**恒等通配**（`'./api/*': './api/*'`）不得与精确键并存输出：Bun 先匹配通配、把它们的 specifier 解析到无扩展路径——删掉通配让精确键胜出，而精确键本身必须是 `'./sub/path'` 而非 `'.sub/path'`。
- **CJS 包原样随包。** 把 CJS 入口 bundle 成 ESM 会丢 named exports（Bun 的输出只带 `default`），破坏一切 `import { x } from 'cjs-pkg'`；给生成 manifest 盖 `type: module` 会把其文件错标为 ESM。CJS 包整包拷贝（其全部变体树——full/light、惰性 util——拉入入口链从未点名的依赖，因此闭包扫描每个已发布文件的 require），**源 manifest 原样保留**（sharp 的 libvips 探测读平台包的 `config` 块），并跳过会丢掉其运行时文件的 src 目录裁剪。
- **verbatim 就是真的原样。** 经字符串 URL 与条件分发到达的文件（zod 的 v3/v4 分发、protobufjs 的惰性 util）按字节随包；重新 bundle 它们——尤其是 CJS 过 ESM 通道——破坏的恰是 Node 对原始文件的互操作。
- **版本冲突内联进导入者。** 名字的首个解析拥有根平面；某包文件解析到别的版本（negotiator 0.6/1.1）时，该 specifier 从*它的* bundle 的 externals 中移除，`Bun.build` 内联其自身解析到的版本。把落选版本嵌套到各导入者之下的方案被否决——为 pnpm 纪律本就罕见的情形引入树的复杂度不值。
- **安装里缺失的可选依赖保持缺失。** sharp 的 wasm32 回退与全部非 darwin-arm64 原生件 external 且不发布；运行时遇到与今天相同的解析失败。经模板字面量寻址的平台限定包（`@vscode/ripgrep-${platform}-${arch}`、flock 绑定）作为数据包播种，其二进制保持可执行位。
- **自包含性只在检出之外证明，绝不在检出之内。** 构建在仓库内的 .app 会经自身路径向上爬进仓库的 `node_modules`，于是带伤的包也能 boot 成功（藏起包内一个包、boot 依旧成功即为实证）。验收启动把 .app 拷出树外，用临时 `HOME`、纯系统 `PATH`、空环境运行；vendored loader 的逐条目 apply-failure 日志把折叠的「plugin tree failed」还原成那个失败的名字。

## 被否决的备选

- **保留 deploy 闭包、更狠剪枝。** 否决：剪枝是追赶例外的白名单；dev exports 指向 `src/` 时源码拿不掉；体积下限始终属于 manifest 图而非组合。
- **所有插件打进一个巨型 bundle。** 否决：Electrobun 的 dev main 是全内联的，插件巨包会在宿主那份 cordis 旁边再放一份——正是双平面事故记录下的 Symbol 分裂失败。
- **为版本冲突做嵌套 node_modules 产出。** 否决：正确但成倍增加树形态与 manifest 记账，而锁文件纪律本就让该情形罕见；把冲突 specifier 内联进唯一解析到它的导入者，是局部的、审计可见的。

## 后果

- stable 应用实测 **108 MiB**（壳 66.6 + bundle/数据 41.4），对照 deploy 的 452 MiB；`Resources/app` 下零符号链接、零 TypeScript、零 sourcemap、零 README。
- 按包摇树是真实但按包为界的：每个包按实际被导入的入口点各出一个 unit，未被引用的 `lib/` 入口被丢弃。同包兄弟 unit 之间可能复制内部模块；web profile 今天不存在这样的子路径对。
- 按字符串 URL 发布的代码文件（worker 入口）在 `Bun.build` 接受时最小化，不接受时按字节复制。
- 全链（`tsc` host 面、tsdown host/client 面、Vite、Electrobun 构建、分析、产出、审计）由 `pnpm run build:app:stable` 完整走通；冒烟验收为全新 `DSH_HOME` 启动至 `dsh core booted`，`__DSH_BOOT__` 有内容且 client bundle 批次可服务。
- 浏览器 client bundle 在打包步骤中最小化；client 面构建本身不变，dev 与快照流程不受影响。
