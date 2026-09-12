/** The quantized resample gate that keeps sidebar drags off the resample path. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESAMPLE_INTERVAL_MS, RESAMPLE_SETTLE_MS, createResampleScheduler } from '../src/client/resample.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('createResampleScheduler', () => {
  it('applies the first schedule immediately, quantizes the stream, settles the tail', async () => {
    const apply = vi.fn()
    const scheduler = createResampleScheduler(apply)
    try {
      // The first schedule lands at once.
      scheduler.schedule()
      expect(apply).toHaveBeenCalledTimes(1)
      // A burst of frames inside the interval applies nothing more...
      for (let frame = 0; frame < 10; frame += 1) scheduler.schedule()
      expect(apply).toHaveBeenCalledTimes(1)
      // ...and the trailing settle lands one final apply.
      await new Promise(resolve => setTimeout(resolve, RESAMPLE_SETTLE_MS + 60))
      expect(apply).toHaveBeenCalledTimes(2)
    } finally {
      scheduler.dispose()
    }
  })

  it('re-opens the interval once enough time has passed', async () => {
    const apply = vi.fn()
    const scheduler = createResampleScheduler(apply)
    try {
      scheduler.schedule()
      await new Promise(resolve => setTimeout(resolve, RESAMPLE_INTERVAL_MS + RESAMPLE_SETTLE_MS + 60))
      scheduler.schedule()
      expect(apply).toHaveBeenCalledTimes(3) // first, settle, and the re-opened apply
    } finally {
      scheduler.dispose()
    }
  })

  it('dispose cancels a pending settle', async () => {
    const apply = vi.fn()
    const scheduler = createResampleScheduler(apply)
    scheduler.schedule()
    scheduler.dispose()
    await new Promise(resolve => setTimeout(resolve, RESAMPLE_SETTLE_MS + 60))
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
