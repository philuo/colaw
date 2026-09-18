/**
 * Translate DeepSeek Responses events into harness stream chunks.
 *
 * This wire streams *semantic* events rather than deltas on a message object,
 * and it has no `[DONE]`: a stream ends with `response.completed`,
 * `response.incomplete` or `response.failed`. That makes the terminal event the
 * only proof a response finished, so an EOF without one is a truncated call and
 * is raised as `STREAM_CLOSED` instead of being reported as a stop — the
 * failure mode a vendor that simply closes the socket would otherwise hide.
 *
 * Reasoning text is streamed for display but never replayed: DeepSeek folds
 * plain-text reasoning into the adjacent assistant message and supports neither
 * `summary` nor `encrypted_content`, so there is nothing to hand back on the
 * next turn and `replayState` is intentionally absent.
 *
 * @module dsh-llm-deepseek/openai-responses-translate
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { WireResponse, WireStreamEvent, WireUsage } from './types.ts'

/** One block being accumulated, in provider order. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only, absent until a delta carries a non-empty value. */
  callId?: string | undefined
  name?: string | undefined
}

/**
 * Map the wire's usage object onto the harness's disjoint counters.
 *
 * `inputTokens` counts uncached input only, so the cached share is subtracted
 * out of `input_tokens` when the provider folded it in — which is what
 * DeepSeek's counts do.
 * @param usage - the terminal event's usage object.
 * @returns the harness token accounting.
 */
export function mapResponsesUsage(usage: WireUsage): TokenUsage {
  const input = usage.input_tokens
  const output = usage.output_tokens
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const hasInput = Number.isSafeInteger(input) && (input ?? 0) >= 0
  const hasOutput = Number.isSafeInteger(output) && (output ?? 0) >= 0
  const cacheRead: number | undefined = typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0
    ? cached
    : undefined
  const reasoningTokens: number | undefined = typeof reasoning === 'number'
      && Number.isSafeInteger(reasoning) && reasoning >= 0 ? reasoning : undefined
  const uncached = hasInput ? (input ?? 0) - (cacheRead ?? 0) : undefined
  const total = hasInput && hasOutput ? (input ?? 0) + (output ?? 0) : undefined
  return {
    inputTokens: uncached !== undefined && uncached >= 0 ? uncached : 0,
    outputTokens: hasOutput ? output ?? 0 : 0,
    ...total === undefined ? {} : { totalTokens: total },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/**
 * Map the terminal event onto a finish reason.
 * @param response - the `response` object carried by the terminal event.
 * @param sawToolCall - whether any function call was streamed in this response.
 * @returns the finish reason.
 */
export function mapResponsesFinish(response: WireResponse, sawToolCall: boolean): FinishReason {
  const status = response.status ?? 'completed'
  if (status === 'failed') {
    return {
      kind: 'error',
      failure: {
        code: response.error?.code ?? 'PROVIDER_ERROR',
        message: response.error?.message ?? 'The provider reported a failed response',
      },
    }
  }
  if (status === 'incomplete' || response.incomplete_details !== undefined) {
    return { kind: 'max-tokens' }
  }
  // A response that streamed a function call ended to hand control back; one
  // that did not is a plain stop.
  return sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
}

/** Whether an output item is one this translator opens a block for. */
function blockKind(item: { type?: string } | undefined): OpenBlock['kind'] | undefined {
  if (item?.type === 'reasoning') return 'reasoning'
  if (item?.type === 'message') return 'text'
  if (item?.type === 'function_call') return 'tool-call'
  return undefined
}

/**
 * Translate a Responses event stream into harness chunks.
 *
 * @param payloads - each event's JSON payload, in arrival order.
 * @returns block-start / delta / block-end chunks, then usage and finish.
 * @throws `LlmError('STREAM_CLOSED')` when the stream ends without a terminal event,
 *   and `LlmError('MALFORMED_RESPONSE')` for a payload that is not an object.
 */
export async function* translateResponses(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const open = new Map<string, OpenBlock>()
  /**
   * The open block a delta belongs to: by the wire's own `item_id` when it
   * carries one, otherwise the single open block of that kind. Routing by kind
   * alone would be wrong the moment two items of the same kind overlap.
   */
  const route = (event: WireStreamEvent, kind: OpenBlock['kind']): OpenBlock | undefined =>
    event.item_id === undefined
      ? [...open.values()].find(candidate => candidate.kind === kind)
      : open.get(event.item_id)
  let sawToolCall = false
  let terminal: WireResponse | undefined

  /** Close whichever block an item id refers to, emitting its final block. */
  function* close(itemId: string): Generator<StreamChunk> {
    const block = open.get(itemId)
    if (block === undefined) return
    open.delete(itemId)
    if (block.kind === 'tool-call') {
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: (block.callId ?? '') as ToolCallId,
          name: block.name ?? '',
          arguments: block.text,
        },
      }
      return
    }
    yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
  }

  for await (const payload of payloads) {
    let event: WireStreamEvent
    try {
      event = JSON.parse(payload) as WireStreamEvent
    } catch (error) {
      throw new LlmError(
        `DeepSeek Responses sent an unparseable event: ${error instanceof Error ? error.message : String(error)}`,
        'MALFORMED_RESPONSE',
      )
    }
    switch (event.type) {
      case 'response.output_item.added': {
        const kind = blockKind(event.item)
        if (kind === undefined || event.item?.id === undefined) break
        const block: OpenBlock = {
          index: nextIndex++,
          kind,
          text: '',
          ...event.item.call_id === undefined ? {} : { callId: event.item.call_id },
          ...event.item.name === undefined ? {} : { name: event.item.name },
        }
        open.set(event.item.id, block)
        if (kind === 'tool-call') sawToolCall = true
        // The block begins here: this wire announces items rather than
        // discovering them from content, so the start is the announcement.
        yield { type: 'block-start', index: block.index, blockType: kind }
        break
      }
      case 'response.output_text.delta':
      case 'response.reasoning_text.delta': {
        if (event.delta === undefined || event.delta.length === 0) break
        const kind = event.type === 'response.output_text.delta' ? 'text' : 'reasoning'
        const block = route(event, kind)
        if (block === undefined) break
        block.text += event.delta
        yield kind === 'text'
          ? { type: 'text-delta', index: block.index, text: event.delta }
          : { type: 'reasoning-delta', index: block.index, text: event.delta }
        break
      }
      case 'response.function_call_arguments.delta': {
        if (event.delta === undefined) break
        const block = route(event, 'tool-call')
        if (block === undefined) break
        block.text += event.delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: (block.callId ?? '') as ToolCallId,
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: event.delta,
        }
        break
      }
      case 'response.output_item.done': {
        if (event.item?.id === undefined) break
        yield* close(event.item.id)
        break
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        terminal = event.response ?? {}
        break
      }
      default:
        // response.created / in_progress / content_part.* / custom_tool_call_*:
        // nothing this translator has to emit.
        break
    }
  }

  if (terminal === undefined) {
    throw new LlmError(
      'DeepSeek Responses stream ended without a terminal event',
      'STREAM_CLOSED',
    )
  }
  if (terminal.usage !== undefined) yield { type: 'usage', usage: mapResponsesUsage(terminal.usage) }
  yield { type: 'finish', reason: mapResponsesFinish(terminal, sawToolCall) }
}
