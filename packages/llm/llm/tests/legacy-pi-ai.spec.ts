import { describe, expect, it } from 'vitest'
import { LEGACY_NS, convertLegacyPiAiProfile, convertLegacyPiAiModels, migrateLegacyPiAiProfiles } from '../src/legacy-pi-ai.ts'
import type { LegacyMigrationSettings, LegacyPiAiProfile } from '../src/legacy-pi-ai.ts'

/** A scripted settings double recording update() calls. */
function fakeSettings(doc: Record<string, unknown>): LegacyMigrationSettings & { updates: { ns: string; patch: object }[] } {
  return {
    updates: [],
    rawSection(ns: string) {
      return structuredClone(doc[ns]) as Record<string, unknown> | undefined
    },
    async update(ns: string, patch: object) {
      this.updates.push({ ns, patch })
    },
  }
}

function profile(overrides: Partial<LegacyPiAiProfile> = {}): LegacyPiAiProfile {
  return {
    api: 'openai-completions',
    displayName: 'Acme',
    baseURL: 'https://acme.example/v1',
    models: [{ id: 'acme-large', name: 'Acme Large', input: ['text', 'image'], contextWindow: 65536, maxTokens: 4096 }],
    ...overrides,
  }
}

describe('convertLegacyPiAiProfile', () => {
  it('maps the pi-ai vocabulary onto the replacement shape', () => {
    expect(convertLegacyPiAiProfile(profile(), { api: 'openai-completions' })).toEqual({
      api: 'openai-completions',
      displayName: 'Acme',
      baseURL: 'https://acme.example/v1',
      models: [{ id: 'acme-large', name: 'Acme Large', inputModalities: ['text', 'image'], contextWindow: 65536, maxTokens: 4096 }],
    })
  })

  it('records the requested protocol verbatim, including for a profile that named none', () => {
    const converted = convertLegacyPiAiProfile(profile({ api: undefined, displayName: undefined }), { api: 'openai-completions' })
    expect(converted).toMatchObject({ api: 'openai-completions' })
    expect(converted).not.toHaveProperty('displayName')
  })

  it('omits the api field entirely when the target schema has none', () => {
    const converted = convertLegacyPiAiProfile(profile({ api: 'anthropic-messages' }))
    expect(converted).not.toHaveProperty('api')
    expect(converted).toMatchObject({ baseURL: 'https://acme.example/v1' })
  })

  it('drops pi-ai-only fields instead of guessing at equivalents', () => {
    const converted = convertLegacyPiAiProfile(profile({
      compat: { thinkingFormat: 'deepseek' },
      headers: { 'x-acme': '1' },
      transport: 'websocket',
      reasoning: 'high',
    } as LegacyPiAiProfile))
    expect(Object.keys(converted!)).toEqual(['displayName', 'baseURL', 'models'])
  })

  it('returns undefined when no model row survives', () => {
    expect(convertLegacyPiAiProfile(profile({ models: [{ id: '' }] }))).toBeUndefined()
    expect(convertLegacyPiAiProfile(profile({ models: undefined }))).toBeUndefined()
    expect(convertLegacyPiAiProfile(profile({ models: 'oops' } as LegacyPiAiProfile))).toBeUndefined()
  })

  it('keeps an already-converted modality list and skips junk rows', () => {
    expect(convertLegacyPiAiModels([
      { id: 'keep', inputModalities: ['text'] },
      { id: '' },
      'junk',
      { id: 'plain' },
    ])).toEqual([
      { id: 'keep', inputModalities: ['text'] },
      { id: 'plain' },
    ])
  })

  it('rejects a junk modality list rather than passing it through', () => {
    expect(convertLegacyPiAiModels([{ id: 'x', input: 'text-and-image' }])).toEqual([{ id: 'x' }])
  })
})

