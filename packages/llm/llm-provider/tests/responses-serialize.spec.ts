import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeResponsesRequest, serializeResponsesRequestWithImages, splitToolCallId } from '../src/responses-serialize.ts'

/** One text-only user message, the minimal request seed. */
function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A request seed: the base fields every case shares. */
function base(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai-compatible',
    model: 'gpt-5-turbo',
    messages: [user('hi')],
    ...overrides,
  }
}

/** The effort ids the wire vocabulary accepts, branded as GenerateOptions carries them. */
const effort = (value: 'off' | 'low' | 'high' | 'max') => ReasoningEffortId(value)

describe('serializeResponsesRequest: request fields', () => {
  it('posts a stateless streaming request with the model and input', () => {
    const body = serializeResponsesRequest(base())
    expect(body).toMatchObject({ model: 'gpt-5-turbo', stream: true, store: false })
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('temperature')
  })

  it('lifts an output cap below the API floor up to it', () => {
    expect(serializeResponsesRequest(base({ maxTokens: 8 })).max_output_tokens).toBe(16)
    expect(serializeResponsesRequest(base({ maxTokens: 999 })).max_output_tokens).toBe(999)
  })

  it('sends stop sequences nowhere: the wire has no stop field', () => {
    const body = serializeResponsesRequest(base({ stop: ['END'] }))
    expect(body).not.toHaveProperty('stop')
  })

  it('maps reasoning efforts: max to high, off to explicit none, absent to nothing', () => {
    const reasoningModel = { reasoning: true }
    expect(serializeResponsesRequest(base({ reasoningEffort: effort('max') }), {}, reasoningModel).reasoning).toEqual({ effort: 'high' })
    expect(serializeResponsesRequest(base({ reasoningEffort: effort('low') }), {}, reasoningModel).reasoning).toEqual({ effort: 'low' })
    expect(serializeResponsesRequest(base({ reasoningEffort: effort('off') }), {}, reasoningModel).reasoning).toEqual({ effort: 'none' })
    expect(serializeResponsesRequest(base(), {}, reasoningModel).reasoning).toBeUndefined()
    // A non-reasoning model carries no reasoning field at any effort.
    expect(serializeResponsesRequest(base({ reasoningEffort: effort('high') }), {}, { reasoning: false }).reasoning).toBeUndefined()
    // Session titles suppress reasoning the same way the completions route does.
    expect(serializeResponsesRequest(base({ purpose: 'session-title', reasoningEffort: effort('high') }), {}, reasoningModel).reasoning).toBeUndefined()
  })

  it('converts tools to the flat Responses function shape', () => {
    const body = serializeResponsesRequest(base({
      tools: [{ name: 'get_weather', description: 'Reads the weather.', parameters: { type: 'object' } }],
    }))
    expect(body.tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'Reads the weather.', parameters: { type: 'object' } },
    ])
  })
})

describe('serializeResponsesRequest: system prompt', () => {
  it('prepends a system-role message for a non-reasoning model', () => {
    const body = serializeResponsesRequest(base({ system: 'be brief' }))
    expect(body.input[0]).toEqual({ role: 'system', content: 'be brief' })
  })

  it('prepends the same system-role message for a reasoning model', () => {
    // OpenAI prefers `developer` here, and this wire used it first. It is not
    // the safe spelling: DeepSeek documents `developer` as equivalent to
    // **user**, so a `developer` system prompt would arrive as user speech on
    // that route. `system` is read as instructions by both.
    const body = serializeResponsesRequest(base({ system: 'be brief' }), {}, { reasoning: true })
    expect(body.input[0]).toEqual({ role: 'system', content: 'be brief' })
  })

  it('never sends a developer-role item, whatever the model declares', () => {
    for (const model of [{ reasoning: true }, { reasoning: false }, undefined]) {
      const body = serializeResponsesRequest(base({ system: 'be brief' }), {}, model)
      expect(body.input[0]).toEqual({ role: 'system', content: 'be brief' })
      expect(JSON.stringify(body)).not.toContain('developer')
    }
  })
})

