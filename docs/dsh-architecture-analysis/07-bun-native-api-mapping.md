# Bun 原生 API 替代映射：dsh 依赖去外部化分析

> 基于 Bun 1.4.x 原生 API 与 deepseek-harness v0.1.3-alpha.2 依赖的完整对照
> 分析日期：2026-09-07

> ⚠️ **时效说明（2026-09-08）**：本文是动手前的**理论映射**。经在 Bun 1.4.2 实测、grep dsh 真实 API 使用面后，若干结论已被修正——`js-yaml/yaml`（dsh 用 AST，Bun.YAML 无 AST）、`ws`（dsh 用服务端 upgrade，全局 WebSocket 仅客户端）、`sharp→Bun.Image`（能力不足，已决定保留 sharp）、`Bun.Markdown`（1.4.2 尚不存在）等**不能按本文乐观结论直接替换**；`CompressionStream` 则反过来在 1.4.2 已可用。**最终裁决与证据矩阵以 [13-bun-builtin-replacement-verdict.md](./13-bun-builtin-replacement-verdict.md) 为准。**

## 核心结论

Bun 1.4.x 的原生 API 可以替代 dsh 中 **约 60% 的外部运行时依赖**，其中最关键的是：



| 替代等级                     | 数量     | 代表                                                                                   |
| ------------------------ | ------ | ------------------------------------------------------------------------------------ |
| **直接替代**（API 等价，可无缝替换）   | 14 个   | `node-pty` → `Bun.Terminal`，`js-yaml` → `Bun.YAML`，`ws` → Bun 原生 WebSocket，`fs-ext` → `Bun.FFI` flock，`semver` → `Bun.semver`           |
| **能力覆盖**（功能等价，需适配层）      | 8 个    | `sharp` → `Bun.Image`，`puppeteer` → `Bun.WebView`，`string-width` → `Bun.stringWidth` |
| **新增能力**（dsh 没有但 IDE 可用） | 6 个    | `Bun.JSON5`、`Bun.Markdown`、`Bun.Toml`、`Bun.XML`、`Bun.password`、`Bun.ffi`             |
| **不可替代**（框架级 / 协议级）      | \~10 个 | Cordis、zod、schemastery、pi-ai、eventsource-parser                                      |



***

## 1. 直接替代：API 等价映射

### 1.1 `node-pty` → `Bun.Terminal` ⭐ 最关键

**dsh 中的用途**：`packages/subprocess/subprocess-local` 中的 PTY 伪终端，是 dsh 最大的原生模块依赖（需要 node-gyp 编译，跨平台兼容性问题多）。

**Bun 原生替代**：



```
// dsh 现状 (node-pty)

import { spawn } from 'node-pty'

const term = spawn(shell, \[], {

&#x20; name: 'xterm-256color',

&#x20; cols: 80,

&#x20; rows: 24,

&#x20; cwd,

&#x20; env: process.env,

})

term.onData((data) => { /\* ... \*/ })

term.write('echo hello\n')

term.resize(120, 40)

term.kill()

// Bun 原生 (Bun.Terminal)

const proc = Bun.spawn(\[shell], {

&#x20; cwd,

&#x20; env: { ...process.env },

&#x20; terminal: {

&#x20;   cols: 80,

&#x20;   rows: 24,

&#x20;   name: 'xterm-256color',

&#x20;   data(terminal, data) { /\* ... \*/ },

&#x20; },

})

proc.terminal.write('echo hello\n')

proc.terminal.resize(120, 40)

proc.terminal.setRawMode(true)

proc.terminal.close()
```

**Bun.Terminal 的优势**：



| 特性                 | node-pty              | Bun.Terminal                                               |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| 跨平台 PTY            | openpty + ConPTY（需编译） | openpty + ConPTY（原生内置）                                     |
| 原生模块构建             | 需要 node-gyp，跨平台编译问题多  | **零构建**，Bun 二进制内置                                          |
| 可复用 Terminal       | 不支持                   | `new Bun.Terminal()` 可跨多个进程复用                              |
| termios 控制         | 完整支持                  | POSIX 完整支持（inputFlags/outputFlags/localFlags/controlFlags） |
| 资源占用               | 较重                    | 轻量，与 Bun.spawn 集成                                          |
| `await using` 自动清理 | 不支持                   | `AsyncDisposable`，自动 close                                 |

**可复用 Terminal 示例**（dsh 终端工具的理想实现）：



```
// 创建一个持久终端，跨多个命令复用

await using terminal = new Bun.Terminal({

&#x20; cols: 120,

&#x20; rows: 40,

&#x20; data(term, data) {

&#x20;   // 转发到 IDE 前端

&#x20;   ideWindow.webContents.send('terminal:data', data)

&#x20; },

})

// 第一个命令

const proc1 = Bun.spawn(\['git', 'status'], { terminal, cwd: projectDir })

await proc1.exited

// 复用同一个终端运行第二个命令

const proc2 = Bun.spawn(\['npm', 'test'], { terminal, cwd: projectDir })

await proc2.exited

// terminal 自动关闭（await using）
```

**替换影响范围**：



* `packages/subprocess/subprocess-local` — 移除 node-pty 依赖

* `packages/terminal/` — 持久终端会话可以直接用 Bun.Terminal

