---
description: "boot 包组：dsh app bin 如何启动——环境加载、profile 与 patch 层、清晰的启动失败信息，以及由应用持有的命令行。"
kind: "package-group"
---

# boot/：共享的 app bin 启动粘合层

[English](README.md) | 中文

## 概述

boot 组提供每个 dsh app bin 启动所需的全部能力：`app-boot` 把 `cordis.yml` 连同你的环境与 patch 层变成运行中的应用，并给出清晰的失败信息；`cmdline` 让应用持有自己的命令行 flag 与 `--help`；`hmr` 在应用运行期间通过一个队列协调模块与 profile 配置的重载。借助这些包，你可以运行 `dsh`，也可以编写以同样方式启动的新应用或测试用 fixture。`app-boot` 与 `cmdline` 是 `apps/cli` 与测试专用 Loader fixture 导入的库，绝不是组合加载的插件。本页列出该包组的构成；各包 README 负责各自的包级约定。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`app-boot`](app-boot/README.zh.md) | 从 `cordis.yml` 启动 dsh 应用：加载 `.env`、应用 profile 与 patch 层，并清晰报告启动失败 | （供各 bin 使用的库） |
| [`cmdline`](cmdline/README.zh.md) | 让应用持有自己的 flag、`--help` 与退出码；启动器自身 flag 之后的一切原样传入 | `cmdlineArgs`、`appExit` |
| [`hmr`](hmr/README.zh.md) | 通过一个队列协调模块与 profile 配置的重载 | `hmr` |

<a id="related-documentation"></a>
## 相关文档

- [dsh 应用](../../apps/cli/README.zh.md)——在其启动序列中使用这些 helper 的 `dsh` bin。
- [Profile 组合包](../bundle/README.zh.md)——可由 `dsh --profile` 组合挂载的可安装 patch 层。
- [dsh-home-paths](../util/home-paths/README.zh.md)——两个包都依赖的 harness home 解析器。
- [dsh-cmdline](cmdline/README.zh.md)——flag 家族如何由应用持有而非启动器。

- [应用启动与 HMR](../../docs/subsystems/boot.zh.md)——服务方法、事件与重载队列。

<a id="dev-note"></a>
## 开发备注

无。
