import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest, serializeRequestWithImages } from '../src/anthropic-serialize.ts'
import type { ImageSerializationOptions } from '../src/anthropic-serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'anthropic-compatible', model: 'claude-fable-5', messages: [], ...overrides }
}

const TEXT_USER = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })

function imageRef(mediaType: ImageMediaType = 'image/png', bytes = 3): ImageAttachmentRef {
  const digit = ({
    'image/png': 'a',
    'image/jpeg': 'b',
    'image/webp': 'c',
    'image/gif': 'd',
  } as const)[mediaType]
  return {
    attachmentId: AttachmentId(`sha256:${digit.repeat(64)}`),
    mediaType,
    bytes,
    width: 1,
    height: 1,
  }
}

function requestVersion(ref: ImageAttachmentRef): RequestImageAttachment {
  const hash = String(ref.attachmentId).slice('sha256:'.length)
  return {
    variantId: ImageVariantId(`sha256:${hash}`),
    attachment: ref,
    data: new Uint8Array(ref.bytes),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: ref.mediaType === 'image/png',
  }
}

function inlineImageOptions(
  refs: readonly ImageAttachmentRef[],
  maxRequestImageBytes = 20 * 1024 * 1024,
): ImageSerializationOptions {
  return {
    requestImages: new Map(refs.map(ref => [ref.attachmentId, requestVersion(ref)])),
    maxRequestImageBytes,
  }
}

describe('serializeRequest: a route declaring DeepSeek compatibility', () => {
  // DeepSeek implements this wire but documents three deviations. Each is
  // asserted together with the standard behaviour it must not disturb, because
  // the flag exists precisely so every other route keeps the standard form.
  const deepseek = { thinkingBudgetTokens: 16_384, compat: 'deepseek' as const }
  const reasoning = { reasoning: true, maxTokens: 64_000 }
  const asking = request({
    messages: [TEXT_USER],
    reasoningEffort: ReasoningEffortId('high'),
    temperature: 0.5,
  })

  it('sends reasoning effort where DeepSeek reads it, and keeps the budget for Anthropic', () => {
    const body = serializeRequest(asking, deepseek, reasoning)
    expect(body.output_config).toEqual({ effort: 'high' })
    // The budget still rides along: DeepSeek documents it as ignored, and the
    // standard vendor requires it.
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 })
    expect(serializeRequest(asking, { thinkingBudgetTokens: 16_384 }, reasoning).output_config)
      .toBeUndefined()
  })

  it('carries the low ladder rung through as an effort, not just a smaller budget', () => {
    const body = serializeRequest({ ...asking, reasoningEffort: ReasoningEffortId('low') }, deepseek, reasoning)
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  })

  it('sends no effort when thinking is off or the model cannot reason', () => {
    const off = serializeRequest({ ...asking, reasoningEffort: ReasoningEffortId('off') }, deepseek, reasoning)
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.output_config).toBeUndefined()
    expect(serializeRequest(asking, deepseek, { reasoning: false }).output_config).toBeUndefined()
  })

  it('keeps temperature while thinking is on, where the standard vendor drops it', () => {
    expect(serializeRequest(asking, deepseek, reasoning).temperature).toBe(0.5)
    expect(serializeRequest(asking, { thinkingBudgetTokens: 16_384 }, reasoning).temperature)
      .toBeUndefined()
    // With thinking off, both vendors take it.
    const off = { ...asking, reasoningEffort: ReasoningEffortId('off') }
    expect(serializeRequest(off, deepseek, reasoning).temperature).toBe(0.5)
    expect(serializeRequest(off, { thinkingBudgetTokens: 16_384 }, reasoning).temperature).toBe(0.5)
  })
})

