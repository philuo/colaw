/**
 * Desktop-control settings plugin, browser half. It registers the 电脑操控
 * section: three independent capability switches over one durable settings
 * namespace. The Host half registers the namespace; the desktop-facing
 * providers read it to decide whether to publish their tools.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge (settings invalidations ride the
// allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { DesktopSection } from './DesktopSection.tsx'
import { createDesktopSectionStore } from './desktop-store.ts'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import { DESKTOP_SETTINGS_NAMESPACE, type DesktopSettings } from '../desktop-settings.ts'
import { en, zh, type DesktopKey } from './locales.ts'

export type { DesktopKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The 电脑操控 page copy. */
    'settings.desktop': DesktopKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.desktop'

/**
 * Required services. `settingsScope` makes ui-settings activate first (the
 * slot declaration lives there); `remote` carries the pushed settings
 * invalidation that keeps an open page current without polling.
 */
export const inject = ['slots', 'locale', 'remote', 'settingsScope']

/**
 * Register the Desktop-control section over the shared settings namespace.
 * The scope snapshot mirrors into a slot store, so a switch click lands
 * immediately (optimistic) and the wire write reconciles it afterwards.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-desktop: copy dictionaries')

  const scope = ctx.settingsScope.bind<DesktopSettings>({ namespace: DESKTOP_SETTINGS_NAMESPACE })
  const t = ctx.locale.bind(NS)
  const store = createDesktopSectionStore()
  let bound: BoundActions<typeof store> | undefined
  // The live TCC answer, held outside the store: the section re-reads it
  // through its own effect after each probe, so a plain ref keeps the
  // optimistic switch writes and the permission probe independent.
  const permissions = { value: undefined as { accessibility: boolean; screenRecording: boolean } | undefined }

  const sync = (): void => {
    const snapshot = scope.getSnapshot()
    bound?.sync(snapshot.value, snapshot.status)
  }
  ctx.effect(() => scope.subscribe(sync), 'ui-settings-desktop: scope mirror')

  const injected = (actions: BoundActions<typeof store>): {
    setField: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
    loadPermissions: () => void
    openPermissionSettings: () => void
  } => {
    bound = actions
    sync()
    return {
      setField: (field, value) => {
        // Optimistic: the switch flips now, and the accepted durable write
        // (or the recovery read after a rejection) converges the store.
        bound?.sync(({ ...scope.getSnapshot().value, [field]: value }) as DesktopSettings | undefined, 'ready')
        void scope.set(field, value)
      },
      loadPermissions: () => {
        // TODO(desktop-permissions): the TCC probe must run in the host
        // process; the typert endpoint lands with the next remote round. With
        // no probe wired the section hides its permission block entirely.
        permissions.value = undefined
      },
      openPermissionSettings: () => {
        // Reserved for the same host endpoint as loadPermissions.
      },
    }
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-control',
    order: 18,
    label: () => t('nav'),
    locale: NS,
    store,
    inject: (actions) => {
      const face = injected(actions)
      void face.loadPermissions()
      return {
        setField: face.setField,
        loadPermissions: face.loadPermissions,
        openPermissionSettings: face.openPermissionSettings,
        get permissions() { return permissions.value },
      }
    },
  }, DesktopSection))
}

export type { DesktopSectionState } from './desktop-store.ts'