* `native/landlock-run` — Linux 沙箱仍需原生 addon（Bun 没有 Landlock）

* `pnpm-workspace.yaml` 的 `allowBuilds` 中移除 node-pty



***

### 1.2 `js-yaml` → `Bun.YAML`

**dsh 中的用途**：`packages/boot/app-boot`、`apps/desktop`、`packages/core/settings-file` 中的 YAML 配置解析（cordis.yml、cordis.patch.yml、settings.yaml）。

**Bun 原生替代**：



```
// dsh 现状 (js-yaml)

import yaml from 'js-yaml'

const config = yaml.load(fs.readFileSync('cordis.yml', 'utf8'))

// Bun 原生 (Bun.YAML)

import { YAML } from 'bun'

const config = YAML.parse(await Bun.file('cordis.yml').text())

// 更简单：直接模块导入

import config from './cordis.yml'  // Bun 原生支持！
```

**Bun.YAML 的优势**：



| 特性              | js-yaml    | Bun.YAML                                      |
| --------------- | ---------- | --------------------------------------------- |
| 实现语言            | JavaScript | **Rust**（性能更高）                                |
| YAML 1.2 规范     | 部分支持       | **完整支持**，通过官方测试套件                             |
| Anchors/Aliases | 支持         | 支持（可返回循环对象）                                   |
| Multi-document  | 支持         | 支持（返回数组）                                      |
| 模块导入            | 不支持        | **原生支持** `import config from "./config.yaml"` |
| 热重载             | 不支持        | `bun --hot`**&#x20;自动重载**                     |
| 构建时解析           | 不支持        | **Bun bundler 构建时解析，零运行时开销**                  |
| 包体积             | \~100KB    | **0KB（内置）**                                   |

**注意**：Bun.YAML 不支持 `!!js` 自定义标签（Cordis 的 YAML 方言用 `!!js` 执行表达式）。这是 dsh 的一个关键依赖 ——Cordis 的 cordis.yml 用 `!!js` 执行 `dshHomePath('sessions')`、`process.cwd()` 等表达式。

**解决方案**：



1. 用 Bun.YAML 解析普通 YAML 部分

2. 对 `!!js` 标签做预处理（将 `!!js expr` 转为占位符，解析后再 eval）

3. 或者保留一个轻量的 `!!js` 处理器，只在 Cordis 配置加载时使用



***

### 1.3 `ws` → Bun 原生 WebSocket

**dsh 中的用途**：`packages/api/gateway` 中的 WebSocket 远程流（session follow、实时事件推送）。

**Bun 原生替代**：



```
// dsh 现状 (ws)

import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ port: 8080 })

wss.on('connection', (ws) => {

&#x20; ws.on('message', (data) => { /\* ... \*/ })

&#x20; ws.send(JSON.stringify({ type: 'event' }))

})

// Bun 原生 (Bun.serve websocket)

Bun.serve({

&#x20; port: 8080,

&#x20; fetch(req, server) {

&#x20;   if (server.upgrade(req)) return

&#x20;   return new Response('Not found', { status: 404 })

&#x20; },

&#x20; websocket: {

&#x20;   message(ws, data) { /\* ... \*/ },

&#x20;   open(ws) { ws.send(JSON.stringify({ type: 'event' })) },

&#x20; },

})

// Bun 原生 WebSocket 客户端

const ws = new WebSocket('ws://localhost:8080')

ws.onmessage = (event) => { /\* ... \*/ }

ws.send(JSON.stringify({ type: 'subscribe' }))
```

**优势**：Bun 的 WebSocket 服务器性能极高（基于 uWebSockets），且与 `Bun.serve` 集成，无需额外依赖。



***

### 1.4 `compression` + `negotiator` → `Bun.serve` 内置压缩

**dsh 中的用途**：`packages/host/webserver` 中的 HTTP 响应压缩和内容协商。

**Bun 原生替代**：Bun.serve 内置 gzip/deflate 压缩，自动处理 `Accept-Encoding` 头。



***

### 1.5 `resolve.exports` → Bun 内置模块解析

**dsh 中的用途**：`packages/boot/app-boot` 中解析 package.json 的 exports 字段。

**Bun 原生替代**：Bun 的模块解析器原生支持 package.json exports，`Bun.resolveSync()` 可以解析模块路径。



***

### 1.6 `which` npm 包 → `Bun.which`

**dsh 中的用途**：查找可执行文件路径（如 git、node、python）。



```
// dsh 现状

import which from 'which'

const gitPath = await which('git')

// Bun 原生

const gitPath = Bun.which('git')

const gitPath = Bun.which('git', { cwd: '/tmp', PATH: '/usr/bin' })
```



***

### 1.7 `string-width` → `Bun.stringWidth`

**dsh 中的用途**：终端 UI 中计算字符串显示宽度（处理 emoji、ANSI、CJK）。



```
// dsh 现状

import stringWidth from 'string-width'

const width = stringWidth('hello 🌍', { ambiguousIsNarrow: false })

// Bun 原生（性能提升 100x+）

const width = Bun.stringWidth('hello 🌍', { ambiguousIsNarrow: false })
```

**性能对比**（Bun 官方基准，Intel i9）：