describe('serializeRequest', () => {
  it('always streams, always carries the required cap, and folds system into the top level', () => {
    const body = serializeRequest(request({ system: 'be brief', messages: [TEXT_USER] }))
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(128_000)
    expect(body.system).toBe('be brief')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(JSON.stringify(body)).not.toContain('reasoning_content')
    expect(body).not.toHaveProperty('thinking')
  })

  it('folds in-history system messages into the top-level system prompt', () => {
    const body = serializeRequest(request({
      system: 'one-shot rules',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'plugin', plugin: 'test' } }),
        createMessage({ role: 'system', content: [{ type: 'text', text: 'history rules' }], source: { kind: 'plugin', plugin: 'test' } }),
        createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    }))
    expect(body.system).toBe('one-shot rules\n\nhistory rules')
  })

  it('omits thinking for non-reasoning models, unknown models, and a request naming no effort', () => {
    const options = request({ messages: [TEXT_USER], reasoningEffort: ReasoningEffortId('high') })
    expect(serializeRequest(options, { thinkingBudgetTokens: 16_384 }, { reasoning: false }).thinking).toBeUndefined()
    expect(serializeRequest(options, {}, undefined).thinking).toBeUndefined()
    // No effort anywhere: the vendor default stands, so the field is absent.
    const unpolicied = serializeRequest(
      request({ messages: [TEXT_USER] }),
      {},
      { reasoning: true },
    )
    expect(unpolicied.thinking).toBeUndefined()
  })

  it('says disabled rather than omitting thinking when the request turns it off', () => {
    // Omitting the field leaves the vendor default in force, which for a
    // reasoning model is thinking on — so a user who asked for `off` would not
    // get it. `{type:'disabled'}` is the value both Anthropic and DeepSeek
    // document for the instruction.
    const off = request({ messages: [TEXT_USER], reasoningEffort: ReasoningEffortId('off') })
    expect(serializeRequest(off, { thinkingBudgetTokens: 16_384 }, { reasoning: true }).thinking)
      .toEqual({ type: 'disabled' })
    // One-shot auxiliary callers never pay for thinking, and they say so too.
    const titled = serializeRequest(
      { ...off, reasoningEffort: ReasoningEffortId('high'), purpose: 'session-title' as const },
      { thinkingBudgetTokens: 16_384 },
      { reasoning: true },
    )
    expect(titled.thinking).toEqual({ type: 'disabled' })
    // A disabled model cannot carry an extended-thinking budget.
    const disabledModel = serializeRequest(off, { thinkingBudgetTokens: 16_384 }, { reasoning: false })
    expect(disabledModel.thinking).toBeUndefined()
  })

  it('enables thinking with the configured budget for reasoning models and drops temperature', () => {
    const options = request({ messages: [TEXT_USER], reasoningEffort: ReasoningEffortId('high'), temperature: 0.5 })
    const body = serializeRequest(options, { thinkingBudgetTokens: 16_384 }, { reasoning: true, maxTokens: 64_000 })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 })
    // The Messages API requires the default temperature while thinking is on.
    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBe(64_000)
    const low = serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('low') }, { thinkingBudgetTokens: 16_384 }, { reasoning: true })
    expect(low.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    const max = serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('max') }, { thinkingBudgetTokens: 16_384 }, { reasoning: true })
    expect(max.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 })
  })

  it('serializes tools with input_schema and replays assistant tool calls with unsigned reasoning as text', () => {
    const body = serializeRequest(request({
      messages: [
        TEXT_USER,
        createMessage({
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'secret thoughts' },
            { type: 'text', text: 'calling' },
            { type: 'tool-call', id: ToolCallId('call_1'), name: 'lookup', arguments: '{"q":"x"}' },
          ],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        createMessage({
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: ToolCallId('call_1'), content: [{ type: 'text', text: 'result' }] }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
      tools: [{ name: 'lookup', description: 'Find things', parameters: { type: 'object' } }],
    }))
    expect(body.tools).toEqual([{ name: 'lookup', description: 'Find things', input_schema: { type: 'object' } }])
    const assistant = body.messages.find(message => message.role === 'assistant') as { content: Array<{ type: string; text?: string; tool_use?: { id: string; name: string; input: unknown } }> }
    // Unsigned reasoning folds into plain text, ahead of the visible text.
    expect(assistant.content[0]).toEqual({ type: 'text', text: 'secret thoughts' })
    expect(assistant.content[1]).toEqual({ type: 'text', text: 'calling' })
    expect(assistant.content[2]).toEqual({ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } })
    const toolTurn = body.messages.at(-1) as { role: string; content: Array<{ type: string; tool_use_id: string; content: string }> }
    expect(toolTurn.role).toBe('user')
    expect(toolTurn.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_1', content: 'result' })
  })

  it('maps stop to stop_sequences on the wire', () => {
    const body = serializeRequest(request({ messages: [TEXT_USER], stop: ['END', 'STOP'] }))
    expect(body.stop_sequences).toEqual(['END', 'STOP'])
  })
})

describe('serializeRequestWithImages', () => {
  it('serializes user images as inline base64 sources', async () => {
    const ref = imageRef()
    const body = await serializeRequestWithImages(
      request({
        messages: [createUserMessage({
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', attachment: ref },
          ],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }),
      inlineImageOptions([ref]),
    )
    const user = body.messages.find(message => message.role === 'user') as { content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> }
    expect(Array.isArray(user.content)).toBe(true)
    const textPart = user.content.find(part => part.type === 'text')
    expect(textPart?.text).toContain('what is this')
    const imagePart = user.content.find(part => part.type === 'image')
    expect(imagePart?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' })
  })

  it('displaces tool-result images into a following user message', async () => {
    const ref = imageRef()
    const body = await serializeRequestWithImages(
      request({
        messages: [
          createMessage({
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: ToolCallId('call_9'), content: [{ type: 'image', attachment: ref }] },
            ],
            source: { kind: 'plugin', plugin: 'test' },
          }),
        ],
      }),
      inlineImageOptions([ref]),
    )
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_9', content: expect.stringContaining('Image sha256:') }],
    })
    const displaced = body.messages[1] as {
      role: string
      content: Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>
    }
    expect(displaced.content[0]).toEqual({ type: 'text', text: 'Attached image(s) from tool result:' })
    expect(displaced.content[1]?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' })
  })

  it('rejects image blocks in non-user roles', async () => {
    const ref = imageRef()
    await expect(serializeRequestWithImages(
      request({
        messages: [createMessage({
          role: 'assistant',
          content: [{ type: 'image', attachment: ref }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }),
      inlineImageOptions([ref]),
    )).rejects.toThrow(/cannot represent image content in an? assistant message/)
  })
})

describe('native media parts (documents)', () => {
  it('sends a PDF as the Messages document block with a base64 source', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-anthropic-media-'))
    writeFileSync(join(dir, 'doc.pdf'), '%PDF-1.4')
    const native = {
      attachments: { fileHostPath: () => join(dir, 'doc.pdf') },
      families: ['document'] as const,
      maxBytes: 20 * 1024 * 1024,
    }
    const body = await serializeRequestWithImages({
      provider: 'anthropic-compatible',
      model: 'claude-fable-5',
      system: 'be brief',
      messages: [createUserMessage({
        content: [{
          type: 'file',
          attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name: 'doc.pdf', bytes: 8 },
        }],
        source: { kind: 'user' },
      })],
    }, { requestImages: new Map(), maxRequestImageBytes: 1024 } as never, {}, undefined, native as never)
    // The one-shot system prompt rides the request's `system` field, not a part.
    expect(body.system).toBe('be brief')
    type Parts = { type: string; source?: { type: string; media_type: string; data: string } }[]
    const [message] = body.messages as unknown as [{ content: Parts }]
    expect(message.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
      },
    ])
  })
})
