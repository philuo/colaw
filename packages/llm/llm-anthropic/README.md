---
description: "The Anthropic messages adapter for users and maintainers configuring the anthropic-compatible route, thinking budgets, and image input."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-anthropic

English | [中文](README.zh.md)

## Summary

Use this package to stream models through the `anthropic-compatible` route over the Anthropic Messages protocol, including extended thinking for reasoning models, inline image input for vision models, and an advisory model catalog. The endpoint is configurable, so the same adapter serves the official Anthropic API and any compatible gateway. Endpoint, credentials, catalog, and effort policy resolve for each request, so valid user-settings changes apply to the next request without restarting the process.

## Use this package

### When to choose it

Choose this adapter for the official Anthropic API or an Anthropic-compatible gateway speaking the Messages protocol. For OpenAI chat-completions endpoints use `@deepseek-ai/dsh-llm-openai`; for the DeepSeek API use `@deepseek-ai/dsh-llm-deepseek`. The route id is `anthropic-compatible` — deliberately not `anthropic`, which pi-ai owns — so they can stay mounted side by side.

### Minimal configuration

The route ships with no model catalog — declare what your endpoint actually serves. The Messages API requires an output cap on every request, so one is always sent (default 128,000):

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

### Thinking budget

Only catalog models declared `reasoning: true` receive a `thinking` block. The budget is `thinkingBudgetTokens` (default 16,384; `low` uses a quarter of it), and the output cap is raised above the budget automatically. Harness `max` maps to the same level as `high`.

### Images

Vision models (catalog entries with `image` in `inputModalities`) accept durable attachments, serialized as inline base64 sources under a byte budget with deterministic offload steps.

## Understand the implementation

The adapter is transport-only: `serialize` converts harness messages to the wire (unsigned reasoning folds into plain text on assistant replay, matching pi-ai's default), `sse` frames the typed event stream, `translate` assembles harness blocks, and the plugin owns validation, credential resolution, and settings layering. The design follows `@deepseek-ai/dsh-llm-deepseek` and `@deepseek-ai/dsh-llm-openai`.
