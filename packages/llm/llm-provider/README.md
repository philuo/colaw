---
description: "The OpenAI chat-completions adapter for users and maintainers configuring the openai route, reasoning effort, and image input."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-provider

English | [中文](README.zh.md)

## Summary

Use this package to stream models through the `openai-compatible` route over the OpenAI chat-completions protocol, including per-model reasoning effort, inline image input for vision models, and an advisory model catalog. The endpoint is configurable, so the same adapter serves the official OpenAI API and any OpenAI-compatible gateway (a custom `baseURL` plus a credential reference). Endpoint, credentials, catalog, and effort policy resolve for each request, so valid user-settings changes apply to the next request without restarting the process.

## Use this package

### When to choose it

Choose this adapter for the official OpenAI API or an OpenAI-compatible gateway speaking the chat-completions dialect. For the DeepSeek API (or a gateway that wants DeepSeek's `thinking` fields and Files API image offload), use `@deepseek-ai/dsh-llm-deepseek`; for multi-provider catalogs configured from one settings section, use the pi-ai package. The routes have distinct names, so they can stay mounted side by side.

### Minimal configuration

The route ships with no model catalog — declare what your endpoint actually serves. The key resolves through the credentials store (the web Models page writes it):

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

Set `maxTokensField: max_completion_tokens` when the endpoint requires the newer output-cap field name (newer official OpenAI reasoning models); the default `max_tokens` is the compatible-gateway spelling.

### Reasoning effort

Only catalog models declared `reasoning: true` receive a `reasoning_effort` field. OpenAI's vocabulary has no `off` (the field is omitted) and no `max` (harness `max` maps to `high`), so the adapter declares `off`/`low`/`high` for such models.

### Images

Vision models (catalog entries with `image` in `inputModalities`) accept durable attachments, serialized as inline base64 data URLs under a byte budget with deterministic offload steps. There is no Files API on this route; text-only models receive the standard text projection instead.

## Understand the implementation

The adapter is transport-only: `serialize` converts harness messages to the wire, `sse` frames the event stream, `translate` assembles harness blocks, and the plugin owns validation, credential resolution, and settings layering. The design follows `@deepseek-ai/dsh-llm-deepseek`; read that package's README for the shared streaming, retry, and failure-normalization contracts.
