/**
 * The 内置插件 (built-in plugins) tab's credential controller.
 *
 * Four product-shipped cloud services take API keys. Unlike the other cards
 * here there is no settings namespace — the keys live only in the managed
 * credentials store under fixed references, so this controller owns the whole
 * card state machine itself: describe each reference for the configured
 * badge, stage one secret per card, and write staged text straight to the
 * credentials domain on save. PKULaw, QCC, and Firecrawl resolve their bearer
 * headers at host startup (a new key applies on the next app start); MinerU
 * re-resolves per call and applies immediately — the per-service copy says
 * which is which.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CardActions, CardFieldState, CardShell } from './card-form.ts'

/** One built-in service's stable identity. */
export interface BuiltInService {
  /** Slot key and copy-key stem (`builtin.${key}…`). */
  readonly key: 'pkulaw' | 'qcc' | 'firecrawl' | 'mineru'
  /** Credential reference the key is stored under. */
  readonly credentialRef: string
}

/** The four built-in services, in tab order. */
export const BUILT_IN_SERVICES: readonly BuiltInService[] = [
  { key: 'pkulaw', credentialRef: 'PKULAW_API_KEY' },
  { key: 'qcc', credentialRef: 'QCC_API_KEY' },
  { key: 'firecrawl', credentialRef: 'FIRECRAWL_API_KEY' },
  { key: 'mineru', credentialRef: 'MINERU_API_KEY' },
]

/** What one service's card renders. */
export interface BuiltInCardState extends CardShell {
  /** The staged secret, which starts blank on every load. */
  secret: CardFieldState
  /** Whether the Host reports a credential configured for this service. */
  configured: boolean
}

/** The registration-side face one built-in card's slot entry injects. */
export interface BuiltInCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useBuiltinCard. */
    builtinCard: SnapshotStore<BuiltInCardState>
  }
}

const SECRET_FIELD = 'apiKey'

/** One service's live state and its snapshot store. */
interface ServiceState {
  readonly ref: string
  readonly store: SnapshotStore<BuiltInCardState>
  configured: boolean
  writable: boolean
  saving: boolean
  failed: boolean
  staged: string
}

/**
 * Owns the four services' credential state and their staged drafts.
 * @param ctx - the card plugin's context, whose `remote.credentials` namespace answers.
 */
export class BuiltInServicesController {
  private readonly services = new Map<string, ServiceState>()

  constructor(private readonly ctx: ClientContext) {
    for (const service of BUILT_IN_SERVICES) {
      this.services.set(service.key, {
        ref: service.credentialRef,
        store: createSnapshotStore<BuiltInCardState>(snapshot(service.key)),
        configured: false,
        writable: true,
        saving: false,
        failed: false,
        staged: '',
      })
    }
    void this.describeAll()
  }

  /** Read every service's configured/writable state from the credentials domain. */
  private async describeAll(): Promise<void> {
    const refs = [...this.services.values()].map(service => service.ref)
    const response = await this.ctx.remote.credentials.describe(refs).catch(() => undefined)
    if (response === undefined || !response.ok) return
    for (const service of this.services.values()) {
      const view = response.value[service.ref]
      service.configured = view?.configured ?? false
      service.writable = view?.writable ?? true
      this.publish(service)
    }
  }

  /** Republish one service's snapshot from its live fields. */
  private publish(service: ServiceState): void {
    service.store.set({
      available: true,
      writable: service.writable,
      dirty: service.staged.length > 0,
      invalid: false,
      saving: service.saving,
      failed: service.failed,
      secret: { text: service.staged, overridden: true, invalid: false },
      configured: service.configured,
    })
  }

  /**
   * Re-read one service after the Host reports a change to its reference —
   * the same invalidation the web-search card rides.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string | undefined): void {
    if (ref !== undefined && !this.services.has(serviceKeyOf(ref) ?? '')) return
    void this.describeAll()
  }

  /** Build one service card's injected face. */
  inject(key: BuiltInService['key']): BuiltInCardFace {
    return {
      hooks: { builtinCard: this.storeOf(key) },
      edit: (field: string, text) => {
        if (field !== SECRET_FIELD) return
        const service = this.serviceOf(key)
        service.staged = text
        service.failed = false
        this.publish(service)
      },
      save: () => { void this.save(key) },
      resetField: () => { /* credentials carry no composition layer to reset to */ },
      discard: () => {
        const service = this.serviceOf(key)
        service.staged = ''
        service.failed = false
        this.publish(service)
      },
    }
  }

  /** The named service's snapshot store (hooks seat). */
  private storeOf(key: BuiltInService['key']): SnapshotStore<BuiltInCardState> {
    return this.serviceOf(key).store
  }

  private serviceOf(key: BuiltInService['key']): ServiceState {
    const service = this.services.get(key)
    if (service === undefined) throw new Error(`built-in services: unknown service "${key}"`)
    return service
  }

  /** Write one service's staged secret, then re-read the configured badge. */
  private async save(key: BuiltInService['key']): Promise<void> {
    const service = this.serviceOf(key)
    const value = service.staged
    if (value.length === 0) return
    service.saving = true
    this.publish(service)
    const response = await this.ctx.remote.credentials.set(service.ref, value)
    service.saving = false
    if (response.ok) {
      service.staged = ''
      service.failed = false
    } else {
      service.failed = true
    }
    this.publish(service)
    void this.describeAll()
  }
}

/** The credential reference a changed-ref event names, when it is one of ours. */
function serviceKeyOf(ref: string): string | undefined {
  return BUILT_IN_SERVICES.find(service => service.credentialRef === ref)?.key
}

/** Initial snapshot for one service (blank staged secret, not yet described). */
function snapshot(_key: string): BuiltInCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    secret: { text: '', overridden: false, invalid: false },
    configured: false,
  }
}
