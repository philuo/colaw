# Agent Note: Settings-defined catalog models default to reasoning-capable

Status: implemented

English | [中文](2026-09-21-settings-catalog-reasoning-default.zh.md)

## Problem

A custom provider added through the Settings → 模型 card (the `llm-provider` settings namespace) never showed the composer's 推理等级 row. `ModelSelect` renders that row only for a model whose catalog entry carries reasoning metadata, and that metadata existed only when the entry declared `reasoning: true` — a field the settings model editor does not offer. The user-visible asymmetry: DeepSeek official models always offered reasoning levels, every hand-added GLM/OpenAI-compatible model never did, and the only fix was hand-editing the settings document.

The omission was deliberate at the adapter layer: an undeclared capability must not be claimed on the model's behalf, because the host would persist input the endpoint may reject on every later turn.

## Decision

`resolveModels()` — the one settings-to-catalog resolve step in `dsh-llm-provider` — now defaults an undeclared row to `reasoning: true`; an explicit `reasoning: false` still opts out. Both wire protocols keep the adapter's own rule that a request names no reasoning control until an effort is actually chosen, so the default puts nothing new on the wire: `openai-completions` omits `reasoning_effort` for an absent or `off` selection, and `anthropic-messages` omits `thinking` the same way. The declaration reaches the wire only through the user's own selection, which is the assertion of the capability.

The settings model editor gains a 推理 checkbox per row whose checked state stores nothing (absence is the default) and whose unchecked state stores `reasoning: false`. The editor exposes no dialect choice: `thinkingFormat: 'zai'` stays a settings-document declaration for gateways that want the explicit zhi thinking toggle instead of `reasoning_effort`.

## Consequences

The selector treats an unknown endpoint optimistically: a user who picks a level on a model that cannot honor it gets the endpoint's own refusal at request time instead of a hidden selector. That is the accepted trade — the previous fail-closed posture made the capability undiscoverable for every custom provider, which is worse for a settings surface whose whole point is naming endpoints the plugin does not know.

Existing settings documents change meaning: a catalog that stayed silent about `reasoning` now resolves reasoning-capable. A deployment that needs the old behavior writes `reasoning: false` explicitly. cordis.yml-defined catalogs resolve through the same `resolveModels()` and see the same default.

## Alternatives considered

- **Keep `reasoning` opt-in and add a declaration field to the editor.** Preserves fail-closed, but the fetch-models flow (`GET {baseURL}/models`) returns no capability facts, so every fetched row would need a manual toggle before the selector worked — recreating the asymmetry this change removes.
- **Default only zai-dialect gateways to reasoning.** Would need a gateway-detection notion the settings document does not have; the wire already sends nothing until chosen, so protocol-level discrimination buys nothing.

## Testing

`resolveAdapterOptions` pins the default and the opt-out at the resolve step (`packages/llm/llm-provider/tests/adapter.spec.ts`); the OpenAI and Anthropic adapter suites pin that an opted-out model carries no reasoning field while a default-capable one does, and that the selector vocabulary (`off`/`low`/`high`) is exposed for an undeclared row. The editor checkbox is pinned in `packages/client/ui-settings-models/tests/components.client.spec.tsx`.
