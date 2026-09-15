/**
 * Translate OpenAI Responses SSE payloads into harness StreamChunks. One
 * harness block tracks each output item, keyed by the item's `output_index`
 * so interleaved deltas land in order; `output_item.done` closes its block,
 * and the terminal `response.completed`/`response.incomplete` event carries
 * usage and the finish. Nothing follows `finish`. A stream ending before a
 * terminal event is truncation (`STREAM_CLOSED`), and a completed response
 * with no content is a degenerate completion (`EMPTY_RESPONSE`), both
 * matching the chat-completions route's contract.
 *
 * Event vocabulary and state handling follow pi-ai 0.85.1's
 * `processResponsesStream` (the reference this wire replaces); its
 * message-`phase` tracking is deliberately absent — the terminal response
 * status always overwrites the stop reason it could have set.
 *
 * @module dsh-llm-provider/responses-translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ResponsesEvent,
  ResponsesResponseSummary,
  ResponsesUsage,
} from './responses-types.ts'

/** One open harness block under assembly, addressed by its item's output index. */
interface OpenSlot {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  /** Accumulated text (visible, reasoning, or raw tool-call argument JSON). */
  text: string
  /** tool-call identity, established by the announcing item. */
  callId?: string
  itemId?: string
  name?: string
}

/**
 * Map wire usage to disjoint harness counts. `input_tokens` INCLUDES cached
 * reads and cache writes, so both subtract out of `inputTokens`; the exact
 * total is the recomputed sum, present only when both counters are valid.
 */