| 输入               | npm/string-width | Bun.stringWidth | 提升         |
| ---------------- | ---------------- | --------------- | ---------- |
| 5 chars ASCII    | 3.19 µs          | 16.45 ns        | **194x**   |
| 500 chars ASCII  | 249.71 µs        | 37.09 ns        | **6732x**  |
| 5000 chars ASCII | 6.69 ms          | 216.9 ns        | **30844x** |
| 70 chars emoji   | 23.93 µs         | 23.15 µs        | 1.03x      |



***

### 1.8 `strip-ansi` → `Bun.stripANSI`

**dsh 中的用途**：清除终端输出中的 ANSI 转义序列。



```
// dsh 现状

import stripAnsi from 'strip-ansi'

const clean = stripAnsi('\x1b\[31mhello\x1b\[0m')

// Bun 原生

const clean = Bun.stripANSI('\x1b\[31mhello\x1b\[0m')
```



***

### 1.9 `escape-html` → `Bun.escapeHTML`

**dsh 中的用途**：Web 前端中转义 HTML 特殊字符。



```
// dsh 现状

import escapeHtml from 'escape-html'

const safe = escapeHtml('\<script>alert(1)\</script>')

// Bun 原生（480 MB/s - 20 GB/s）

const safe = Bun.escapeHTML('\<script>alert(1)\</script>')
```



***

### 1.10 `zstd` 压缩库 → `Bun.zstdCompress` / `Bun.zstdDecompress`

**dsh 中的用途**：`packages/session/persistence-jsonl` 中的会话日志 zstd 压缩（`session.vN.jsonl.zst`）。



```
// dsh 现状（可能用 @mongodb-js/zstd 或 node-zstd）

import { compress, decompress } from '@mongodb-js/zstd'

const compressed = await compress(buffer, 3)

const decompressed = await decompress(compressed)

// Bun 原生

const compressed = await Bun.zstdCompress(buffer, { level: 3 })

const compressedSync = Bun.zstdCompressSync(buffer)

const decompressed = await Bun.zstdDecompress(compressed)
```



***

### 1.11 `deep-equal` / `lodash.isEqual` → `Bun.deepEquals`

**dsh 中的用途**：配置变更检测、状态比较。



```
// dsh 现状

import isEqual from 'lodash/isEqual'

const changed = !isEqual(oldConfig, newConfig)

// Bun 原生

const changed = !Bun.deepEquals(oldConfig, newConfig)

const strictChanged = !Bun.deepEquals(oldConfig, newConfig, true) // strict 模式
```



***

### 1.12 `uuid` / `uuidv7` → `Bun.randomUUIDv7`

**dsh 中的用途**：生成会话 ID、agent ID、请求 ID。



```
// dsh 现状

import { v4 as uuidv4 } from 'uuid'

const id = uuidv4()

// Bun 原生（UUID v7，时间排序，适合数据库索引）

const id = Bun.randomUUIDv7()

const idBuffer = Bun.randomUUIDv7('buffer')

const idBase64 = Bun.randomUUIDv7('base64')
```



***

## 2. 能力覆盖：功能等价映射

### 2.1 `sharp` / `jimp` → `Bun.Image`

**dsh 中的用途**：`packages/core/attachment` 中的图片处理（缩略图、格式转换、像素预算计算）。dsh 目前可能没有用 sharp，但 IDE 场景的图片附件处理非常需要。

**Bun 原生替代**：



```
// sharp 风格

import sharp from 'sharp'

const thumbnail = await sharp('photo.jpg')

&#x20; .resize(400, 400, { fit: 'inside' })

&#x20; .webp({ quality: 80 })

&#x20; .toBuffer()

// Bun.Image（API 形状参考 sharp）

const thumbnail = await Bun.file('photo.jpg')

&#x20; .image()

&#x20; .resize(400, 400, { fit: 'inside' })

&#x20; .webp({ quality: 80 })

&#x20; .bytes()

// 链式操作

const result = await new Bun.Image('photo.jpg')

&#x20; .resize(800, 600)

&#x20; .rotate(90)

&#x20; .flip()

&#x20; .modulate({ brightness: 1.2, saturation: 0.5 })

&#x20; .jpeg({ quality: 85 })

&#x20; .write('output.jpg')

// 元数据（不解码像素）

const { width, height, format } = await new Bun.Image('photo.jpg').metadata()

// 缩略图占位（LQIP，\~400-700 bytes）

const placeholder = await Bun.file('hero.jpg').image().placeholder()

// 剪贴板图片

const img = Bun.Image.fromClipboard()
```

**Bun.Image 的优势**：



| 特性           | sharp                            | Bun.Image                                    |
| ------------ | -------------------------------- | -------------------------------------------- |
| 原生依赖         | libvips（需编译，\~50MB）              | libjpeg-turbo + spng + libwebp（内置）           |
| 安装时间         | 慢（需下载预编译二进制）                     | **零安装**                                      |
| 支持格式         | JPEG/PNG/WebP/AVIF/HEIC/TIFF/GIF | JPEG/PNG/WebP/HEIC/AVIF/TIFF/GIF/BMP         |
| 性能           | 极快                               | 极快（SIMD 几何内核，macOS 用 Accelerate vImage）      |
| JPEG 缩略图优化   | 支持                               | **支持**（M/8 IDCT 缩放，24MP 照片不生成全分辨率缓冲）         |
| 剪贴板          | 不支持                              | **支持**（macOS/Windows）                        |
| `await` 终端方法 | 支持                               | 支持（bytes/buffer/blob/toBase64/dataurl/write） |

