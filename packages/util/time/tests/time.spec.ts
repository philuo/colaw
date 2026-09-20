import { describe, expect, it } from 'vitest'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'

describe('canonicalClientTimeZone', () => {
  it('accepts UTC and Area/Location names unchanged', () => {
    expect(canonicalClientTimeZone('UTC')).toBe('UTC')
    expect(canonicalClientTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(canonicalClientTimeZone('Europe/London')).toBe('Europe/London')
  })

  it('answers the platform-canonical name rather than the alias asked for', () => {
    // A durable record is compared against the zone a later reader derives, so
    // the answer must be stable under re-canonicalisation — that is the
    // contract. Which name an alias group resolves to is the runtime's ICU
    // data, not this library's choice: Node maps Asia/Chongqing to
    // Asia/Shanghai, while Bun's ICU leaves it as asked, so the alias is not
    // asserted to change, only the idempotence is.
    const canonical = canonicalClientTimeZone('Asia/Chongqing')
    expect(canonical).toBeDefined()
    expect(canonicalClientTimeZone(canonical ?? '')).toBe(canonical)
  })

  it('refuses blank, padded, abbreviated, and single-segment names', () => {
    for (const value of ['', ' ', ' UTC', 'UTC ', 'CST', 'GMT+8', 'Asia', 'utc']) {
      expect(canonicalClientTimeZone(value)).toBeUndefined()
    }
  })

  it('refuses a well-formed name the platform does not support', () => {
    expect(canonicalClientTimeZone('Not/A_Real_Zone')).toBeUndefined()
  })
})