describe('serializeResponsesRequest: replay', () => {
  it('replays assistant text as a completed output message with a deterministic id', () => {
    const body = serializeResponsesRequest(base({
      messages: [
        user('hi'),
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } as Message,
        user('again'),
      ],
    }))
    expect(body.input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
      status: 'completed',
      id: 'msg_pi_0',
    })
  })

  it('replays a streamed tool call as function_call with both provider ids restored', () => {
    const body = serializeResponsesRequest(base({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1|fc_77', name: 'get', arguments: '{"a":1}' }] } as Message,
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1|fc_77', content: [{ type: 'text', text: 'sunny' }] }],
        } as Message,
      ],
    }))
    expect(body.input[0]).toEqual({
      type: 'function_call',
      id: 'fc_77',
      call_id: 'call_1',
      name: 'get',
      arguments: '{"a":1}',
    })
    expect(body.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'sunny',
    })
  })

  it('omits the item id for a call whose id came from another protocol', () => {
    const body = serializeResponsesRequest(base({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_legacy', name: 'get', arguments: '{}' }] } as Message,
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_legacy', content: [{ type: 'text', text: 'ok' }] }],
        } as Message,
      ],
    }))
    expect(body.input[0]).toEqual({ type: 'function_call', call_id: 'call_legacy', name: 'get', arguments: '{}' })
  })

  it('substitutes text for an empty tool result instead of sending nothing', () => {
    const body = serializeResponsesRequest(base({
      messages: [
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [] }] } as unknown as Message,
      ],
    }))
    expect(body.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: '(no tool output)' }])
  })

  it('refuses image content in the text-only path instead of dropping it', () => {
    expect(() => serializeResponsesRequest(base({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } as never }],
      } as unknown as Message],
    }))).toThrow(LlmError)
  })
})

describe('serializeResponsesRequestWithImages', () => {
  const images = {
    requestImages: new Map([['a1', {
      attachmentId: 'a1',
      mediaType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
      bytes: 4,
      width: 2,
      height: 2,
    }]]),
    maxRequestImageBytes: 1024,
  } as unknown as Parameters<typeof serializeResponsesRequestWithImages>[1]

  it('represents user images as inline input_image parts after a text handle', async () => {
    const body = await serializeResponsesRequestWithImages(base({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } as never }],
      } as unknown as Message],
    }), images)
    const first = body.input[0] as { role: string; content: { type: string; text?: string; image_url?: string }[] }
    expect(first.role).toBe('user')
    expect(first.content).toHaveLength(2)
    expect(first.content[0]!.type).toBe('input_text')
    expect(first.content[1]).toMatchObject({ type: 'input_image', detail: 'auto' })
    expect(String(first.content[1]!.image_url)).toMatch(/^data:image\/png;base64,/)
  })

  it('refuses image content in a non-user message', async () => {
    await expect(serializeResponsesRequestWithImages(base({
      messages: [{
        role: 'assistant',
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } as never }],
      } as unknown as Message],
    }), images)).rejects.toThrow(/cannot represent image content in a assistant message/)
  })
})

describe('splitToolCallId', () => {
  it('splits the streamed joint id and leaves bare ids whole', () => {
    expect(splitToolCallId('call_1|fc_77')).toEqual({ callId: 'call_1', itemId: 'fc_77' })
    expect(splitToolCallId('call_1')).toEqual({ callId: 'call_1' })
  })
})

describe('native media parts (documents)', () => {
  const pdf: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`),
    name: 'doc.pdf',
    bytes: 8,
  }
  const images = {
    requestImages: new Map(),
    maxRequestImageBytes: 1024,
  } as unknown as Parameters<typeof serializeResponsesRequestWithImages>[1]

  it('sends a document as the Responses input_file part with a base64 Data URL', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-responses-media-'))
    writeFileSync(join(dir, 'doc.pdf'), '%PDF-1.4')
    const native = {
      attachments: { fileHostPath: () => join(dir, 'doc.pdf') },
      families: ['document'] as const,
      maxBytes: 20 * 1024 * 1024,
    }
    const body = await serializeResponsesRequestWithImages(base({ messages: [createUserMessage({
      content: [{ type: 'file', attachment: pdf } as never],
      source: { kind: 'user' },
    })] }), images as never, {}, undefined, native as never)
    const first = body.input[0] as { role: string; content: { type: string; file_data?: string; filename?: string }[] }
    expect(first.content).toHaveLength(1)
    expect(first.content[0]).toMatchObject({
      type: 'input_file',
      filename: 'doc.pdf',
    })
    expect(String(first.content[0]!.file_data)).toMatch(/^data:application\/pdf;base64,/)
  })
})