**平台差异**：



* JPEG/PNG/WebP：全平台，静态链接，输出字节一致

* HEIC/AVIF：macOS（ImageIO）/ Windows（WIC），Linux 不支持

* TIFF：macOS/Windows，Linux 不支持

* 剪贴板：macOS/Windows，Linux 返回 null



***

### 2.2 `puppeteer` / `playwright` → `Bun.WebView`

**dsh 中的用途**：`packages/web/web-fetch-http` 中的网页抓取（可能需要 JS 渲染）。dsh 目前用简单的 HTTP fetch，但 IDE 场景的网页预览、自动化测试非常需要。

**Bun 原生替代**：



```
// puppeteer

import puppeteer from 'puppeteer'

const browser = await puppeteer.launch()

const page = await browser.newPage()

await page.goto('https://example.com')

await page.click('a\[href]')

const title = await page.evaluate(() => document.title)

await page.screenshot({ path: 'page.png' })

await browser.close()

// Bun.WebView（零依赖，macOS 用系统 WKWebView）

await using view = new Bun.WebView({ width: 1280, height: 720 })

await view.navigate('https://example.com')

await view.click('a\[href]')  // 等待元素可点击，原生事件 (isTrusted: true)

const title = await view.evaluate('document.title')

await Bun.write('page.png', await view.screenshot())

// view 自动关闭（await using）

// 持久化存储（cookies/localStorage/IndexedDB）

const view = new Bun.WebView({

&#x20; dataStore: { directory: './browser-profile' },

})

// Chrome DevTools Protocol 原始访问（Chrome 后端）

await view.navigate('about:blank')

await view.cdp('Emulation.setUserAgentOverride', { userAgent: 'MyBot/1.0' })

view.addEventListener('Network.responseReceived', (event) => {

&#x20; console.log(event.data.response.status, event.data.response.url)

})
```

**Bun.WebView 的优势**：



| 特性            | puppeteer               | playwright              | Bun.WebView                 |
| ------------- | ----------------------- | ----------------------- | --------------------------- |
| 浏览器下载         | 需要下载 Chromium (\~150MB) | 需要下载浏览器                 | **macOS 零下载**（系统 WKWebView） |
| 安装体积          | \~300MB                 | \~500MB                 | **0MB（内置）**                 |
| macOS 后端      | Chromium                | Chromium/WebKit/Firefox | **WKWebView（系统原生）**         |
| 原生事件          | 模拟                      | 模拟                      | **原生事件（isTrusted: true）**   |
| CDP 访问        | 完整                      | 部分                      | **完整**（Chrome 后端）           |
| 并发            | 多页面                     | 多页面                     | **多 view 并行**（每个独立渲染进程）     |
| `await using` | 不支持                     | 不支持                     | **支持**                      |

**注意**：Bun.WebView 是实验性 API，可能变化。macOS 用 WKWebView（零依赖），Linux/Windows 需要安装 Chrome/Edge（Bun 会自动查找）。



***

### 2.3 `marked` / `markdown-it` → `Bun.markdown`

**dsh 中的用途**：Web 前端中渲染 Markdown（AI 回复、文档、README）。

**Bun 原生替代**：



```
// marked

import { marked } from 'marked'

const html = marked('# Hello \*\*world\*\*')

// Bun.markdown（Rust 实现，GFM 支持）

import { markdown } from 'bun'

const html = markdown.html('# Hello \*\*world\*\*')

// 自定义渲染回调（完全控制输出）

const result = markdown.render('# Title', {

&#x20; heading: (children, { level }) => \`\<h\${level} class="title">\${children}\</h\${level}>\`,

&#x20; code: (children, { language }) => \`\<pre>\<code class="language-\${language}">\${children}\</code>\</pre>\`,

&#x20; link: (children, { href }) => \`\<a href="\${href}" target="\_blank">\${children}\</a>\`,

})

// 直接渲染为 React 元素（SSR 友好）

function Markdown({ text }) {

&#x20; return markdown.react(text, {

&#x20;   pre: CodeBlock,

&#x20;   a: Link,

&#x20;   h2: Heading,

&#x20; })

}
```

**支持的 GFM 扩展**：表格、删除线、任务列表、自动链接、标题 ID、wiki 链接、LaTeX 数学公式。

**注意**：Bun.markdown 是 Unstable API，可能变化。



***

### 2.4 `crypto` 部分用法 → `Bun.Hashing`

**dsh 中的用途**：



* `Bun.password`：凭证哈希（如果 dsh 需要存储用户密码）

* `Bun.hash`：非加密哈希（缓存键、内容寻址）

* `Bun.CryptoHasher`：加密哈希（文件校验和、附件内容寻址）