describe('migrateLegacyPiAiProfiles', () => {
  it('folds accepted profiles into the target namespace once', async () => {
    const doc = {
      [LEGACY_NS]: {
        providers: {
          acme: profile(),
          claude: profile({ api: 'anthropic-messages' }),
        },
      },
    }
    const settings = fakeSettings(doc)
    await migrateLegacyPiAiProfiles(
      settings,
      {
        ns: 'llm-openai',
        accepts: (_route, candidate) => candidate.api === 'openai-completions' || candidate.api === 'openai-responses',
        convert: (_route, candidate) => convertLegacyPiAiProfile(candidate, { api: 'openai-completions' }),
      },
      () => {},
    )
    expect(settings.updates).toEqual([{
      ns: 'llm-openai',
      patch: { providers: { acme: convertLegacyPiAiProfile(profile(), { api: 'openai-completions' }) } },
    }])
  })

  it('lets the route key break a protocol tie for a catalog profile', async () => {
    // A stored pi-ai catalog route named no protocol (the catalog was its
    // default), so the route key decides which family owns it: `anthropic`
    // stays out of the openai import even though its profile is otherwise
    // claimable, and `openai` lands even with nothing but a credential.
    const doc = {
      [LEGACY_NS]: {
        providers: {
          openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-4o' }] },
          anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-sonnet-4-5' }] },
        },
      },
    }
    const settings = fakeSettings(doc)
    const rejected: string[] = []
    await migrateLegacyPiAiProfiles(
      settings,
      {
        ns: 'llm-openai',
        accepts: (route, candidate) => candidate.api === 'openai-completions'
          || candidate.api === 'openai-responses'
          || (candidate.api === undefined && (route === 'openai' || typeof candidate.baseURL === 'string')),
        convert: (_route, candidate) => convertLegacyPiAiProfile(candidate, { api: 'openai-completions' }),
      },
      () => {},
    )
    const written = settings.updates[0]?.patch as { providers: Record<string, unknown> }
    expect(Object.keys(written.providers)).toEqual(['openai'])
    expect(rejected).toEqual([])
  })

  it('never runs when the target namespace already has a user layer', async () => {
    const settings = fakeSettings({
      [LEGACY_NS]: { providers: { acme: profile() } },
      'llm-openai': { providers: {} },
    })
    const lines: string[] = []
    await migrateLegacyPiAiProfiles(
      settings,
      { ns: 'llm-openai', accepts: () => true, convert: (_route, candidate) => convertLegacyPiAiProfile(candidate) },
      (line) => { lines.push(line) },
    )
    expect(settings.updates).toEqual([])
    expect(lines[0]).toContain('already configured')
  })

  it('writes nothing when the legacy section is absent, empty, or all-rejected', async () => {
    for (const doc of [{}, { [LEGACY_NS]: {} }, { [LEGACY_NS]: { providers: { g: profile({ api: 'google-generative-ai' }) } } }]) {
      const settings = fakeSettings(doc)
      await migrateLegacyPiAiProfiles(
        settings,
        { ns: 'llm-openai', accepts: (_route, candidate) => typeof candidate.api === 'string' && candidate.api.startsWith('openai'), convert: (_route, candidate) => convertLegacyPiAiProfile(candidate) },
        () => {},
      )
      expect(settings.updates).toEqual([])
    }
  })

  it('reports unserviceable routes it skipped alongside the migrated ones', async () => {
    const settings = fakeSettings({
      [LEGACY_NS]: {
        providers: {
          acme: profile(),
          broken: profile({ models: [] }),
        },
      },
    })
    const lines: string[] = []
    await migrateLegacyPiAiProfiles(
      settings,
      { ns: 'llm-openai', accepts: () => true, convert: (_route, candidate) => convertLegacyPiAiProfile(candidate, { api: 'openai-completions' }) },
      (line) => { lines.push(line) },
    )
    expect(settings.updates).toHaveLength(1)
    expect(lines[0]).toContain('1 unserviceable route(s) skipped')
  })
})
