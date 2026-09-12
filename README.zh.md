# Colaw

[English](README.md) | 中文

Colaw 是一款运行在 macOS（Apple 芯片）上的桌面 AI 编码助手：把对话、工作区、会话与文件预览收进一个原生窗口，直接在本地项目里读写代码、跑命令、查资料。

## 功能

- **对话式编码**：读写/编辑文件、按内容搜索、执行命令、联网查询，支持多轮任务与子代理、工作流编排。
- **工作区与会话**：按工作区组织会话；支持归档与回收站（清空全部、逐条恢复或彻底删除）；每个会话保留完整历史，可随时恢复。
- **右侧栏文档预览**：Markdown、代码（行号 + 语法高亮）、PDF、图片、HTML、纯文本一栏预览，随取随看，不必切换应用。
  - 长图与超大图片**深度缩放**：任意放大倍数都保持锐利，以鼠标所在位置为缩放锚点，可拖拽平移。
  - **图片文字直接划选复制**：打开图片即静默识别其中文字（Apple Vision，本机完成、不上传），文字层与图片像素对齐，可直接划选、复制。
- **模型与凭证**：在「设置 → 模型」配置 API Key（仅保存在本机受管存储，不读取环境变量），可切换模型与推理等级。
- **自动更新**：增量补丁更新，重启即生效。

## 安装

从 [Releases](https://github.com/philuo/colaw/releases/latest) 下载 `Colaw.dmg`，打开后把 Colaw 拖入「应用程序」。首次启动后在 **设置 → 模型** 填入 API Key 即可开始使用。

系统要求：macOS 15 或更高版本，Apple 芯片（arm64）。

<a id="run"></a>
## 运行与使用

- 打开应用即进入会话界面；`⌘N` 新建会话，`⌘B` 折叠/展开左侧栏。
- 顶栏的「选择工作区」可绑定工作目录，绑定后助手默认在该目录下工作。
- 右侧栏：点右上角面板图标打开；「文件」标签页浏览工作区文件，点文件即预览；图片与 PDF 支持缩放、平移。
- 顶栏「在访达中打开工作目录」可直接在访达中定位当前目录。

## 开发与打包

本仓库以 [Bun](https://bun.com) 为唯一运行时：安装、脚本、测试、构建一律用 `bun` / `bunx`，不要用 `node` / `npx`。

本地打包稳定版——一条命令走完「产品打包 → 正式发布身份 → 直接可运行的 App → DMG」：

```sh
bun scripts/pack-stable-release.ts
```

产物在 `apps/electrobun-host/build/stable-macos-arm64/`：

- `Colaw.app` —— 双击即可运行；
- `Colaw.dmg` —— 分发镜像。

开发模式与常用检查：

```sh
cd apps/electrobun-host && bun run dev   # hot-reload development window
bun vitest run <test path>               # unit tests
bun node_modules/typescript/bin/tsc -b tsconfig.client.json   # client typecheck
```

## 说明

基于 dsh 项目改造而来，适配 MacOS Arm64。