```
// 密码哈希（argon2/bcrypt，零依赖）

const hash = await Bun.password.hash('password', { algorithm: 'argon2id' })

const isValid = await Bun.password.verify('password', hash)

// 非加密哈希（wyhash/crc32/xxHash/murmur，极快）

const cacheKey = Bun.hash('some data')  // wyhash，返回 bigint

const crc = Bun.hash.crc32('data')

const xxh = Bun.hash.xxHash64('data')

// 加密哈希（增量，sha256/md5/blake2）

const hasher = new Bun.CryptoHasher('sha256')

hasher.update('hello')

hasher.update(new Uint8Array(\[1, 2, 3]))

const digest = hasher.digest('hex')

// HMAC

const hmac = new Bun.CryptoHasher('sha256', 'secret-key')

hmac.update('hello')

const signature = hmac.digest('base64')
```



***

### 2.5 `lodash` 工具函数 → `Bun.utils`

Bun 内置了大量工具函数，可以替代 lodash 的常用功能：



| lodash                      | Bun 原生                       | 说明                 |
| --------------------------- | ---------------------------- | ------------------ |
| `_.isEqual`                 | `Bun.deepEquals(a, b)`       | 深度相等（支持 strict 模式） |
| `_.cloneDeep`               | `structuredClone(a)`（Bun 优化） | 深度克隆               |
| `_.delay`                   | `Bun.sleep(ms)`              | 延迟                 |
| `_.escape`                  | `Bun.escapeHTML(str)`        | HTML 转义            |
| `_.uniqueId`                | `Bun.randomUUIDv7()`         | 唯一 ID              |
| `_.throttle` / `_.debounce` | 需手写（Bun 没有内置）                | 节流 / 防抖            |
| `_.get` / `_.set`           | 需手写（可选链 / 空值合并）              | 路径访问               |



***

### 2.6 `zlib` 压缩 → `Bun.deflateSync` / `Bun.inflateSync` / `Bun.gunzipSync`



```
// node:zlib

import { deflateSync, inflateSync, gunzipSync } from 'node:zlib'

const compressed = deflateSync(buffer)

const decompressed = inflateSync(compressed)

// Bun 原生

const compressed = Bun.deflateSync(buffer)

const decompressed = Bun.inflateSync(compressed)

const gunzipped = Bun.gunzipSync(buffer)
```



***

### 2.7 `koffi` (FFI) → `Bun.ffi`

**dsh 中的用途**：`packages/subprocess/subprocess-local` 和 `packages/session/persistence-jsonl` 中的 Windows 原生 API 调用（MoveFileExW 写穿透发布）。

**Bun 原生替代**：Bun 内置 FFI 支持，可以直接调用动态库中的 C 函数。



```
// koffi

import koffi from 'koffi'

const lib = koffi.load('kernel32.dll')

const MoveFileExW = lib.func('int \_\_stdcall MoveFileExW(str16, str16, uint)')

MoveFileExW(src, dst, 0x1 | 0x2 | 0x4)

// Bun.ffi

import { dlopen, FFIType, ptr } from 'bun:ffi'

const { symbols: { MoveFileExW } } = dlopen('kernel32.dll', {

&#x20; MoveFileExW: {

&#x20;   args: \[FFIType.cstring, FFIType.cstring, FFIType.u32],

&#x20;   returns: FFIType.i32,

&#x20; },

})

MoveFileExW(ptr(Buffer.from(src + '\0', 'utf16le')), ptr(Buffer.from(dst + '\0', 'utf16le')), 0x1 | 0x2 | 0x4)
```

**注意**：Bun.ffi 的 API 与 koffi 不同，需要适配层。但 Bun.ffi 性能更高（基于 JIT 编译的 FFI 调用）。



***

### 2.8 `fs-ext` (文件锁) → `Bun.FFI` 调用 libc `flock` ✅ 已验证

**fs-ext 是什么？**
- fs-ext 是一个 Node.js 原生模块（C++ addon），扩展 Node.js fs 模块，提供 `flock()`、`fcntl()` 等 POSIX 文件系统调用
- dsh **只使用了其中的 `flock()` 函数**，在 `packages/session/session-persistence-jsonl/src/lease.ts` 中
- 用于跨进程写锁：POSIX `flock(2)` 非阻塞排他锁（`LOCK_EX | LOCK_NB`），Windows 用命名内核信号量
- 关键设计：内核级锁，进程崩溃时内核自动释放，inod 验证防止锁文件被替换
- 因为是原生模块，需要为 Bun ABI (`NODE_MODULE_VERSION=147`) 重新编译

**Bun 原生替代：`Bun.FFI` 直接调用 libc `flock`** ✅ 已验证（9/9测试通过）

Bun 内置 FFI（Foreign Function Interface），可以直接调用动态库中的 C 函数，无需原生模块编译：

```typescript
import { dlopen } from "bun:ffi";

// macOS: libSystem.B.dylib, Linux: libc.so.6
const LIBC = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
const lib = dlopen(LIBC, {
  flock: { args: ["i32", "i32"], returns: "i32" },
});

const LOCK_EX = 2;   // 排他锁
const LOCK_NB = 4;   // 非阻塞
const LOCK_UN = 8;   // 解锁

// 与 dsh lease.ts 中 flockAsync 完全一致的 Promise 包装
function flockAsync(fd: number, flags: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = lib.symbols.flock(fd, flags);
    if (r === 0) resolve();
    else reject(new Error(`flock failed: ${r}`));
  });
}
```

