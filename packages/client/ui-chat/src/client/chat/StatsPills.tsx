// Session stats as a section of the composer context meter's open panel (the
// 'conversation.composer.contextPanel' slot): two groups in the panel's row
// skin — session time and output speed, then the durable token usage with its
// cache-hit share. Every figure rides the durable sessionStats projection (an
// assembly without that unit falls back to the window-scoped fold below), so
// paging and compaction cannot change any of them.

import { memo, useMemo } from 'react'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from '../contract/turn-metrics.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import css from './StatsPills.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ChatSnapshot['legacy']['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @param t - Chat locale seat with the duration templates.
 * @returns display string.
 */
export function formatDuration(ms: number, t: ChatViewSlotProps['t']): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface ComposerStatsPanelProps {
  useChat: SnapshotSelectorHook<ChatSnapshot>
  useProjection: UseProjection
  /** The owning panel's locale seat. */
  t: ChatViewSlotProps['t']
}

function exactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/** One panel fact row; the dl pairs mirror the context meter's own rows. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={css.row}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** Session time and output speed, titled by the running turn counts. */
function TimeGroup({ stats, t }: { stats: WindowStats; t: ComposerStatsPanelProps['t'] }) {
  const tps = stats.decodeMs > 0
    ? t('message.tokensPerSecond', {
      tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
    })
    : null
  return (
    <section className={css.group}>
      <div className={css.groupTitle}>
        <IconGaugeOutline16 />
        {t('stats.dialog.title')}
        <span className={css.groupValue}>
          {t('stats.counts', { turns: stats.turns, steps: stats.steps })}
        </span>
      </div>
      <dl className={css.rows}>
        {stats.llmMs > 0 && (
          <Row label={t('stats.dialog.llmTime')} value={formatDuration(stats.llmMs, t)} />
        )}
        {stats.toolMs > 0 && (
          <Row label={t('stats.dialog.toolTime')} value={formatDuration(stats.toolMs, t)} />
        )}
        {stats.ttftSteps > 0 && (
          <Row
            label={t('stats.dialog.ttft')}
            value={formatDuration(stats.ttftMs / stats.ttftSteps, t)}
          />
        )}
        {tps !== null && <Row label={t('stats.dialog.speed')} value={tps} />}
      </dl>
    </section>
  )
}

/** Durable token usage: the billing buckets plus their cache-hit share. */
function UsageGroup({ usage, t }: { usage: TokenUsageProjection; t: ComposerStatsPanelProps['t'] }) {
  const total = billedInputTokens(usage) + usage.outputTokens
  const cacheHit = cacheHitPercent(usage)
  return (
    <section className={css.group}>
      <div className={css.groupTitle}>
        <IconDatabaseOutline16 />
        {t('stats.dialog.usageTitle')}
        <span className={css.groupValue}>
          {t('message.turnUsage.count', { count: formatTokens(total, t) })}
        </span>
      </div>
      {/* jscpd:ignore-start -- the session-total bucket rows deliberately mirror
          TurnUsagePanel's per-turn dl: same skin, different data contract (the
          buckets are always present here; per-turn fields are optional). A
          session that never wrote cache drops the row, as the per-turn panel
          drops its absent fields. */}
      <dl className={css.rows}>
        {cacheHit !== null && <Row label={t('message.turnUsage.cacheHit')} value={`${cacheHit}%`} />}
        <Row label={t('message.turnUsage.input')} value={exactCount(usage.uncachedInputTokens, t)} />
        <Row label={t('message.turnUsage.cacheRead')} value={exactCount(usage.cacheReadTokens, t)} />
        {usage.cacheWriteTokens !== 0 && (
          <Row label={t('message.turnUsage.cacheWrite')} value={exactCount(usage.cacheWriteTokens, t)} />
        )}
        <Row label={t('message.turnUsage.output')} value={exactCount(usage.outputTokens, t)} />
      </dl>
      {/* jscpd:ignore-end */}
    </section>
  )
}

/**
 * The stats section the context meter's panel hosts: absent while the session
 * has neither a timed step nor billed tokens.
 * @param props - the session standard kit seats the section reads.
 * @returns the stats section, or nothing.
 */
export const ComposerStatsPanel = memo(function ComposerStatsPanel({
  useChat, useProjection, t,
}: ComposerStatsPanelProps) {
  const settledNodes = useChat(s => s.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows the time group without a usage
  // group.
  const hasTokens = usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (stats.steps === 0 && !hasTokens) return null
  return (
    <div className={css.section}>
      {stats.steps > 0 && <TimeGroup stats={stats} t={t} />}
      {usage !== undefined && hasTokens && <UsageGroup usage={usage} t={t} />}
    </div>
  )
})
