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
import {
  DESKTOP_REQUIRED_GRANTS,
  type DesktopCapabilityField,
  type DesktopPermissionPane,
  type DesktopPermissionStatus,
} from './desktop-store.ts'
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
  // The capability switch the user asked for whose grants have not landed.
  const pendingEnableRef: { field: DesktopCapabilityField | undefined } = { field: undefined }

  const sync = (): void => {
    const snapshot = scope.getSnapshot()
    bound?.sync(snapshot.value, snapshot.status)
  }
  ctx.effect(() => scope.subscribe(sync), 'ui-settings-desktop: scope mirror')

  const injected = (actions: BoundActions<typeof store>): {
    setField: (field: DesktopCapabilityField, value: boolean) => void
    setGuide: (pane: DesktopPermissionPane | undefined) => void
    refreshPermissions: () => void
    openMissingPane: () => void
    revealAppInFinder: () => void
    restartApp: () => void
  } => {
    bound = actions
    sync()

    /** Publish one probe answer to the store and the pane picker's mirror. */
    const publish = (status: DesktopPermissionStatus): void => {
      permissionsRef.value = status
      bound?.setPermissions(status)
    }

    /** Probe the host's TCC state once, answering the stored truth. */
    const probe = (): Promise<DesktopPermissionStatus | undefined> =>
      ctx.remote.desktopPermissions.statusFresh()
        .then((status) => {
          if (status === undefined || !status.ok || status.value === undefined) return undefined
          publish(status.value)
          return status.value
        })
        .catch(() => undefined)

    /** Persist one capability switch (the optimistic flip + durable write). */
    const persistOn = (field: DesktopCapabilityField): void => {
      bound?.sync(({ ...scope.getSnapshot().value, [field]: true }) as DesktopSettings | undefined, 'ready')
      void scope.set(field, true)
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

    // While a grant guide is open the client polls the host: the moment the
    // missing grants land, the pending capability enables itself and the guide
    // retires — the user never clicks the switch again.
    let guidePoll: ReturnType<typeof setInterval> | undefined
    const stopGuidePoll = (): void => {
      if (guidePoll === undefined) return
      clearInterval(guidePoll)
      guidePoll = undefined
    }
    const checkPendingEnable = (): void => {
      const pending = pendingEnableRef.field
      const permissions = permissionsRef.value
      if (pending === undefined || permissions === undefined) return
      if (!DESKTOP_REQUIRED_GRANTS[pending].every(grant => permissions[grant])) return
      bound?.setPendingEnable(undefined)
      bound?.setGuide(undefined)
      stopGuidePoll()
      persistOn(pending)
      // The long-running host may not see the fresh Accessibility grant until
      // its own restart; say so instead of leaving a dead switch on.
      bound?.setGrantDone(pending)
    }
    const startGuidePoll = (): void => {
      if (guidePoll !== undefined) return
      guidePoll = setInterval(() => { void probe().then(checkPendingEnable) }, 2_500)
    }

    return {
      setField: (field, value) => {
        if (value === false) {
          // Turning a capability off only stops new use; it never touches the
          // macOS grants, so re-enabling later needs no new permission.
          bound?.sync(({ ...scope.getSnapshot().value, [field]: false }) as DesktopSettings | undefined, 'ready')
          void scope.set(field, false)
          if (pendingEnableRef.field === field) {
            pendingEnableRef.field = undefined
            bound?.setPendingEnable(undefined)
            bound?.setGuide(undefined)
            stopGuidePoll()
          }
          return
        }
        const required = DESKTOP_REQUIRED_GRANTS[field]
        if (required.length === 0) {
          persistOn(field)
          return
        }
        // Turning ON is gated on the grants the capability needs: the switch
        // may only stay on once the OS grants exist. Missing grants keep the
        // switch off, open the exact System Settings pane, and start polling —
        // the enable completes itself when the grants land.
        void probe().then((status) => {
          const granted = status !== undefined && required.every(grant => status[grant])
          if (granted) {
            persistOn(field)
            return
          }
          pendingEnableRef.field = field
          bound?.setPendingEnable(field)
          openMissingPane()
          startGuidePoll()
        })
      },
      // The probe runs in the host process, so the OS attributes the request
      // to Colaw itself; the answer lands in the store and the section reads
      // it from there. A rejected call leaves the answer unset — undefined
      // means "no probe has answered", and the next mount probes again.
      refreshPermissions: () => {
        void probe().then(checkPendingEnable)
      },
      openMissingPane,
      setGuide: (pane) => {
        bound?.setGuide(pane)
        if (pane === undefined) stopGuidePoll()
        else startGuidePoll()
      },
      revealAppInFinder: () => {
        void ctx.remote.desktopPermissions.revealAppInFinder().catch(() => {})
      },
      restartApp: () => {
        // The host restarts itself: it relaunches the bundle, then exits, so
        // the freshly granted TCC state is read by a clean boot.
        void ctx.remote.desktopPermissions.restartApp().catch(() => {})
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
      return {
        setField: face.setField,
        setGuide: face.setGuide,
        refreshPermissions: face.refreshPermissions,
        openMissingPane: face.openMissingPane,
        revealAppInFinder: face.revealAppInFinder,
        restartApp: face.restartApp,
      }
    },
  }, DesktopSection))
}

export type { DesktopSectionState, DesktopPermissionStatus, DesktopPermissionPane } from './desktop-store.ts'
