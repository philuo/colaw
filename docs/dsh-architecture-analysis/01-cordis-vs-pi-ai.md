# Cordis 与 Pi-ai：澄清与定位

> 核心结论：**Cordis 没有被抛弃，Pi-ai 也不是 Cordis 的替代品。** 二者处于完全不同的架构层级。

## 一句话回答

| 框架 | 层级 | 角色 | 状态 |
|---|---|---|---|
| **Cordis** | 元框架（Meta-Framework） | 整个 dsh 的插件运行时、依赖注入、事件总线、生命周期管理 | **核心，被 vendor 到本地**（v4.0.2，rescope 为 `@deepseek-ai/cordis`） |
| **Pi-ai**（`@earendil-works/pi-ai`） | LLM 客户端库 | 多供应商 LLM API 适配器的底层 HTTP/协议客户端 | **可选，作为 `dsh-llm-pi-ai` 插件的依赖** |

## Cordis：dsh 的骨架

### Vendor 而非 npm 依赖

Cordis 的源码被直接 vendor 到 `vendor/cordis/`，并通过 `pnpm-workspace.yaml` 的 `overrides` 强制将所有 `@deepseek-ai/cordis` 解析到本地 vendor 副本：

```yaml
# pnpm-workspace.yaml
overrides:
  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'
  '@deepseek-ai/schemastery': 'link:vendor/schemastery'
```

Vendor 的完整包列表：
- `vendor/cordis` — 核心框架（Context、Fiber、Service、Events、Registry、Reflect、Logger）
- `vendor/cosmokit` — 工具库
- `vendor/schemastery` — Schema 验证库（用于插件配置校验）
- `vendor/loader` — 插件加载器（`cordis-plugin-loader`）
- `vendor/include` — YAML 配置包含与补丁（`cordis-plugin-include`）
- `vendor/group` — 插件分组（`cordis-plugin-group`）
- `vendor/hmr` — 热模块重载（`cordis-plugin-hmr`）
- `vendor/timer` — 定时器服务（`cordis-plugin-timer`）
- `vendor/logger-console` — 控制台日志输出

### 为什么 Vendor？

1. **深度定制**：dsh 对 Cordis 做了 rescope（从原 `cordis` 改为 `@deepseek-ai/cordis`），并可能有本地修改
2. **版本锁定**：确保整个 monorepo 使用完全一致的框架版本，避免 semver 漂移
3. **发布控制**：vendor 包随 dsh 一起发布，用户无需单独安装 Cordis

### Cordis 在 dsh 中的核心角色

```
┌─────────────────────────────────────────────────┐
│                   Cordis Context                  │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │  Events  │ │ Registry │ │    Reflect      │ │
│  │ (事件总线)│ │ (插件注册)│ │ (服务注入/解析) │ │
│  └──────────┘ └──────────┘ └─────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │  Fiber   │ │ Service  │ │    Logger       │ │
│  │(生命周期树)│ │(服务基类) │ │   (日志服务)     │ │
│  └──────────┘ └──────────┘ └─────────────────┘ │
└─────────────────────────────────────────────────┘
         ▲                    ▲
         │                    │
  所有 dsh 插件          ctx.get('xxx') 服务注入
  (agent-loop, llm,     ctx.provide() 服务注册
   tools, session...)    ctx.on()/ctx.emit() 事件
```

**每一个 dsh 功能都是一个 Cordis 插件**：agent-loop、llm、tools、session、system-prompt、subprocess、fs、web、skill……没有"特权核心"，所有行为通过插件挂载到共享 Context 上。

## Pi-ai：LLM 层的可选适配器

### 包定位

`@earendil-works/pi-ai` 是 `packages/llm/llm-pi-ai` 包的**唯一外部运行时依赖**：

```json
// packages/llm/llm-pi-ai/package.json
"dependencies": {
  "@deepseek-ai/dsh-brand": "workspace:^",
  "@deepseek-ai/dsh-util-values": "workspace:^",
  "@deepseek-ai/schemastery": "workspace:^",
  "@earendil-works/pi-ai": "^0.85.1"
}
```

### 它是什么