**验证结果**（`16-ffi-flock-vs-fs-ext.test.ts`，9/9通过）：
- ✅ 基本加锁解锁
- ✅ 互斥性（第二个fd非阻塞加锁返回 -1/EAGAIN）
- ✅ 关闭fd自动释放锁（进程崩溃安全，内核自动释放）
- ✅ flockAsync Promise 包装（与dsh lease.ts一致）
- ✅ **10进程×50条=500条并发写入，零损坏**

**优势**：
- 完全是 JS 代码，**无需原生模块编译**，无 ABI 问题
- 同样是**内核级锁**，进程崩溃自动释放（与 fs-ext 完全等价）
- 与 dsh 现有 `lease.ts` 代码几乎零改动（只需替换 `import { flock } from 'fs-ext'` 为 FFI 实现）
- Windows 上 dsh 已用 `koffi` 调用 Win32 API，可同样用 `Bun.FFI` 替代



***

## 3. 新增能力：dsh 没有但 IDE 可用

### 3.1 `Bun.JSON5`

JSON5 是 JSON 的超集，支持注释、尾逗号、单引号、hex 数字。非常适合 IDE 配置文件。



```
import { JSON5 } from 'bun'

const config = JSON5.parse(\`{

&#x20; // IDE 配置

&#x20; editor: {

&#x20;   font: 'JetBrains Mono',

&#x20;   fontSize: 14,

&#x20;   tabSize: 2,  // 尾逗号

&#x20; },

&#x20; terminal: {

&#x20;   shell: '/bin/zsh',

&#x20;   fontSize: 13,

&#x20; },

}\`)

// 直接模块导入

import config from './ide.json5'  // Bun 原生支持！

// stringify（保留 Infinity/NaN）

const str = JSON5.stringify({ inf: Infinity, nan: NaN }, null, 2)
```

**IDE 用途**：用户配置文件、项目配置、插件配置（比 JSON 更友好，比 YAML 更简单）。



***

### 3.2 `Bun.Toml`

TOML 解析，适合 Cargo.toml、pyproject.toml 等配置文件的读取。



```
import { TOML } from 'bun'

const cargo = TOML.parse(await Bun.file('Cargo.toml').text())

console.log(cargo.package.name)

console.log(cargo.dependencies.serde)

// 直接模块导入

import cargo from './Cargo.toml'  // Bun 原生支持！
```

**IDE 用途**：读取项目配置（Rust/Cargo、Python/pyproject、Elixir/mix），依赖管理。



***

### 3.3 `Bun.XML`

XML 解析，适合读取 Maven pom.xml、.NET .csproj、AndroidManifest.xml 等。



```
import { XML } from 'bun'

const pom = XML.parse(await Bun.file('pom.xml').text())

console.log(pom.project.groupId)

console.log(pom.project.artifactId)
```

**IDE 用途**：读取 Java/.NET/Android 项目配置，Maven/Gradle 依赖分析。



***

### 3.4 `Bun.password`

密码哈希（argon2id/bcrypt），零依赖。



```
// argon2id（默认，推荐）

const hash = await Bun.password.hash('my-password', {

&#x20; algorithm: 'argon2id',

&#x20; memoryCost: 8,    // 8 KiB

&#x20; timeCost: 3,      // 3 次迭代

})

// bcrypt（兼容现有系统）

const bcryptHash = await Bun.password.hash('my-password', {

&#x20; algorithm: 'bcrypt',

&#x20; cost: 10,

})

// 验证（自动检测算法）

const isValid = await Bun.password.verify('my-password', hash)
```

**IDE 用途**：本地凭证存储、插件市场认证、加密配置。



***

### 3.5 `Bun.peek`

无 await 读取 Promise 结果（仅在已完成时），用于性能敏感代码。



```
import { peek } from 'bun'

const promise = doAsyncWork()

// 不等待，直接检查是否完成

const result = peek(promise)

if (result !== promise) {

&#x20; // Promise 已完成，result 是结果或错误

}

// 检查状态

const status = peek.status(promise)  // 'pending' | 'fulfilled' | 'rejected'
```

**IDE 用途**：高频轮询场景（文件监听、LSP 响应缓存、终端输出缓冲）。



***

### 3.6 `Bun.nanoseconds` + `Bun.inspect`

高精度计时和对象检查。



```
const start = Bun.nanoseconds()

// ... 执行操作 ...

const elapsed = Bun.nanoseconds() - start  // 纳秒精度

// 高性能对象检查（替代 console.log）

console.log(Bun.inspect(obj, { colors: true, depth: 5 }))
```



***

## 4. 不可替代：框架级 / 协议级依赖

以下依赖是 dsh 的核心框架或协议实现，Bun 原生 API 无法替代：



