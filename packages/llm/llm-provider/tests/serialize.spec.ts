import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest, serializeRequestWithImages } from '../src/serialize.ts'
import type { ImageSerializationOptions } from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'openai', model: 'gpt-4o', messages: [], ...overrides }
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

describe('serializeRequest', () => {
  it('always streams with usage reporting and carries no DeepSeek thinking fields', () => {
    const body = serializeRequest(request({ messages: [TEXT_USER] }))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body).not.toHaveProperty('thinking')
    expect(JSON.stringify(body)).not.toContain('reasoning_content')
  })

  it('maps a leading system option to a leading system message', () => {
    const body = serializeRequest(request({ system: 'be brief', messages: [TEXT_USER] }))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('omits reasoning_effort for non-reasoning models, unknown models, and off effort', () => {
    const options = request({ messages: [TEXT_USER], reasoningEffort: ReasoningEffortId('high') })
    expect(serializeRequest(options, {}, { reasoning: false }).reasoning_effort).toBeUndefined()
    expect(serializeRequest(options, {}, undefined).reasoning_effort).toBeUndefined()
    expect(serializeRequest(request({ messages: [TEXT_USER], reasoningEffort: ReasoningEffortId('off') }), {}, { reasoning: true }).reasoning_effort).toBeUndefined()
  })

  it('sends reasoning_effort only for reasoning models, mapping max to high', () => {
    const options = request({ messages: [TEXT_USER] })
    expect(serializeRequest(options, { reasoningEffort: 'high' }, { reasoning: true }).reasoning_effort).toBe('high')
    expect(serializeRequest(options, {}, { reasoning: true }).reasoning_effort).toBeUndefined()
    const explicit = serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('max') }, {}, { reasoning: true })
    expect(explicit.reasoning_effort).toBe('high')
    // Auxiliary one-shot purposes carry no effort, mirroring the DeepSeek session-title policy.
    const titled = serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('high'), purpose: 'session-title' as const }, {}, { reasoning: true })
    expect(titled.reasoning_effort).toBeUndefined()
  })

  it('defaults the output-cap field to max_tokens and honors the profile override', () => {
    const options = request({ messages: [TEXT_USER], maxTokens: 1234 })
    expect(serializeRequest(options).max_tokens).toBe(1234)
    expect(serializeRequest(options).max_completion_tokens).toBeUndefined()
    const newer = serializeRequest(options, { maxTokensField: 'max_completion_tokens' })
    expect(newer.max_completion_tokens).toBe(1234)
    expect(newer.max_tokens).toBeUndefined()
    // No configured cap and no request cap: neither field is sent.
    const uncapped = serializeRequest(request({ messages: [TEXT_USER] }))
    expect(uncapped.max_tokens).toBeUndefined()
    expect(uncapped.max_completion_tokens).toBeUndefined()
  })

  it('serializes tool schemas and replays assistant tool calls without reasoning passback', () => {
    const body = serializeRequest(request({
      messages: [
        TEXT_USER,
        createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'reasoning', text: 'secret thoughts' },
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
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'Find things', parameters: { type: 'object' } } }])
    const assistant = body.messages.find(message => message.role === 'assistant')
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'calling',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    })
    const tool = body.messages.find(message => message.role === 'tool')
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result' })
  })
})

describe('serializeRequestWithImages', () => {
  it('serializes user images as inline base64 data URLs', async () => {
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
    const user = body.messages.find(message => message.role === 'user') as { content: Array<{ type: string; text?: string; image_url?: { url: string } }> }
    expect(Array.isArray(user.content)).toBe(true)
    const textPart = user.content.find(part => part.type === 'text')
    expect(textPart?.text).toContain('what is this')
    const imagePart = user.content.find(part => part.type === 'image_url')
    expect(imagePart?.image_url?.url).toBe('data:image/png;base64,AAAA')
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
