# Agent Note: 电脑操控权限面板探测宿主自身的 TCC 状态

Status: implemented

[English](2026-09-21-desktop-permission-panel-probe.md) | 中文

部分取代原桌面页接线中的 TODO（"typert 端点随下一轮 remote 落地"）：`desktopPermissions` 远端现在有了生成的客户端贡献，分节的 `loadPermissions` 桩已移除。

## 问题

电脑操控页的 macOS 权限面板永远显示 检测中…：客户端加载器是显式桩，宿主控制器藏在一个没有任何产物支撑的 `package.json` 导出后面，生成的远端契约也没有客户端挂载。面板无法表达 Colaw.app 持有哪几项授权，系统设置深链也不可达（它只在探测有应答时渲染）。

## 决策

- `DesktopPermissionsController` 把 `@Remote` 边界类型声明在 `./types`，其 `package.json` 按生成器校验器的要求精确导出 `./typert` 与 `./remote`；工作区构建产出 `lib/typert.remote-client.js`。
- 生成的贡献挂载在平台中立的客户端装配（`packages/api/remotes/src/client`），电脑操控页由此可以调用 `ctx.remote.desktopPermissions.{status,openPermissionSettings}`。
- 客户端 bundle 隔离门增加一个窄化例外：实验包生成的 `lib/typert.remote-client.*` 产物可进入客户端 bundle。它们是模型驱动的 schema 描述符，不含所属包的任何运行时——实验运行时的禁令本身不变。
- 分节 store 持有探测应答；每次进入该页都会重新探测，系统设置深链返回新应答。被拒绝的调用让应答保持未设置（检测中…）——诚实的"尚无探测应答"，由下次挂载重试——而不是陈旧的已授权/未授权结论。

## 后果

面板现在表达真实的 TCC 状态，包括用户刚在系统设置里完成的授权（深链会重新探测）。没有桌面 bundle 的宿主对每次探测都应答 `not ok`，该 profile 下面板保持 检测中…——可见、诚实、每次访问重试。客户端 bundle 从此携带一个实验包的生成契约；隔离门例外是经过评审的接缝，若实验运行时真的泄漏进来，回退方案是把该 remote 移入非实验包。

## 备选方案

- **保留桩并隐藏面板，直到端点"落地"。** 宿主侧端点早已存在；隐藏面板让一个权限面对用户不可见，而提供方却已随包发布——两头都不占。
- **把控制器移入非实验的 api 包。** 对隔离规则最干净，但它把控制器与它驱动的原生 SDK 接缝拆开，并为两个方法新增一个包；生成产物例外以更小的代价达到了同样的客户端保证。

## 测试

`packages/client/ui-settings-desktop/tests/section.client.spec.tsx` 在 slot store 上钉住 检测中/已授权/未授权 渲染态与挂载即探测；connection fixture 应答 `desktopPermissions/*`；`build:lib:client` 在隔离例外与产物不一致时必然失败。
