/**
 * Quantized resize scheduling for expensive-to-resample content (huge
 * images, PDF canvases). Dragging the sidebar's divider changes the pane's
 * width every frame; re-sampling megapixel content per frame janks the drag.
 * The scheduler applies at most once per interval while changes stream in,
 * then always lands one final settle shortly after they stop.
 */
export const RESAMPLE_INTERVAL_MS = 120
export const RESAMPLE_SETTLE_MS = 150

/** A scheduled resample gate; `schedule()` per resize callback. */
export interface ResampleScheduler {
  readonly schedule: () => void
  readonly dispose: () => void
}

/**
 * Build a scheduler around one apply step. The first schedule applies
 * immediately; later ones are quantized to the interval with a trailing
 * settle, so continuous drags step at a coarse cadence and end exact. An
 * apply that reports `false` (nothing to apply yet) does not consume the
 * interval, so a degenerate read at mount never starves the first real one.
 */
export function createResampleScheduler(apply: () => boolean | void): ResampleScheduler {
  let lastApplied = 0
  let settle: number | undefined
  return {
    schedule: () => {
      if (performance.now() - lastApplied >= RESAMPLE_INTERVAL_MS && apply() !== false) {
        lastApplied = performance.now()
      }
      // globalThis keeps the gate usable from node-environment specs too.
      globalThis.clearTimeout(settle)
      settle = globalThis.setTimeout(() => {
        if (apply() !== false) lastApplied = performance.now()
      }, RESAMPLE_SETTLE_MS)
    },
    dispose: () => { globalThis.clearTimeout(settle) },
  }
}
