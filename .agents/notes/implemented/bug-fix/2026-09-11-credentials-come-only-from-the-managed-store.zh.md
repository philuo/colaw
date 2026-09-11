# Agent Note：凭证只来自受管存储

Status: implemented

[English](2026-09-11-credentials-come-only-from-the-managed-store.md) | 中文

## Problem

凭证 seam 过去把引用描述为跨多层解析——继承的进程环境、受管存储、项目/用户 `.env` 文件——而实际发布出去的解析器也实现了这套分层。`dsh-credentials-local` 让启动环境优先于已存文件；`llm-deepseek` 在存储为空时回退到环境；web 搜索各 provider 也一样；`llm-pi-ai` 的 `AuthContext.env` 即便在存储已挂载时，也会用进程环境回答 provider 原生的凭证发现。

这让环境里的密钥成为桌面应用内一个真实的凭证来源。只要用户在启动 Colaw 的 shell 里导出过 `DEEPSEEK_API_KEY`（或 `ANYSEARCH_API_KEY`、`OPENAI_API_KEY`……），应用就会静默地用其认证一条用户从未在产品里配置过的路由，而 Models 页既看不到也无法撤销它。产品要求恰恰相反：每个密钥都由用户配置并存储；应用绝不能从环境读取密钥。

## Decision

受管存储是唯一的凭证来源。引用只对 `$DSH_HOME/.credentials.yaml`（默认 `~/.colaw/.credentials.yaml`）解析。

- `dsh-credentials-local` 只读写该文件。继承环境层、用户 `.env`、项目 `.env`，以及“环境遮蔽时拒绝写入”全部删除；`resolve` 只回答“文件里有值”或“没有”，`describe` 报 `file` 或未配置。
- `llm-deepseek.resolveApiKey` 只查 `ctx.credentials`，不再有别的来源。未命中即 `MISSING_CREDENTIAL`，消息只指向 Models 页。`assertUsableApiKey` 对空值/非法值的提示同理。
- `web-search-deepseek` 与 `web-search-anysearch` 只通过 `ctx.credentials` 解析各自的密钥引用。`web-search-exa` 与 `web-search-perplexity` 只接受自身配置里的字面 `apiKey`，不再读 `$EXA_API_KEY` / `$PERPLEXITY_API_KEY`。
- `llm-pi-ai` 的 `authContextFrom(ctx).env()` 只回答 seam，provider 自身的发现看不到进程环境；声明了引用的 profile 走存储解析，未声明引用的 profile 也不能再借用环境密钥。
- 按设计保留一处无 seam 逃逸：当组合完全没有挂载凭证服务时（手写的 headless 组合），`llm-pi-ai` 的具名引用解析仍读启动环境。所有随产品发布的组合——桌面应用、CLI profile——都挂载该服务，因此该路径在产品中不可达。

端点 URL（`DEEPSEEK_BASE_URL`、`DEEPSEEK_SEARCH_BASE_URL`）不是密钥，保留环境回退。

## Alternatives considered

- **把环境保留为最低优先级的凭证层。** 否决：重点正是“用户没在产品里配置的密钥不能用于认证”。一个不可见、不可撤销的来源会架空 Models 页。
- **只在无 seam 的组合里保留环境。** 仅对 pi-ai 的具名引用保留（明确是无存储的 headless 组合），其余全部移除：web 各 provider 与 `llm-deepseek` 已完全不再按 seam 分支。
- **为每个 provider 接受配置里的字面密钥。** web 搜索各 provider 已支持；刻意不给 `llm-deepseek` 加，因为它的配置只携带引用，以免密钥进入配置文件。

## Consequences

- 在应用里通过 shell 导出或 CI 变量提供密钥不再生效。所有密钥都在 Models 页输入（由它写入存储），或直接编辑 `.credentials.yaml`。
- 过去用 `vi.stubEnv` 注入密钥的测试改为挂载 `dsh-credentials-local` 并 `set` 引用；桌面 e2e 在隔离 home 里写入 `$DSH_HOME/.credentials.yaml`。“环境被忽略”是被断言的行为，而非偶然。
- 凭证 seam 的文档注释与 base bundle 的挂载注释已描述“仅存储”契约。`docs/subsystems/credentials.md`、各包 README 以及 launch-environment 交叉引用中较长的叙述仍描述已移除的分层，需要一次后续文档更新。