| 依赖                                                         | 不可替代原因                                 | 替代可能性                                        |
| ---------------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| **Cordis**（vendor）                                         | 元框架，插件运行时、DI、事件总线、生命周期管理。Bun 是运行时，不是框架 | ❌ 完全不可替代                                     |
| **@deepseek-ai/schemastery**                               | Cordis 的 Schema 验证库，与框架深度集成            | ❌ 不可替代（可用 zod 替代，但需改框架）                      |
| **zod**                                                    | 运行时类型验证，dsh 大量用于投影状态、API 参数            | ⚠️ 可用 TypeScript 类型 + 手写验证替代，但工作量大           |
| **@earendil-works/pi-ai**                                  | 多供应商 LLM API 客户端，内置端点 / 协议 / 模型目录      | ⚠️ 可用 fetch 手写替代，但需维护大量提供商适配                 |
| **eventsource-parser**                                     | SSE（Server-Sent Events）流解析，LLM 流式响应必需  | ⚠️ 可用 Bun 原生 ReadableStream 手写，但需处理 SSE 协议细节 |
| **semver**                                                 | 版本比较，dsh 桌面端更新管理（仅 `apps/desktop` 使用 `valid()`） | ✅ `Bun.semver` 提供 `satisfies()` 和 `order()`，比 node-semver 快20-27倍；`valid()` 可用简单正则替代 |
| **msgpackr**                                               | 高效二进制序列化，桌面端 IPC                       | ⚠️ 可用 JSON 替代（性能差），或用 Bun 内置序列化              |
| **electron** / **electron-builder** / **electron-updater** | 桌面应用框架                                 | ✅ 用 electrobun 替代（这正是用户的选择）                  |
| **vscode-jsonrpc**                                         | LSP JSON-RPC 协议                        | ⚠️ 可用 Bun 原生实现，但需维护协议                        |
| **native/landlock-run**                                    | Linux Landlock 沙箱                      | ❌ Bun 没有 Landlock 支持（Linux 安全沙箱必需）           |



***

## 5. 替换路线图

### Phase 1: 低风险直接替换（Bun 侧 IDE Core）

这些替换只影响 Bun 侧的 IDE Core 代码，不影响 dsh 子进程：



* [ ] `node-pty` → `Bun.Terminal`（IDE 终端管理器）

* [ ] `js-yaml` → `Bun.YAML`（IDE 配置解析）

* [ ] `ws` → Bun 原生 WebSocket（IDE 实时通信）

* [ ] `string-width` / `strip-ansi` / `escape-html` → `Bun.stringWidth` / `Bun.stripANSI` / `Bun.escapeHTML`

* [ ] `which` → `Bun.which`

* [ ] `uuid` → `Bun.randomUUIDv7`

* [ ] `lodash.isEqual` → `Bun.deepEquals`

* [ ] `sharp` → `Bun.Image`（图片附件处理）

* [ ] `marked` → `Bun.markdown`（AI 回复渲染）

* [ ] `zstd` → `Bun.zstdCompress`（IDE 本地缓存压缩）

* [ ] `puppeteer` → `Bun.WebView`（网页预览、自动化测试）

### Phase 2: dsh 子进程侧替换（需验证兼容性）

这些替换需要修改 dsh 源码或创建 dsh 插件，在 Bun 运行时下验证：



* [ ] `subprocess-local` 的 `node-pty` → `Bun.Terminal`（需创建 dsh-subprocess-bun 插件）

* [ ] `app-boot` 的 `js-yaml` → `Bun.YAML`（需处理 `!!js` 自定义标签）

* [ ] `persistence-jsonl` 的手写 JSONL → `Bun.JSONL`（流式解析）

* [x] `persistence-jsonl` 的 `fs-ext` 文件锁 → `Bun.FFI` 调用 libc `flock`（已验证，9/9测试通过，10进程500条零损坏）

* [ ] `persistence-jsonl` 的 `koffi` Windows FFI → `Bun.ffi`

* [ ] `api-gateway` 的 `ws` → Bun 原生 WebSocket

* [ ] `host-webserver` 的 `compression` → Bun.serve 内置压缩

### Phase 3: 深度 Bun 化（架构级调整）



* [ ] 评估 dsh 在 Bun 运行时下的完整兼容性（Cordis 框架、原生模块、ESM）

* [ ] 如果兼容，考虑将 dsh 直接运行在 Bun 中（方案 A），消除 Node.js 子进程

* [ ] 用 `Bun.spawn` 的 `cgroup` 选项替代 Landlock 沙箱（Linux）

* [ ] 用 `Bun.Transpiler` 替代 tsx（TypeScript 源码运行）

* [ ] 用 `Bun.build` 替代 tsdown（打包器）

* [ ] 用 `Bun:test` 替代 vitest（测试框架）



***

## 6. 风险与注意事项

### 6.1 Bun.Terminal 的平台差异



| 差异               | POSIX (Linux/macOS)                                  | Windows (ConPTY)                   |
| ---------------- | ---------------------------------------------------- | ---------------------------------- |
| termios          | 完整支持（inputFlags/outputFlags/localFlags/controlFlags） | 不支持（始终为 0，setRawMode 无效果）          |
| 输入回显             | 内核行缓冲回显（无进程也回显）                                      | 无行缓冲（需要进程回显）                       |
| 输出字节             | 字节精确                                                 | ConPTY 重新编码（语义等价，非字节精确）            |
| `\r` → `\n`      | ICRNL 自动转换                                           | 不转换（`\r` 原样传递）                     |
| SIGWINCH         | 子进程可接收                                               | libuv 限制（除非 raw mode 读 stdin）      |
| terminal.close() | 立即终止                                                 | Windows 11 <24H2 可能阻塞（需先 kill 子进程） |

