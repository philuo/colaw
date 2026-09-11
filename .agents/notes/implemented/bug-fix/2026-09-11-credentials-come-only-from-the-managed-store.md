# Agent Note: Credentials come only from the managed store

Status: implemented

English | [中文](2026-09-11-credentials-come-only-from-the-managed-store.zh.md)

## Problem

The credential seam documented a reference as resolving through several layers — the inherited process environment, the managed store, and project/user `.env` files — and the shipped resolvers implemented that layering. `dsh-credentials-local` preferred the launch environment over the stored file; `llm-deepseek` fell back to the environment when the store held nothing; the web-search providers did the same; `llm-pi-ai`'s `AuthContext.env` answered provider-native discovery from the process environment even with the store mounted.

That made an ambient secret a real credential source inside the desktop app. A user who had ever exported `DEEPSEEK_API_KEY` (or `ANYSEARCH_API_KEY`, `OPENAI_API_KEY`, …) in the shell that launched Colaw would silently authenticate a route they never configured in the product, and the Models page could not show or revoke it. The product requirement is the opposite: every key is user-configured and stored; the app must never read one from the environment.

## Decision

The managed store is the sole credential source. `$DSH_HOME/.credentials.yaml` (by default `~/.colaw/.credentials.yaml`) is the only document a reference resolves against.

- `dsh-credentials-local` reads and writes only that file. The inherited-environment layer, the user `.env`, the project `.env`, and the environment-shadowing write refusal are all deleted; `resolve` answers file-or-nothing and `describe` reports `file` or unconfigured.
- `llm-deepseek.resolveApiKey` consults `ctx.credentials` and nothing else. A miss fails with `MISSING_CREDENTIAL`, whose message points only at the Models page. The same holds for the empty/invalid-key guidance in `assertUsableApiKey`.
- `web-search-deepseek` and `web-search-anysearch` resolve their key reference through `ctx.credentials` only. `web-search-exa` and `web-search-perplexity` accept a literal `apiKey` from their own config and no longer read `$EXA_API_KEY` / `$PERPLEXITY_API_KEY`.
- `llm-pi-ai`'s `authContextFrom(ctx).env()` answers only from the seam, so a provider's own discovery cannot see the process environment; a profile that names a reference resolves it through the store, and one that names none can no longer borrow an ambient key.
- One seam-less escape remains by design: `llm-pi-ai`'s named-reference resolver still reads the launch environment when the composition mounts no credentials service at all (a hand-written headless composition). No shipped composition — the desktop app, the CLI profiles — omits the service, so this path is unreachable in products.

Endpoint URLs (`DEEPSEEK_BASE_URL`, `DEEPSEEK_SEARCH_BASE_URL`) are not secrets and keep their environment fallbacks.

## Alternatives considered

- **Keep the environment as a lowest-precedence credential layer.** Rejected: the whole point is that a key the user did not configure in the product cannot authenticate. An invisible, non-revocable source defeats the Models page.
- **Keep the environment only for seam-less compositions.** Kept for pi-ai's named references (explicitly a headless composition with no store), removed everywhere else: the web providers and `llm-deepseek` no longer branch on the seam at all.
- **Accept a literal key in plugin config for every provider.** Already present for the web-search providers; deliberately not added to `llm-deepseek`, whose config carries the reference only so the secret stays out of configuration files.

## Consequences

- Supplying a key by shell export or CI variable no longer works in the app. Every key is entered on the Models page (which writes the store) or by editing `.credentials.yaml` directly.
- Tests that previously seeded a key with `vi.stubEnv` now mount `dsh-credentials-local` and `set` the reference; the desktop e2e seeds `$DSH_HOME/.credentials.yaml` in the isolated home. The environment-ignored behavior is asserted, not incidental.
- The credential-seam doc comments and the base-bundle mount comment describe the store-only contract. The longer prose in `docs/subsystems/credentials.md`, the package READMEs, and the launch-environment cross-references still describe the removed layering and need a follow-up documentation pass.
