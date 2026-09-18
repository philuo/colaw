/**
 * Default responses for every Remote endpoint the web assembly calls while
 * booting and rendering with no sessions, no workspaces, and default settings.
 * The comment above each row names the plugin that calls it; endpoints boot
 * never touches stay absent so a new call fails loud. `$events` is built into
 * `RemoteMock`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses
 */
import { ok, openStream, type RemoteTable } from '@deepseek-ai/dsh-remote-mock'

/**
 * The Session the startup default creates when the assembly boots with nothing
 * open. A spec that boots the roster ends up with it selected, so the id is
 * fixed here rather than left to a random draw: a spec can address the row it
 * produces without knowing which order the fixtures ran in.
 */
export const DETACHED_SESSION_ID = '5d0de740-0000-4000-8000-000000000000'

/** Default responses of the boot-time Remote endpoints; a spec loads it first and layers its own table on top. */
export const remoteDefaultResponses: RemoteTable = {
  unary: {
    // api-session-controller `sessions.handleConnected()` on `connection/reset`.
    'session/list': ok({ items: [] }),
    // ui-workspace `WorkspaceNavigation`'s startup reconcile: with no current
    // Session and no Workspace to reuse, the workspace-less default creates one
    // so the composer is usable from the first paint. It is the one write the
    // assembly makes on its own, and every spec that boots the roster rides it.
    'session/create': ok({ sessionId: DETACHED_SESSION_ID }),
    // ui-settings `mirror.ensure()` at apply and again on `connection/reset`.
    'settings/describe': ok({ writable: true, hasDocument: false, namespaces: [] }),
    // ui-model-selection `ModelDirectoryResolver` constructor.
    'session/modelCatalog': ok({
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routableProviders: [],
      groups: [],
      failures: [],
    }),
    // ui-agent-preset hero chip and header label on first mount.
    'agentPresets/list': ok({ presets: [], authorable: false }),
    // cordis-client-runner `ClientCordisInspectRegistry.sync` at apply and on `connection/reset`.
    'dynamicCordisRunner/syncInspectManifest': ok(null),
    // ui-cordis inventory at apply and on `connection/reset`.
    'dynamicCordisRunner/inventory': ok([]),
    // ui-settings-plugins web-search card `readCredential()` when the settings mirror first publishes.
    'credentials/describe': ok({}),
    // ui-permission-presets `PermissionCatalogDirectory` on its first read for a connection generation.
    'permissionPresets/catalog': ok({ options: [] }),
    // api-session-controller `AgentCatalogDirectory` for the Session the startup
    // default just created: a blank Session has no subagents.
    'subagents/list': ok({ entries: [], parentAvailable: true }),
    // ui-commands `CommandDirectory.warm` when the composer of that Session mounts.
    'commands/list': ok([]),
    // ui-skill's catalog fetch for the same composer.
    'skills/list': ok({ skills: [] }),
  },
  stream: {
    // api-session-controller client `apply`: the control stream's opening baseline, then open.
    'session/control': openStream([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }]),
    // api-workspace-controller client `apply`: the follow stream's opening baseline, then open.
    'workspace/follow': openStream([{ type: 'baseline', value: { items: [], archivedSessionIds: [] } }]),
    // api-session-controller `SessionEventStream.follow` once the startup
    // default's Session opens: no history to replay, and it stays open so a
    // spec can push into it.
    'session/follow': openStream(),
  },
}
