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
 * How often the running app re-asks a FRESH process for the TCC state while a
 * capability that needs a grant is switched on. macOS raises no callback for a
 * revoke, and the host's own answer stays at its pre-revoke value for as long
 * as it runs, so polling a child process is the only way to notice a user who
 * turned a grant off behind the app's back. The cost is one short-lived child
 * per tick, which is why the watch is bounded to the moments a missing grant
 * actually breaks something: a switch is on. It starts when one is switched on
 * and stops when the last one goes off (see the watch effect in `apply`).
 */
const PERMISSION_WATCH_MS = 8_000

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
  // Grants seen granted at least once in this session. A grant that was never
  // granted is a missing permission; a grant that was granted and is gone now
  // is a REVOKE, which is a different thing to tell the user.
  const everGranted = { accessibility: false, screenRecording: false }

  const sync = (): void => {
    const snapshot = scope.getSnapshot()
    bound?.sync(snapshot.value, snapshot.status)
  }
  ctx.effect(() => scope.subscribe(sync), 'ui-settings-desktop: scope mirror')

  /**
   * Publish one probe answer to the store and the pane picker's mirror.
   *
   * The revocation check lives here rather than at the probe's call site: every
   * answer passes through, so a revoke is noticed whichever probe witnessed it
   * — the periodic watch, a mount, or a re-check the user asked for.
   */
  const publish = (status: DesktopPermissionStatus): void => {
    permissionsRef.value = status
    if (status.accessibility) everGranted.accessibility = true
    if (status.screenRecording) everGranted.screenRecording = true
    bound?.setPermissions(status)
    bound?.setRevoked(
      (everGranted.accessibility && !status.accessibility)
      || (everGranted.screenRecording && !status.screenRecording),
    )
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

  // The running app watches for a grant the user takes away. Only a fresh
  // process can see it (see PERMISSION_WATCH_MS), and only the gated switches
  // make it matter: with every one of them off there is nothing to break, so
  // the watch costs nothing. Turning a switch off never touches macOS grants,
  // but a grant that is gone makes the capability unusable — the app says so
  // instead of silently failing later.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const settings = scope.getSnapshot().value
      if (settings?.computerUse !== true && settings?.lockScreenOperation !== true) return
      void probe()
    }, PERMISSION_WATCH_MS)
    return () => { clearInterval(timer) }
  }, 'ui-settings-desktop: revoked-grant watch')

  const injected = (actions: BoundActions<typeof store>): {
    setField: (field: DesktopCapabilityField, value: boolean) => void
    setGuide: (pane: DesktopPermissionPane | undefined) => void
    refreshPermissions: () => void
    setGrantDone: (field: DesktopCapabilityField | undefined) => void
    setRevoked: (value: boolean) => void
    dismissPending: () => void
    openMissingPane: () => void
    revealAppInFinder: () => void
    restartApp: () => void
  } => {
    bound = actions
    sync()

    /** Persist one capability switch (the optimistic flip + durable write). */
    const persistOn = (field: DesktopCapabilityField): void => {
      bound?.sync(({ ...scope.getSnapshot().value, [field]: true }) as DesktopSettings | undefined, 'ready')
      void scope.set(field, true)
    }

    // Deep-link the pane of the FIRST missing grant: the user toggles that
    // exact switch instead of hunting the Privacy page.
    //
    // The pane comes FIRST, the guide bar second: the native helper shows its
    // draggable icon only once the System Settings window is on screen, and
    // spawning it ahead of the pane it points into is the one ordering that
    // makes the guide the answer to the window rather than a bar that arrived
    // before it. The helper additionally anchors itself under that window — so
    // the summon has to be in flight before the bar exists at all.
    const openMissingPane = (): void => {
      const permissions = permissionsRef.value
      const pane = permissions === undefined || permissions.accessibility ? 'screenRecording' : 'accessibility'
      bound?.setGuide(pane)
      void ctx.remote.desktopPermissions.openPermissionPane(pane)
        .then((status) => {
          if (status.ok) publish(status.value)
          // The native bar carries the draggable icon; the in-page bar remains
          // as the fallback when the helper binary is absent. Summoned after
          // the pane has been asked for, so the two never cross.
          return ctx.remote.desktopPermissions.showGrantGuide(pane)
        })
        .then((shown) => {
          if (shown?.ok === true) bound?.setNativeGuide(shown.value === true)
        })
        .catch(() => {})
    }

    /** Retire both guide surfaces (native bar + in-page state). */
    const closeGuides = (): void => {
      bound?.setNativeGuide(false)
      void ctx.remote.desktopPermissions.dismissGrantGuide().catch(() => {})
    }

    // While a grant guide is open the client polls the host: the moment the
    // missing grants land, the guide retires — the user is done dragging and
    // should not keep being walked through a step they already took.
    let guidePoll: ReturnType<typeof setInterval> | undefined
    const stopGuidePoll = (): void => {
      if (guidePoll === undefined) return
      clearInterval(guidePoll)
      guidePoll = undefined
    }
    const settlePending = (): void => {
      const pending = pendingEnableRef.field
      const permissions = permissionsRef.value
      if (pending === undefined || permissions === undefined) return
      if (!DESKTOP_REQUIRED_GRANTS[pending].every(grant => permissions[grant])) return
      bound?.setGuide(undefined)
      stopGuidePoll()
      closeGuides()
      // Deliberately NOT the enable. A grant landing in System Settings must
      // never move a control the user is looking at: `pendingEnable` stays set
      // so the section can say the permission is in and ask for the switch,
      // and the switch is flipped by the user's own click.
    }
    const startGuidePoll = (): void => {
      if (guidePoll !== undefined) return
      guidePoll = setInterval(() => { void probe().then(settlePending) }, 2_500)
    }

    // The two capabilities that reach the model through a provider — computer
    // use and browser use — are mounted from this switch at *boot*: each
    // provider reads the namespace in its own `apply`, and that runs once per
    // process. So a flip is a saved intention, not a live change, in both
    // directions: turning one off stops the next process, not the running one.
    // Saying that where the switch was just touched is the difference between
    // "not working yet" and "broken". `lockScreenOperation` has no provider to
    // mount, so it stays quiet rather than training the user to ignore the bar.
    const RESTART_GATED_FIELDS: ReadonlySet<DesktopCapabilityField> = new Set(['computerUse', 'browserUse'])
    const announceRestart = (field: DesktopCapabilityField): void => {
      if (!RESTART_GATED_FIELDS.has(field)) return
      bound?.setGrantDone(field)
    }

    return {
      setField: (field, value) => {
        if (value === false) {
          // Turning a capability off only stops new use; it never touches the
          // macOS grants, so re-enabling later needs no new permission.
          bound?.sync(({ ...scope.getSnapshot().value, [field]: false }) as DesktopSettings | undefined, 'ready')
          void scope.set(field, false)
          announceRestart(field)
          if (pendingEnableRef.field === field) {
            pendingEnableRef.field = undefined
            bound?.setPendingEnable(undefined)
            bound?.setGuide(undefined)
            stopGuidePoll()
            closeGuides()
          }
          return
        }
        const required = DESKTOP_REQUIRED_GRANTS[field]
        if (required.length === 0) {
          // No macOS grant backs this capability, so the switch is the whole
          // gate: persist it and report when it lands.
          persistOn(field)
          announceRestart(field)
          return
        }
        // Turning ON is gated on the grants the capability needs: the switch
        // may only stay on once the OS grants exist. Missing grants keep the
        // switch off, open the exact System Settings pane, and start polling —
        // the guide retires by itself when the grants land, and the user then
        // flips the switch (never the other way round).
        void probe().then((status) => {
          const granted = status !== undefined && required.every(grant => status[grant])
          if (granted) {
            const wasPending = pendingEnableRef.field === field
            persistOn(field)
            if (wasPending) {
              pendingEnableRef.field = undefined
              bound?.setPendingEnable(undefined)
              bound?.setGuide(undefined)
              stopGuidePoll()
              closeGuides()
            }
            // Both routes need the restart: the grants landed under this very
            // process, whose host keeps serving its pre-grant TCC answer, and
            // the provider that acts on the capability mounts at boot either
            // way.
            announceRestart(field)
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
        void probe().then(settlePending)
      },
      setGrantDone: (field) => { bound?.setGrantDone(field) },
      dismissPending: () => {
        pendingEnableRef.field = undefined
        bound?.setPendingEnable(undefined)
        bound?.setGuide(undefined)
        stopGuidePoll()
        closeGuides()
      },
      setRevoked: (value) => {
        bound?.setRevoked(value)
        if (!value) return
        // A revoked grant makes any guide stale: the bar was walking the user
        // through a pane whose grant is now gone rather than pending.
        bound?.setGuide(undefined)
        stopGuidePoll()
        closeGuides()
      },
      openMissingPane,
      setGuide: (pane) => {
        bound?.setGuide(pane)
        if (pane === undefined) {
          stopGuidePoll()
          closeGuides()
        } else {
          startGuidePoll()
        }
      },
      revealAppInFinder: () => {
        void ctx.remote.desktopPermissions.revealAppInFinder().catch(() => {})
      },
      restartApp: () => {
        // The host arms its own relaunch: a detached waiter brings the bundle
        // back once this process is gone, then exits. Relaunching in place is
        // what used to leave the app closed — see the remote's own note.
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
        setGrantDone: face.setGrantDone,
        setRevoked: face.setRevoked,
        dismissPending: face.dismissPending,
        refreshPermissions: face.refreshPermissions,
        openMissingPane: face.openMissingPane,
        revealAppInFinder: face.revealAppInFinder,
        restartApp: face.restartApp,
      }
    },
  }, DesktopSection))
}

export type { DesktopSectionState, DesktopPermissionStatus, DesktopPermissionPane } from './desktop-store.ts'