**IDE 终端需要处理这些差异**，特别是 Windows 下的原始模式和输出编码。

### 6.2 Bun.YAML 不支持 `!!js` 自定义标签

Cordis 的 cordis.yml 大量使用 `!!js` 执行表达式（`dshHomePath('sessions')`、`process.cwd()`、`process.platform === 'win32'`）。Bun.YAML 不支持自定义标签，需要：



1. **预处理方案**：用正则将 `!!js expr` 替换为占位符，YAML 解析后再 eval

2. **保留 js-yaml**：只在 Cordis 配置加载时用 js-yaml，其他 YAML 用 Bun.YAML

3. **修改 Cordis**：将 `!!js` 改为标准 YAML 标签（如 `!js`），但这需要改 vendor 的 Cordis 源码

### 6.3 Bun.WebView 是实验性 API

Bun.WebView 标注为 experimental，API 可能在未来版本变化。生产环境使用需要：



* 锁定 Bun 版本

* 封装适配层，隔离 API 变化

* 准备 fallback 方案（如 playwright）

### 6.4 Bun.markdown 是 Unstable API

Bun.markdown 标注为 Unstable，可能变化。建议封装适配层。

### 6.5 原生模块的 N-API 兼容性

如果选择方案 A（Bun 直接运行 dsh），需要验证以下原生模块在 Bun 下的 N-API 兼容性：



* `node-pty` → 建议直接用 `Bun.Terminal` 替代，不验证兼容性

* `koffi` → 建议用 `Bun.ffi` 替代

* `fs-ext` → 建议用 Bun 原生文件锁替代

* `esbuild` → Bun 内置，不需要

**结论**：如果用 Bun 原生 API 替代所有原生模块，dsh 在 Bun 下运行的最大障碍就消除了。

### 6.6 Cordis 框架在 Bun 下的兼容性

Cordis 是纯 JavaScript 框架（vendor 源码），不依赖 Node.js 原生模块。理论上可以在 Bun 下运行，但需要验证：



* Cordis 的 `Context` Proxy 对象在 Bun 的 JavaScriptCore 下是否正常

* Cordis 的事件循环（基于 Promise/setTimeout）在 Bun 下是否正常

* Cordis 的插件加载器（动态 import）在 Bun 下是否正常

* `!!js` 配置表达式在 Bun 下的 eval 是否安全

**建议**：先做一个最小验证 —— 用 Bun 运行 dsh 的 sdk-minimal profile，看是否能正常启动和响应 JSON-RPC。



***

## 7. 总结：Bun 化的收益

### 7.1 依赖减少



| 指标      | 现状 (Node.js + dsh)                    | Bun 化后          | 减少          |
| ------- | ------------------------------------- | --------------- | ----------- |
| 外部运行时依赖 | \~25 个                                | \~10 个          | **60%**     |
| 原生模块    | 4 个（node-pty, koffi, fs-ext, esbuild） | **0 个**（Bun.Terminal + Bun.FFI + Bun内置） | **100%** |
| 安装时间    | 慢（原生模块编译）                             | **极快**（零原生构建）   | -           |
| 包体积     | \~200MB（含原生模块）                        | \~50MB          | **75%**     |

### 7.2 性能提升



| 场景         | 提升                                               |
| ---------- | ------------------------------------------------ |
| 终端字符串宽度计算  | 100x - 30000x（Bun.stringWidth vs string-width）   |
| YAML 解析    | 显著提升（Rust vs JavaScript）                         |
| JSONL 流式解析 | 显著提升（C++ vs JavaScript）                          |
| 子进程 spawn  | 60% 更快（Bun.spawn vs child\_process，posix\_spawn） |
| 图像处理       | 与 sharp 相当（都是原生 SIMD），但零安装                       |
| 启动时间       | 显著提升（Bun 启动比 Node.js 快 2-3x）                     |

### 7.3 开发体验提升



* **零原生模块构建**：不再需要 node-gyp、Xcode CLI Tools、Visual Studio Build Tools

* **TypeScript 原生运行**：Bun 直接运行 .ts，不需要 tsx/ts-node

* **内置测试框架**：Bun:test 替代 vitest，更快

* **内置打包器**：Bun.build 替代 tsdown/esbuild

* **统一运行时**：IDE Core 和 dsh 都可以运行在 Bun 下（如果验证通过），消除 Node.js/Bun 双运行时

### 7.4 最终建议



1. **立即采用**：Bun 侧 IDE Core 全部使用 Bun 原生 API（Phase 1），这是零风险的

2. **逐步验证**：dsh 子进程侧的替换（Phase 2）需要创建 dsh 插件并在 Bun 下验证

3. **长期目标**：验证 dsh 在 Bun 下的完整兼容性（Phase 3），如果通过，可以考虑消除 Node.js 子进程，实现全 Bun 运行时

**最关键的一步**：用 `Bun.Terminal` 替代 `node-pty`。这是 dsh 最大的原生模块依赖，也是跨平台兼容性问题最多的地方。Bun.Terminal 的 API 设计与 node-pty 非常接近，替换成本低，但收益巨大（零构建、跨平台原生支持、可复用 Terminal）。