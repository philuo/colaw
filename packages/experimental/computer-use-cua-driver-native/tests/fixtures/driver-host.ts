/**
 * An in-process stand-in for the child-hosted driver.
 *
 * The provider's own tests cover registration, exposure filtering, image
 * admission, cancellation and teardown — not the process boundary. Pointing
 * them at this module keeps them exercising exactly the code path they always
 * did, against the same external fixture, while the real implementation spawns
 * a child. `tests/driver-host.spec.ts` covers the boundary itself with a real
 * process.
 */

import { CuaDriver } from './cua-driver.ts'
import type { DriverHost } from '../../src/driver-host.ts'

/**
 * Open the fixture driver without a child.
 * @returns the same proxy surface the real host exposes.
 */
export function openDriverHost(): DriverHost {
  const driver = CuaDriver.create()
  return {
    // Pass the options through unchanged: the provider calls this surface with
    // the same shape the SDK takes, so re-wrapping `signal` here would bury
    // the real AbortSignal one level deeper.
    listToolsJson: options => driver.listToolsJson(options),
    callTool: (name, argsJson, options) => driver.callTool(name, argsJson, options),
    // The real shutdown reaps the child, which owns shutdown + uniffiDestroy;
    // this one has to do both to keep the fixture's counters honest.
    shutdown: async () => {
      await driver.shutdown()
      driver.uniffiDestroy()
    },
  }
}
