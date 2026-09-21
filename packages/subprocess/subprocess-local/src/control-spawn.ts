/** Parent-side setup for one explicitly requested inherited control channel. */

import { controlDuplex, SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_MARKER } from '@deepseek-ai/dsh-subprocess/control'
import type { ControlIpcPort } from '@deepseek-ai/dsh-subprocess/control'
import type { Duplex } from 'node:stream'

/**
 * Adapt the child's IPC port as the control channel's duplex endpoint.
 * @param child - child whose requested IPC channel was allocated by the runtime.
 * @param control - requested transport, or undefined when absent.
 * @returns the parent duplex endpoint, absent when not requested.
 */
export function controlPipe(
  child: ControlIpcPort,
  control?: 'pipe',
): Duplex | undefined {
  return control === 'pipe' ? controlDuplex(child) : undefined
}

/**
 * Stamp the private marker on a fresh child environment after rejecting a caller override.
 * @param env - newly materialized child environment, owned by the caller.
 * @param control - requested control transport, or undefined when absent.
 * @returns the same environment with the provider-owned launch marker when requested.
 */
export function controlEnvironment<T extends NodeJS.ProcessEnv>(env: T, control?: 'pipe'): T {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === SUBPROCESS_CONTROL_ENV && value !== undefined) {
      throw new Error(`${SUBPROCESS_CONTROL_ENV} is reserved for subprocess control-channel setup`)
    }
  }
  if (control === 'pipe') Object.assign(env, { [SUBPROCESS_CONTROL_ENV]: SUBPROCESS_CONTROL_MARKER })
  return env
}
