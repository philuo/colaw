---
description: "电脑操控 设置页：三个能力开关（电脑操控、CDP 浏览器、锁屏可用）共用一个持久化命名空间，外加 macOS TCC 权限面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-desktop

[English](README.md) | 中文

## 摘要

电脑操控页是 Colaw 桌面系能力的用户侧控制面。它渲染三个独立开关——Computer use、Browser use、锁屏操作——写入同一个持久化设置命名空间（`ui-desktop-control`），并附带一个 macOS 权限面板，实时镜像宿主进程的 TCC 状态（辅助功能、屏幕录制）。开关写入是乐观的，且从不触碰 macOS 授权；权限面板通过 `desktopPermissions` 远端探测宿主，并在缺授权时深链系统设置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期事项](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

该页随 Web 客户端的桌面 bundle 一起发布。每个开关默认 `false`：启用一项能力是在此做出的显式用户选择，各开关独立门控各自的能力。开启 Computer use 在桌面提供方下次挂载时生效（应用重启）；关闭则停止新的使用，且不撤销用户已授予的任何 macOS 权限——TCC 授权属于用户和系统，不属于这个偏好项。

### macOS 权限面板

电脑操控需要应用自身持有辅助功能与屏幕录制授权。面板通过 `desktopPermissions` 远端探测宿主自身的 TCC 状态，逐项列出每项授权，并在缺授权时深链 macOS 系统设置；深链返回时会重新探测，用户刚做的授权立即显示。每次进入该页都会重新探测，未获应答的探测显示 检测中… 而不是陈旧的结论。

<a id="understand-the-implementation"></a>
## 理解实现

分节状态保存在一个 slot store 中：持久化作用域快照镜像进该 store（开关写入即时落地，接受的线上写入随后收敛），探测应答经 `setPermissions` 写入同一 store。宿主半边注册命名空间 schema；桌面系提供方读取它以决定是否发布各自的能力面。探测在宿主进程内执行，因此操作系统把权限请求归因于 Colaw 自身；浏览器半边只持有远端调用。

<a id="model-experience"></a>
## 模型体验

- **无模型可见面** —— 本页只改变用户侧能力开关；它不贡献工具、提示词段或事件。会话只能通过宿主挂载了哪些桌面系提供方与工具来感知这些开关。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期事项

- **Browser use 与锁屏可用尚无消费方** —— 持久化字段已保存，但还没有提供方读取；开关是这些能力面发布之前的契约占位。
