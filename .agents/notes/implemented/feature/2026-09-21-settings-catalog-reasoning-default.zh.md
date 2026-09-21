# Agent Note: 设置定义的目录模型默认按支持推理处理

Status: implemented

[English](2026-09-21-settings-catalog-reasoning-default.md) | 中文

## 问题

通过"设置 → 模型"卡片添加的自定义提供方（`llm-provider` 设置命名空间）从不显示输入区的推理等级行。`ModelSelect` 只为目录条目带有推理元数据的模型渲染该行，而这份元数据只在条目声明 `reasoning: true` 时存在——设置页的模型编辑器并不提供这个字段。用户可见的不对称是：DeepSeek 官方模型总是提供推理等级，每个手动添加的 GLM/OpenAI 兼容模型从不提供，唯一的修复办法是手工编辑设置文档。

这种省略在适配器层是刻意的：不得替模型声明未经验证的能力，否则宿主会把端点可能在后续每一轮拒绝的输入持久化进会话。

## 决策

`dsh-llm-provider` 中唯一的"设置到目录"解析步骤 `resolveModels()` 现在把未声明的行默认为 `reasoning: true`；显式的 `reasoning: false` 仍然可以退出。两种线上协议都保留适配器自身的规则——只有实际选择了等级，请求才会携带推理控制——因此该默认值不会往线上新增任何字段：`openai-completions` 在未选择或选择 `off` 时省略 `reasoning_effort`，`anthropic-messages` 同样省略 `thinking`。声明只有经过用户自己的选择才会到达线上，而那正是对能力的断言。

设置页的模型编辑器为每行增加一个"推理"复选框：勾选状态不存储任何东西（缺省即默认），取消勾选则存储 `reasoning: false`。编辑器不提供方言选择：`thinkingFormat: 'zai'` 仍是设置文档里的声明，供希望用明确的 zai thinking 开关替代 `reasoning_effort` 的网关使用。

## 后果

选择器对未知端点采取乐观姿态：用户在一个无法兑现该能力的模型上选择了等级，会在请求时得到端点自己的拒绝，而不是一个被隐藏的选择器。这是被接受的权衡——此前的 fail-closed 姿态让每个自定义提供方都无法发现这项能力，对一个以"命名插件不认识的端点"为存在意义的设置面来说更糟。

已有的设置文档语义发生变化：对 `reasoning` 保持沉默的目录现在解析为支持推理。需要旧行为的部署应显式写 `reasoning: false`。cordis.yml 定义的目录经过同一个 `resolveModels()`，遵循同一个默认值。

## 备选方案

- **保留 `reasoning` 的声明式启用，并在编辑器里加声明字段。** 保留 fail-closed，但获取模型流程（`GET {baseURL}/models`）不返回任何能力事实，每行获取到的模型都得先手动打开开关，选择器才能出现——这恰恰重建了本次修改要消除的不对称。
- **只对 zai 方言网关默认启用推理。** 需要一个设置文档里并不存在的"网关识别"概念；而线上本就只在用户选择后才发送字段，协议层甄别毫无收益。

## 测试

`resolveAdapterOptions` 在解析步骤钉住默认值与退出方式（`packages/llm/llm-provider/tests/adapter.spec.ts`）；OpenAI 与 Anthropic 适配器套件钉住"退出的模型不携带推理字段、默认模型携带"，以及未声明行会暴露选择器词表（`off`/`low`/`high`）。编辑器复选框钉在 `packages/client/ui-settings-models/tests/components.client.spec.tsx`。