export function mapResponsesUsage(usage: ResponsesUsage): TokenUsage {
  const cacheRead = usage.input_tokens_details?.cached_tokens
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const inputTokens = Math.max(0, usage.input_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0))
  const outputTokens = usage.output_tokens
  const total = inputTokens + outputTokens
  const hasExactTotal = Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && Number.isSafeInteger(total)
  return {
    inputTokens,
    outputTokens,
    ...hasExactTotal ? { totalTokens: total } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Map the terminal response status onto the harness finish. */
export function mapResponsesStatus(
  response: ResponsesResponseSummary,
  sawToolCall: boolean,
): FinishReason {
  const status = response.status
  const incompleteReason = typeof response.incomplete_details?.reason === 'string'
    ? response.incomplete_details.reason
    : undefined
  let reason: FinishReason
  if (status === 'completed' || status === undefined) {
    reason = { kind: 'stop' }
  } else if (status === 'incomplete') {
    reason = incompleteReason === 'max_output_tokens'
      ? { kind: 'max-tokens' }
      : {
        kind: 'error',
        failure: {
          message: incompleteReason === undefined
            ? 'Response incomplete without a provider reason'
            : `Response incomplete: ${incompleteReason}`,
          code: 'INCOMPLETE_RESPONSE',
        },
      }
  } else {
    // failed / cancelled / in_progress / queued at the terminal event are all
    // failures or degenerate; the stream never completes as success here.
    reason = {
      kind: 'error',
      failure: { message: `Response ${status}`, code: (status ?? 'failed').toUpperCase() },
    }
  }
  // A completed response that produced tool calls ends as tool-calls.
  if (sawToolCall && reason.kind === 'stop') return { kind: 'tool-calls' }
  return reason
}

/**
 * Consume Responses SSE data payloads and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - JSON event payloads from {@link parseSse}, in arrival order.
 * @returns deltas as they arrive; each output item closes with its
 *   `block-end`; `usage` and `finish` appear only at the terminal event.
 */
export async function* translateResponses(
  payloads: AsyncIterable<string>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const slots = new Map<number, OpenSlot>()
  const order: OpenSlot[] = []
  let sawToolCall = false
  let sawTerminal = false

  const open = (kind: OpenSlot['kind']): OpenSlot => {
    const slot: OpenSlot = { index: nextIndex++, kind, text: '' }
    order.push(slot)
    return slot
  }

  /** Close one open slot into its assembled block. */
  const close = (slot: OpenSlot): ContentBlock => {
    if (slot.kind === 'tool-call') {
      return {
        type: 'tool-call',
        // The joint id restores both provider halves at replay time.
        id: brandString<ToolCallId>(`${slot.callId ?? ''}${slot.itemId === undefined ? '' : `|${slot.itemId}`}`),
        name: slot.name ?? '',
        arguments: slot.text,
      }
    }
    return slot.kind === 'text'
      ? { type: 'text', text: slot.text }
      : { type: 'reasoning', text: slot.text }
  }

  for await (const payload of payloads) {
    let event: ResponsesEvent
    try {
      event = JSON.parse(payload) as ResponsesEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item.type === 'message') {
          const slot = open('text')
          slots.set(event.output_index, slot)
          yield { type: 'block-start', index: slot.index, blockType: 'text' }
        } else if (item.type === 'reasoning') {
          const slot = open('reasoning')
          slots.set(event.output_index, slot)
          yield { type: 'block-start', index: slot.index, blockType: 'reasoning' }
        } else if (item.type === 'function_call') {
          const slot = open('tool-call')
          slot.callId = item.call_id ?? ''
          if (item.id !== undefined) slot.itemId = item.id
          if (item.name !== undefined) slot.name = item.name
          slots.set(event.output_index, slot)
          sawToolCall = true
          yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
        }
        break
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const slot = slots.get(event.output_index)
        if (slot?.kind !== 'text' || event.delta.length === 0) break
        slot.text += event.delta
        yield { type: 'text-delta', index: slot.index, text: event.delta }
        break
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const slot = slots.get(event.output_index)
        if (slot?.kind !== 'reasoning' || event.delta.length === 0) break
        slot.text += event.delta
        yield { type: 'reasoning-delta', index: slot.index, text: event.delta }
        break
      }
      case 'response.reasoning_summary_part.done': {
        // Summary parts join with a blank line, as the live delta stream spelled them.
        const slot = slots.get(event.output_index)
        if (slot?.kind !== 'reasoning') break
        slot.text += '\n\n'
        yield { type: 'reasoning-delta', index: slot.index, text: '\n\n' }
        break
      }
      case 'response.function_call_arguments.delta': {
        const slot = slots.get(event.output_index)
        if (slot?.kind !== 'tool-call' || event.delta.length === 0) break
        slot.text += event.delta
        yield {
          type: 'tool-call-delta',
          index: slot.index,
          id: brandString<ToolCallId>(`${slot.callId ?? ''}${slot.itemId === undefined ? '' : `|${slot.itemId}`}`),
          ...slot.name !== undefined ? { name: slot.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const slot = slots.get(event.output_index)
        if (slot?.kind !== 'tool-call' || typeof event.arguments !== 'string') break
        // The terminal arguments are authoritative; anything already emitted
        // beyond them is not repeated, anything missing is flushed now.
        if (event.arguments.startsWith(slot.text) && event.arguments.length > slot.text.length) {
          const delta = event.arguments.slice(slot.text.length)
          slot.text = event.arguments
          yield {
            type: 'tool-call-delta',
            index: slot.index,
            id: brandString<ToolCallId>(`${slot.callId ?? ''}${slot.itemId === undefined ? '' : `|${slot.itemId}`}`),
            ...slot.name !== undefined ? { name: slot.name } : {},
            argumentsDelta: delta,
          }
        } else if (!event.arguments.startsWith(slot.text)) {
          slot.text = event.arguments
        }
        break
      }
      case 'response.output_item.done': {
        const slot = slots.get(event.output_index)
        if (slot === undefined) break
        const item = event.item
        if (slot.kind === 'text' && item.type === 'message') {
          // The completed item's text is canonical: replace the accumulation
          // with the wire's own join (refusals included).
          slot.text = (item.content ?? [])
            .map(part => part.type === 'refusal' ? part.refusal ?? '' : part.text ?? '')
            .join('')
        } else if (slot.kind === 'reasoning' && item.type === 'reasoning') {
          const finalText = [
            (item.summary ?? []).map(part => part.text ?? '').join('\n\n'),
            (item.content ?? []).map(part => part.text ?? '').join('\n\n'),
          ].find(text => text.length > 0)
          if (finalText !== undefined) slot.text = finalText
        } else if (slot.kind === 'tool-call' && item.type === 'function_call') {
          if (typeof item.arguments === 'string' && item.arguments.length > 0) slot.text = item.arguments
        }
        slots.delete(event.output_index)
        yield { type: 'block-end', index: slot.index, block: close(slot) }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        sawTerminal = true
        // Items still open at the terminal event close in announcement order.
        for (const [outputIndex, slot] of [...slots.entries()]) {
          slots.delete(outputIndex)
          yield { type: 'block-end', index: slot.index, block: close(slot) }
        }
        if (event.response.usage !== undefined && event.response.usage !== null) {
          yield { type: 'usage', usage: mapResponsesUsage(event.response.usage) }
        }
        const reason = mapResponsesStatus(event.response, sawToolCall)
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
      case 'response.failed': {
        const error = event.response.error
        const details = event.response.incomplete_details?.reason
        throw new LlmError(
          error !== undefined && error !== null && (error.code !== undefined || error.message !== undefined)
            ? `${error.code ?? 'unknown'}: ${error.message ?? 'no message'}`
            : details !== undefined
              ? `incomplete: ${details}`
              : 'Response failed without error details',
          'SERVER',
        )
      }
      case 'error': {
        throw new LlmError(
          `Error Code ${event.code ?? 'unknown'}: ${event.message ?? 'no message'}`,
          'SERVER',
        )
      }
      default:
        // response.created / response.in_progress and unknown future events
        // carry no consumer-visible state.
        break
    }
  }

  // The framer passes everything through; reaching the end without a
  // terminal event is truncation.
  if (!sawTerminal) {
    throw new LlmError('Responses stream ended before a terminal response event', 'STREAM_CLOSED')
  }
}
