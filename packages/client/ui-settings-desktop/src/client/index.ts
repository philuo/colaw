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
import type { DesktopSettings } from '../desktop-settings.ts'
import { DESKTOP_SETTINGS_NAMESPACE } from '../desktop-settings.ts'
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
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-desktop: copy dictionaries')

  const scope = ctx.settingsScope.bind<DesktopSettings>({ namespace: DESKTOP_SETTINGS_NAMESPACE })
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-control',
    order: 18,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      snapshot: scope.getSnapshot(),
      setField: (field: keyof DesktopSettings, value: boolean) => { void scope.set(field, value) },
    }),
  }, DesktopSection))
}
