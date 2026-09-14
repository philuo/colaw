---
description: "面向配置 anthropic-compatible 路由、思考预算与图片输入的用户与维护者的 Anthropic messages 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-anthropic

[English](README.md) | 中文

## 摘要

使用本包通过 Anthropic Messages 协议在 `anthropic-compatible` 路由上进行流式模型调用，支持推理模型的扩展思考、视觉模型的内联图片输入，以及咨询性模型目录。端点可配置，因此同一适配器既服务 Anthropic 官方 API，也服务任何兼容网关。端点、凭据、目录与力度策略按请求解析，合法的用户设置变更即时作用于下一个请求，无需重启进程。

## 使用本包

### 何时选择它

面向 Anthropic 官方 API 或说 Messages 协议的兼容网关时选择本适配器。OpenAI chat-completions 端点请用 `@deepseek-ai/dsh-llm-openai`；DeepSeek API 请用 `@deepseek-ai/dsh-llm-deepseek`。路由 ID 是 `anthropic-compatible`——刻意不叫 `anthropic`（pi-ai 占用该 ID），因此可以并存挂载。

### 最小配置

该路由出厂不带模型目录——请声明端点实际服务的模型。Messages API 每次请求都必须带输出上限，因此始终会发送（默认 128,000）：

```yaml
llm-anthropic:
  baseURL: https://api.anthropic.com    # or any Messages-protocol gateway
  apiKeyEnv: ANTHROPIC_API_KEY
  models:
    - id: claude-fable-5
      name: Claude Fable 5
      contextWindow: 1000000
      maxTokens: 128000
      reasoning: true                   # accepts extended thinking
```

### 思考预算

只有声明 `reasoning: true` 的目录模型会收到 `thinking` 块。预算取 `thinkingBudgetTokens`（默认 16,384；`low` 用其四分之一），输出上限会自动抬升到预算之上。harness 的 `max` 与 `high` 映射到同一档。

### 图片

视觉模型（目录条目 `inputModalities` 含 `image`）接受持久附件，以内联 base64 source 序列化，受字节预算与确定性卸载步长约束。

## 理解实现

适配器只负责传输：`serialize` 把 harness 消息转为线格式（无签名的 reasoning 在 assistant 回放时折叠为纯文本，与 pi-ai 的默认一致），`sse` 组帧类型化事件流，`translate` 组装 harness 块，插件负责校验、凭据解析与设置分层。设计沿用 `@deepseek-ai/dsh-llm-deepseek` 与 `@deepseek-ai/dsh-llm-openai`。
