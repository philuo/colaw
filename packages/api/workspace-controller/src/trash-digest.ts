/**
 * Trash-preview projection: one archived session's stored event log reduced
 * to the display title plus a bounded markdown digest of its leading
 * messages. Host-side by design — the trash page gets one complete payload
 * per entry and never needs live-session plumbing for a cold, read-only
 * preview.
 *
 * @module @deepseek-ai/dsh-api-workspace-controller/src/trash-digest
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Most messages a digest carries; enough to recognize a conversation. */
const DIGEST_MAX_MESSAGES = 20

/** Hard byte ceiling for the digest, title excluded. */
const DIGEST_MAX_CHARS = 8_000

/**
 * Text blocks of one message-shaped content array, concatenated.
 * @param content - Content blocks as the event log stores them.
 * @returns the concatenated text of `text` blocks; undefined when none.
 */
function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text') {
      const chunk = (block as { text?: unknown }).text
      if (typeof chunk === 'string') text += chunk
    }
  }
  return text === '' ? undefined : text
}

/**
 * Reduce one stored event log to the trash preview.
 * @param events - Every durable event of the archived session, in log order.
 * @returns the last stored title and the leading user/assistant message
 * texts as markdown, each within the stated bounds.
 */
export function trashDigest(events: readonly SessionEvent[]): { title?: string, digest?: string } {
  let title: string | undefined
  const messages: string[] = []
  for (const event of events) {
    const data = (event as { data?: unknown }).data
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>
    if ((event.type as string) === 'session/title' && typeof record['title'] === 'string' && record['title'] !== '') {
      title = record['title']
      continue
    }
    if (messages.length >= DIGEST_MAX_MESSAGES) continue
    if (event.type === 'user/message') {
      const text = textOf(record['content'])
      if (text !== undefined) messages.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const message = record['message']
      const text = typeof message === 'object' && message !== null
        ? textOf((message as Record<string, unknown>)['content'])
        : undefined
      if (text !== undefined) messages.push(text)
    }
  }
  let digest: string | undefined
  if (messages.length > 0) {
    let joined = ''
    for (const message of messages) {
      const candidate = joined === '' ? message : `${joined}\n\n---\n\n${message}`
      if (candidate.length > DIGEST_MAX_CHARS) {
        joined = joined === '' ? `${candidate.slice(0, DIGEST_MAX_CHARS)}…` : joined
        break
      }
      joined = candidate
    }
    digest = joined
  }
  return { ...(title === undefined ? {} : { title }), ...(digest === undefined ? {} : { digest }) }
}
