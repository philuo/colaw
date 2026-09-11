# Agent Note：桌面主题经宿主推送的配色跟随系统

Status: implemented

[English](2026-09-11-desktop-theme-follows-system-through-host-push.md) | 中文

## 问题

桌面壳里「跟随系统」的主题偏好曾把界面画成暗黑，而 macOS 是浅色模式；且一直停在应用启动时的配色。两层原因叠加：

- webview 的 `prefers-color-scheme` 反映的是应用级 AppKit 外观。该外观可能被显式偏好强制，而在已有视图下重设会抛出无法经 FFI 展开的 Objective-C 异常并终止进程——因此它只在首个窗口之前设置一次、整个会话冻结。「跟随系统」走媒体查询，跟随的其实是冻结值：显式 `dark` 启动后 macOS 切浅色仍报 dark，用户把偏好切回 `system` 后也一样。
- 图标轮询读 `effectiveAppearance`——同样是冻结答案，Dock 图标跟随的也是启动快照。

## 决策

宿主持有解析后的配色并推送；客户端在桌面壳内优先采用它而非媒体查询。

- `app-appearance.ts` 新增 `systemIsDark()`：经 `NSUserDefaults` 读 `AppleInterfaceStyle` 偏好。这是系统自身的设置，不受应用级钉死影响。图标与页面配色对 `system` 的解析都走它；`isDarkAppearance()`（冻结的 effective 答案）删除。
- 宿主把 `__DSH_DESKTOP_APPEARANCE__`（`'light' | 'dark'`）作为 index 注入全局——首帧即正确；既有的原生 chrome 轮询把变化推入页面（`window.__DSH_DESKTOP_APPEARANCE__ = …` 加 `dsh:desktop-appearance` 事件），与全屏状态同一通道。轮询覆盖两类变化来源：设置写入，以及 `system` 偏好下 macOS 自行切换，各自在一个 2 秒轮询内到达。
- `ui-theme` 客户端在 `system` 解析时优先用推送值（`environmentDark`），浏览器与无头运行回落 `prefers-color-scheme`，并在桌面事件上重新发布；boot-theme 内联脚本在首帧前应用同一优先级。

应用级 AppKit 外观维持原状：显式偏好在启动时强制一次，`system` 置 `nil`（其页面侧正确性不再依赖它）。

### 由此暴露的构建链要求

客户端 bundle 从 client 面编译出的 `lib/types/client/*.js` 构建，从不直接用 `src`。先跑 tsdown client 面而不先跑 `tsc -b tsconfig.client.json` 的打包（或任何重建）会**静默**发布上一版客户端构建——宿主侧改动到了，成对改动的客户端一半却没到。`pack-stable-app.ts` 现在先跑两个面的 `tsc`，再跑两个面的 `tsdown`。

## 被否决的备选

- **变化时重设 `NSApp.appearance`。** 否决：活跃视图下的异常无法经 FFI 展开并杀死进程；冻结外观的约束来自真实崩溃记录。
- **`appearance = nil` 下依赖 `prefers-color-scheme`。** 否决：显式 `dark`/`light` 启动仍会钉住媒体查询，运行时解除钉死就是那个被禁止的调用。

## 后果

- `system` 在一个轮询周期内跟随真实系统设置，页面与 Dock 图标一致，即使同会话早先的显式选择钉住了应用级外观。
- 显式 `light`/`dark` 偏好行为不变：页面、图标与（启动时的）应用级外观一致。
- 钉死期间 webview 的媒体查询仍是错的；桌面壳内任何读 `prefers-color-scheme` 的代码都必须改走推送值（全屏推送是宿主持有页面状态的既有先例）。
