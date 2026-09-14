/**
 * Translate Anthropic messages SSE frames into harness StreamChunks. Block
 * indexes are the wire's own `content_block` indexes; `block-end`, usage,
 * and finish are deferred to the `message_stop` sentinel so no chunk follows
 * `finish`. `signature_delta` is dropped — the harness reasoning block has
 * no signature carrier (parity with pi-ai's default unsigned replay).
 * @module dsh-llm-anthropic/translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SseFrame } from './sse.ts'
import type { WireEventData, WireUsage } from './types.ts'

/** One open block under assembly, keyed by the wire content_block index. */
interface OpenBlock {
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string | undefined
  name?: string | undefined
}

/**
 * Map the wire `stop_reason` vocabulary to the harness FinishReason
 * (evidence: pi-ai's mapStopReason — end_turn/max_tokens/tool_use plus
 * refusal and pause_turn handling).
 */
export function mapStopReason(
  reason: string,
  stopDetails?: { explanation?: string },
): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return { kind: 'stop' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'refusal':
      return {
        kind: 'error',
        failure: { message: stopDetails?.explanation ?? 'The model refused to complete the request', code: 'REFUSAL' },
      }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map the Messages API usage fields onto the harness's disjoint counts.
 * `input_tokens` EXCLUDES cache traffic; cache reads are surfaced separately
 * and cache-creation tokens are folded into the true total.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const reasoning = (usage as { output_tokens_details?: { thinking_tokens?: number } }).output_tokens_details?.thinking_tokens
  const total = input + output + cacheRead + cacheWrite
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Consume SSE frames (ending with `message_stop`) and yield StreamChunks.
 * A frame whose JSON parse fails aborts the stream with
 * `MALFORMED_RESPONSE`; an `error` event aborts with the server's message.
 */
export async function* translate(frames: AsyncIterable<SseFrame>): AsyncGenerator<StreamChunk> {
  let pendingUsage: TokenUsage | undefined
  let pendingFinish: FinishReason | undefined
  const open = new Map<number, OpenBlock>()
  const order: Array<{ index: number; block: OpenBlock }> = []

  function register(index: number, block: OpenBlock): void {
    open.set(index, block)
    order.push({ index, block })
  }

  for await (const frame of frames) {
    if (frame.event === 'message_stop') {
      for (const { index, block } of order) {
        let content: ContentBlock
        switch (block.kind) {
          case 'text':
            content = { type: 'text', text: block.text }
            break
          case 'reasoning':
            content = { type: 'reasoning', text: block.text }
            break
          case 'tool-call':
            content = {
              type: 'tool-call',
              id: brandString<ToolCallId>(block.callId ?? ''),
              name: block.name ?? '',
              arguments: block.text,
            }
            break
        }
        yield { type: 'block-end', index, block: content }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let event: WireEventData
    try {
      event = JSON.parse(frame.data) as WireEventData
    } catch {
      throw new LlmError(`malformed SSE payload: ${frame.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    if (event.type !== frame.event) {
      // Anthropic keeps `event:` and the payload's `type` in lockstep; a
      // divergence is a broken encoder, not a shape this adapter guesses at.
      throw new LlmError(`SSE event/frame type mismatch: ${frame.event} vs ${event.type}`, 'MALFORMED_RESPONSE')
    }

    switch (event.type) {
      // Frames ending here were already yielded by the message_stop check above.
      case 'message_stop':
        return
      case 'message_start': {
        if (event.message?.usage !== undefined) {
          pendingUsage = mapUsage(event.message.usage)
        }
        break
      }
      case 'content_block_start': {
        const described = event.content_block
        if (described.type === 'text') {
          register(event.index, { kind: 'text', text: described.text ?? '' })
          yield { type: 'block-start', index: event.index, blockType: 'text' }
        } else if (described.type === 'thinking') {
          register(event.index, { kind: 'reasoning', text: described.thinking ?? '' })
          yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
        } else if (described.type === 'redacted_thinking') {
          register(event.index, { kind: 'reasoning', text: '[Reasoning redacted]' })
          yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
        } else if (described.type === 'tool_use') {
          const callId = described.id ?? ''
          const callName = described.name ?? ''
          register(event.index, { kind: 'tool-call', text: '', callId, name: callName })
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: brandString<ToolCallId>(callId),
            ...callName.length > 0 ? { name: callName } : {},
            argumentsDelta: '',
          }
        }
        break
      }
      case 'content_block_delta': {
        const block = open.get(event.index)
        const delta = event.delta
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          if (block === undefined) {
            register(event.index, { kind: 'text', text: '' })
            yield { type: 'block-start', index: event.index, blockType: 'text' }
          }
          const target = open.get(event.index)
          if (target === undefined) throw new LlmError('text delta without a started block', 'MALFORMED_RESPONSE')
          target.text += delta.text
          yield { type: 'text-delta', index: event.index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          if (block === undefined) {
            register(event.index, { kind: 'reasoning', text: '' })
            yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
          }
          const target = open.get(event.index)
          if (target === undefined) throw new LlmError('thinking delta without a started block', 'MALFORMED_RESPONSE')
          target.text += delta.thinking
          yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
          if (block === undefined) throw new LlmError('tool-call delta without a started block', 'MALFORMED_RESPONSE')
          block.text += delta.partial_json
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: brandString<ToolCallId>(block.callId ?? ''),
            ...block.name !== undefined ? { name: block.name } : {},
            argumentsDelta: delta.partial_json,
          }
        }
        // signature_delta: dropped — the harness cannot carry signatures.
        break
      }
      case 'content_block_stop': {
        // Blocks close at message_stop (deferred), matching the OpenAI
        // adapter's deferred-assembly convention.
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason !== undefined) {
          pendingFinish = mapStopReason(event.delta.stop_reason)
        }
        if (event.usage !== undefined) {
          const merged: WireUsage = {}
          if (pendingUsage?.inputTokens !== undefined) merged.input_tokens = pendingUsage.inputTokens
          if (event.usage.output_tokens !== undefined) merged.output_tokens = event.usage.output_tokens
          if (pendingUsage?.cacheReadTokens !== undefined) merged.cache_read_input_tokens = pendingUsage.cacheReadTokens
          const thinking = event.usage.output_tokens_details?.thinking_tokens
          const detailed = thinking === undefined
            ? merged
            : { ...merged, output_tokens_details: { thinking_tokens: thinking } }
          pendingUsage = mapUsage(detailed)
        }
        break
      }
      case 'error': {
        throw new LlmError(
          event.error?.message ?? 'Anthropic stream reported an error',
          'SERVER',
        )
      }
      case 'ping':
        break
    }
  }

  throw new LlmError('SSE frame stream ended without message_stop', 'STREAM_CLOSED')
}
