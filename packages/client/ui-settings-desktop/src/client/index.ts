/**
 * Desktop-control settings plugin, browser half. It registers the 电脑操控
 * section: three independent capability switches over one durable settings
 * namespace, plus the macOS permission panel probing the host's TCC state.
 * The Host half registers the namespace; the desktop-facing providers read it
 * to decide whether to publish their tools.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (settings invalidations ride the
// allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DesktopSection } from './DesktopSection.tsx'
import { createDesktopSectionStore } from './desktop-store.ts'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { DesktopPermissionPane, DesktopPermissionStatus } from './desktop-store.ts'
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
 * invalidation that keeps an open page current without polling, and answers
 * the TCC probes.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.desktopPermissions', 'settingsScope']

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
  // The probe answer, mirrored outside the store for the pane picker: the
  // deep-link needs the current answer at call time, not a re-render.
  const permissionsRef: { value: DesktopPermissionStatus | undefined } = { value: undefined }

  const sync = (): void => {
    const snapshot = scope.getSnapshot()
    bound?.sync(snapshot.value, snapshot.status)
  }
  ctx.effect(() => scope.subscribe(sync), 'ui-settings-desktop: scope mirror')

  const injected = (actions: BoundActions<typeof store>): {
    setField: (field: 'browserUse' | 'computerUse' | 'lockScreenOperation', value: boolean) => void
    setGuide: (pane: DesktopPermissionPane | undefined) => void
    refreshPermissions: () => void
    openMissingPane: () => void
  } => {
    bound = actions
    sync()

    /** Publish one probe answer to the store and the pane picker's mirror. */
    const publish = (status: DesktopPermissionStatus): void => {
      permissionsRef.value = status
      bound?.setPermissions(status)
    }

    // Deep-link the pane of the FIRST missing grant: the user toggles that
    // exact switch instead of hunting the Privacy page.
    const openMissingPane = (): void => {
      const permissions = permissionsRef.value
      const pane = permissions === undefined || permissions.accessibility ? 'screenRecording' : 'accessibility'
      bound?.setGuide(pane)
      void ctx.remote.desktopPermissions.openPermissionPane(pane)
        .then((status) => {
          if (status.ok) publish(status.value)
        })
        .catch(() => {})
    }

    return {
      setField: (field, value) => {
        // Optimistic: the switch flips now, and the accepted durable write
        // (or the recovery read after a rejection) converges the store.
        bound?.sync(({ ...scope.getSnapshot().value, [field]: value }) as DesktopSettings | undefined, 'ready')
        void scope.set(field, value)
        // Enabling computer use is the moment its grants become necessary:
        // take the user straight to the missing pane instead of leaving the
        // guidance for a second visit.
        if (field === 'computerUse' && value === true) {
          void ctx.remote.desktopPermissions.status().then((status) => {
            if (status.ok && !(status.value.accessibility && status.value.screenRecording)) openMissingPane()
          }).catch(() => {})
        }
      },
      // The probe runs in the host process, so the OS attributes the request
      // to Colaw itself; the answer lands in the store and the section reads
      // it from there. A rejected call leaves the answer unset — undefined
      // means "no probe has answered", and the next mount probes again.
      refreshPermissions: () => {
        void ctx.remote.desktopPermissions.status()
          .then((status) => {
            if (status.ok) publish(status.value)
          })
          .catch(() => {})
      },
      openMissingPane,
      setGuide: (pane) => { bound?.setGuide(pane) },
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
      return {
        setField: face.setField,
        setGuide: face.setGuide,
        refreshPermissions: face.refreshPermissions,
        openMissingPane: face.openMissingPane,
      }
    },
  }, DesktopSection))
}

export type { DesktopSectionState, DesktopPermissionStatus, DesktopPermissionPane } from './desktop-store.ts'
