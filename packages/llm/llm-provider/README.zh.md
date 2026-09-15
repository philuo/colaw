---
description: "面向配置 openai 路由、推理力度与图片输入的用户与维护者的 OpenAI chat-completions 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-provider

[English](README.md) | 中文

## 摘要

使用本包通过 OpenAI chat-completions 协议在 `openai` 路由上进行流式模型调用，支持按模型的推理力度、视觉模型的内联图片输入，以及咨询性模型目录。端点可配置，因此同一适配器既服务 OpenAI 官方 API，也服务任何 OpenAI 兼容网关（自定义 `baseURL` 加凭据引用）。端点、凭据、目录与力度策略按请求解析，合法的用户设置变更即时作用于下一个请求，无需重启进程。

## 使用本包

### 何时选择它

面向 OpenAI 官方 API 或说 chat-completions 方言的 OpenAI 兼容网关时选择本适配器。DeepSeek API（或需要 DeepSeek `thinking` 字段与 Files API 图片转存的网关）请用 `@deepseek-ai/dsh-llm-deepseek`；需要从一个设置段配置多供应商目录时请用 pi-ai 包。各路由名称互不相同，可以并存挂载。

### 最小配置

该路由出厂不带模型目录——请声明端点实际服务的模型。密钥通过凭据存储解析（网页 Models 页负责写入）：

```yaml
llm-provider:
  baseURL: https://api.openai.com/v1   # or any chat-completions gateway
  apiKeyEnv: OPENAI_API_KEY
  models:
    - id: gpt-4o
      name: GPT-4o
      contextWindow: 128000
    - id: o4-mini
      name: o4-mini
      reasoning: true                  # accepts reasoning_effort on the wire
```

当端点要求较新的输出上限字段名（较新的 OpenAI 官方推理模型）时设置 `maxTokensField: max_completion_tokens`；默认 `max_tokens` 是兼容网关的写法。

### 推理力度

只有声明 `reasoning: true` 的目录模型会收到 `reasoning_effort` 字段。OpenAI 的词表没有 `off`（省略字段即默认）也没有 `max`（harness 的 `max` 映射为 `high`），因此适配器为这类模型声明 `off`/`low`/`high`。

### 图片

视觉模型（目录条目 `inputModalities` 含 `image`）接受持久附件，以内联 base64 data URL 序列化，受字节预算与确定性卸载步长约束。本路由没有 Files API；纯文本模型收到的是标准文本投影。

## 理解实现

适配器只负责传输：`serialize` 把 harness 消息转为线格式，`sse` 组帧事件流，`translate` 组装 harness 块，插件负责校验、凭据解析与设置分层。设计沿用 `@deepseek-ai/dsh-llm-deepseek`；流式、重试与失败归一化契约请阅读该包的 README。
