/**
 * The vendor-private request extensions (`dsh_session_log`,
 * `dsh_plugin_packages`) are understood only by DeepSeek's own endpoint; a
 * compatible gateway refuses the whole request when it sees an unknown
 * top-level field. `isOfficialEndpoint` is the single decision the provider
 * consults, so its boundary is pinned here: the official origin however it is
 * spelled, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { isOfficialEndpoint, MESSAGES_BASE_URL, PUBLIC_BASE_URL } from '../src/config.ts'

describe('isOfficialEndpoint', () => {
  it('accepts the shipped roots', () => {
    expect(isOfficialEndpoint(PUBLIC_BASE_URL)).toBe(true)
    expect(isOfficialEndpoint(MESSAGES_BASE_URL)).toBe(true)
  })

  it('accepts spellings of the official origin that are still the same service', () => {
    // A trailing slash, an explicit default port, or a path suffix all resolve
    // to the same origin, and the route keeps working there.
    expect(isOfficialEndpoint('https://api.deepseek.com/')).toBe(true)
    expect(isOfficialEndpoint('https://api.deepseek.com:443')).toBe(true)
    expect(isOfficialEndpoint('https://api.deepseek.com/v1')).toBe(true)
    expect(isOfficialEndpoint('https://api.deepseek.com/anthropic/v1')).toBe(true)
  })

  it('rejects any other host, including lookalikes', () => {
    expect(isOfficialEndpoint('https://relay.example.com')).toBe(false)
    expect(isOfficialEndpoint('https://relay.example.com/v1')).toBe(false)
    // A host that merely ends in the official name is a different origin.
    expect(isOfficialEndpoint('https://api.deepseek.com.evil.test')).toBe(false)
    expect(isOfficialEndpoint('https://notapi.deepseek.com')).toBe(false)
    // A different port is a different origin even on the same name.
    expect(isOfficialEndpoint('https://api.deepseek.com:8443')).toBe(false)
  })

  it('rejects a non-HTTP scheme and an unparsable value', () => {
    expect(isOfficialEndpoint('file:///tmp/socket')).toBe(false)
    expect(isOfficialEndpoint('not a url')).toBe(false)
    expect(isOfficialEndpoint('')).toBe(false)
  })
})
