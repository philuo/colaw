/**
 * One-shot import of provider profiles from the retired `llm-pi-ai` settings
 * section. The pi-ai adapter's unmount left hand-declared routes stored under
 * a namespace nothing serves; each replacement adapter folds the profiles
 * that speak its protocols into its own settings user layer the moment it
 * mounts, so an upgrade keeps every provider the user declared — and the
 * protocols the product dropped (google, bedrock, …) stay out on purpose.
 *
 * Guard: the import runs only while the target namespace has NO stored user
 * layer. The migration's own write creates that layer, so it can never run
 * twice — a route the user later deletes stays deleted, and a document kept
 * by a build that already wrote the target namespace is never second-guessed.
 *
 * Field conversion is mechanical and schema-shaped: pi-ai-only fields
 * (compat, headers, transport, …) have no equivalent on the replacement
 * adapters and drop; the pi-ai `input` modality list arrives as
 * `inputModalities`.
 *
 * @module dsh-llm/legacy-pi-ai
 */

/** The settings namespace the unmounted pi-ai adapter owned. */
export const LEGACY_NS = 'llm-pi-ai'

/** A stored pi-ai profile, read raw (unvalidated, unredacted). */
export interface LegacyPiAiProfile {
  api?: unknown
  displayName?: unknown
  apiKeyEnv?: unknown
  baseURL?: unknown
  models?: unknown
}

/** The settings faces the migration needs; `update` requires the caller's own registered namespace. */
export interface LegacyMigrationSettings {
  rawSection(ns: string): Record<string, unknown> | undefined
  update(ns: string, patch: object): Promise<void>
}

/** A non-empty string field, or `undefined`. */
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Convert one stored profile into a replacement adapter's schema shape, or
 * `undefined` when nothing serviceable remains (no usable model ids).
 * @param profile - the raw stored profile.
 * @param options - fields the target schema carries that the converter must
 *   decide: `api` is recorded verbatim (an adapter whose schema has no
 *   protocol field omits it, and schemastery strips the rest).
 */
export function convertLegacyPiAiProfile(
  profile: LegacyPiAiProfile,
  options?: { api?: string },
): Record<string, unknown> | undefined {
  const models = convertLegacyPiAiModels(profile.models)
  if (models === undefined) return undefined
  const displayName = string(profile.displayName)
  const apiKeyEnv = string(profile.apiKeyEnv)
  const baseURL = string(profile.baseURL)
  return {
    ...options?.api === undefined ? {} : { api: options.api },
    ...displayName === undefined ? {} : { displayName },
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    ...baseURL === undefined ? {} : { baseURL },
    models,
  }
}

/** Convert a stored model list, mapping the pi-ai `input` vocabulary across. */
export function convertLegacyPiAiModels(models: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(models)) return undefined
  const converted: Record<string, unknown>[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) continue
    const model = raw as Record<string, unknown>
    const id = string(model['id'])
    if (id === undefined) continue
    // pi-ai spelled the list `input`; the replacement adapters spell it
    // `inputModalities` — same strings, same order.
    const input = Array.isArray(model['inputModalities']) ? model['inputModalities'] : model['input']
    const modalities = Array.isArray(input) && input.every(item => typeof item === 'string') && input.length > 0
      ? [...input as string[]]
      : undefined
    converted.push({
      id,
      ...string(model['name']) === undefined ? {} : { name: string(model['name']) },
      ...typeof model['contextWindow'] === 'number' && Number.isInteger(model['contextWindow']) && model['contextWindow'] > 0
        ? { contextWindow: model['contextWindow'] }
        : {},
      ...typeof model['maxTokens'] === 'number' && Number.isInteger(model['maxTokens']) && model['maxTokens'] > 0
        ? { maxTokens: model['maxTokens'] }
        : {},
      ...modalities === undefined ? {} : { inputModalities: modalities },
    })
  }
  return converted.length > 0 ? converted : undefined
}

/**
 * Run the one-shot import for one target namespace.
 * @param settings - the settings service (already started, so the stored
 *   document is published and `update` reaches the caller's own namespace).
 * @param target - the namespace to fold profiles into and whether each
 *   stored profile belongs to it.
 * @param log - line function for the one diagnostic per outcome.
 */
export async function migrateLegacyPiAiProfiles(
  settings: LegacyMigrationSettings,
  target: {
    ns: string
    /**
     * Whether a stored route belongs to this namespace: either its profile
     * names a protocol this adapter serves, or it names none and the route
     * key is one this adapter would have shipped in the retired catalog.
     */
    accepts(route: string, profile: LegacyPiAiProfile): boolean
    /** Convert one accepted profile into the target's schema shape. */
    convert(profile: LegacyPiAiProfile): Record<string, unknown> | undefined
  },
  log: (line: string) => void,
): Promise<void> {
  const legacySection = settings.rawSection(LEGACY_NS)
  if (legacySection === undefined) return
  const stored = settings.rawSection(target.ns)
  if (stored !== undefined) {
    // A build that already wrote the target layer owns the upgrade path;
    // importing over it could resurrect routes the user deleted.
    log(`${target.ns}: a stored ${LEGACY_NS} section exists but ${target.ns} is already configured; not migrating`)
    return
  }
  const raw = legacySection['providers']
  if (typeof raw !== 'object' || raw === null) return
  const picked: [string, Record<string, unknown>][] = []
  const skipped: string[] = []
  for (const [route, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const profile = value as LegacyPiAiProfile
    if (!target.accepts(route, profile)) continue
    const converted = target.convert(profile)
    if (converted === undefined) {
      skipped.push(route)
      continue
    }
    picked.push([route, converted])
  }
  if (picked.length === 0) {
    if (skipped.length > 0) {
      log(`${target.ns}: ${skipped.length} stored ${LEGACY_NS} route(s) carry no serviceable model list and were not migrated`)
    }
    return
  }
  await settings.update(target.ns, { providers: Object.fromEntries(picked) })
  log(`${target.ns}: migrated ${picked.length} provider route(s) from the retired ${LEGACY_NS} section`
    + (skipped.length > 0 ? ` (${skipped.length} unserviceable route(s) skipped)` : ''))
}