Pi-ai 是一个**多供应商 LLM API 客户端库**，内置了多家 LLM 提供商的端点、协议和模型目录（OpenAI、Anthropic 等）。dsh 的 `llm-pi-ai` 插件将其包装为 dsh LLM 服务（`ctx.llm`）的一个适配器。

### 与 `dsh-llm-deepseek` 的关系

`llm-pi-ai` 被明确定义为 `dsh-llm-deepseek` 的 **"design-verification twin"**（设计验证孪生）：

- `dsh-llm-deepseek`：直连 DeepSeek 官方 API 的适配器，**默认启用**
- `dsh-llm-pi-ai`：通过 pi-ai 库连接多供应商的适配器，**默认休眠（dormant）**

二者可以同时挂载，因为它们的路由名称（provider route name）不冲突。注册另一个适配器已拥有的路由会导致插件加载失败。

### 默认休眠机制

在 `packages/bundle/base/cordis.patch.yml` 中：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  # 零路由（和模型选择器中无额外模型），直到 `llm-pi-ai:` 设置段提供 provider 配置
  # — 然后这些路由实时注册，密钥通过 apiKeyEnv 引用按请求解析，段清空时再次卸载
```

即：pi-ai 插件启动时**不注册任何 LLM 路由**，只有当用户在设置文档（`$DSH_HOME/settings.yaml`）中添加 `llm-pi-ai:` 段并配置 provider 时，才会激活对应路由。Web 端的 Models 页面就是通过写入这个设置段来启用 pi-ai 提供商的。

### pi-ai 的配置示例

```yaml
# $DSH_HOME/settings.yaml 中的 llm-pi-ai 段
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://proxy.example.com:8443
      reasoning: high
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      models:
        - id: claude-sonnet-4-5
          contextWindow: 200000
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
```

## 架构层级总图

```
┌──────────────────────────────────────────────────────────┐
│                     应用层 (Apps)                          │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐ │
│  │   CLI    │ │  Web UI  │ │  SDK   │ │ Electron桌面 │ │
│  └────┬─────┘ └────┬─────┘ └───┬────┘ └──────┬───────┘ │
└───────┼──────────────┼───────────┼───────────────┼─────────┘
        │              │           │               │
┌───────▼──────────────▼───────────▼───────────────▼─────────┐
│              Profile / Bundle 组合层                           │
│  dsh-base → dsh-web-app / dsh-headless / dsh-sdk-app / ...  │
│  (cordis.yml + cordis.patch.yml 层叠组合)                     │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│              Cordis 插件运行时 (vendor/cordis)                 │
│  Context · Fiber · Service · Events · Registry · Reflect      │
│  所有 dsh 包都是 Cordis 插件，挂载到共享 Context                │
└───────┬───────────────────────────┬───────────────────────────┘
        │                           │
┌───────▼──────────┐     ┌────────▼──────────────────────────┐
│  LLM 服务层       │     │       其他能力层                    │
│  ctx.llm          │     │  ctx.tools / ctx.sessions /       │
│  ┌──────────────┐ │     │  ctx.subprocess / ctx.fs /        │
│  │llm-deepseek  │ │     │  ctx.web / ctx.skill / ...        │
│  │(默认,直连DS)  │ │     └───────────────────────────────────┘
│  ├──────────────┤ │
│  │llm-pi-ai     │ │◄── @earendil-works/pi-ai (多供应商客户端)
│  │(可选,休眠)    │ │
│  └──────────────┘ │
└───────────────────┘
```

## 总结

1. **Cordis 是 dsh 的操作系统**：插件管理、依赖注入、事件总线、生命周期——所有功能都运行在它之上。它被 vendor 到本地以确保版本一致性和深度定制能力。

2. **Pi-ai 是 dsh 的一个可选 LLM 驱动**：就像打印机驱动一样，它只负责"如何与 LLM API 通信"这一件事。默认不启用，用户配置后才激活。它和 Cordis 不在一个层级，不存在"替换"关系。

3. **升级中新增 pi-ai 不意味着抛弃 Cordis**：恰恰相反，pi-ai 适配器本身就是一个 Cordis 插件，它的注册、配置、生命周期管理全部由 Cordis 负责。
