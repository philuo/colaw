import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Duplex } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_MARKER } from '@deepseek-ai/dsh-subprocess/control'
import { JsonChannel } from '../src/channel.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

const helper = fileURLToPath(new URL('../../../subprocess/subprocess/src/control.ts', import.meta.url))

it('boots an unbuilt source closure outside the workspace and exchanges tool replies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-source-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  for (const file of ['process.ts', 'bootstrap.ts', 'channel.ts', 'json-wire.ts', 'output-json.ts', 'protocol.ts', 'environment.ts']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file))
  }
  // The copied closure is the unit under test; the transport helper is the shipped one,
  // so the spawn shape matches production (the inherited fd control channel).
  const source = `import {openInheritedControlChannel} from ${JSON.stringify(pathToFileURL(helper).href)};import {runNodeMain} from ${JSON.stringify(pathToFileURL(join(directory, 'process.ts')).href)};await runNodeMain(openInheritedControlChannel(),100000,process);`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PLACEHOLDER_SECRET: 'fixture-only', [SUBPROCESS_CONTROL_ENV]: SUBPROCESS_CONTROL_MARKER },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'overlapped'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const finished = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  const completed = Promise.withResolvers<unknown>()
  child.once('error', (error) => { completed.reject(error) })
  child.once('exit', (code) => { if (code !== 0) completed.reject(new Error(`child exit ${code}: ${stderr}`)) })
  const streams = child.stdio as unknown as ReadonlyArray<Duplex | null>
  const control = streams[7]
  if (!(control !== null && typeof control === 'object' && 'write' in control)) {
    throw new Error('missing child control descriptor')
  }
  const channel = new JsonChannel(control, 100_000, (raw) => {
    const message = raw as { type: string; id?: number; args?: unknown; value?: unknown; error?: unknown }
    if (message.type === 'ready') {
      void channel.send({ type: 'boot', data: {
        code: 'const answer = await tools.echo({ n: 21 }); return { answer, env: { ...process.env } }',
        namespaces: [{ global: 'tools', names: ['echo'] }],
        maxOutputBytes: 10_000,
      } }).catch((error: unknown) => { completed.reject(error) })
    } else if (message.type === 'call') {
      expect(decodePtcJsonWire(message.args)).toEqual({ n: 21 })
      void channel.send({ type: 'reply', id: message.id, ok: true, value: encodePtcJsonWire(42) }).catch((error: unknown) => { completed.reject(error) })
    } else if (message.type === 'done') {
      if (message.error !== undefined) completed.reject(new Error(JSON.stringify(message.error)))
      else completed.resolve(decodePtcJsonWire(message.value))
    }
  }, (error) => { completed.reject(error) })
  onTestFinished(async () => { channel.close(); child.kill(); await finished })
  expect(await completed.promise).toEqual({ answer: 42, env: {} })
  channel.close()
  await finished
})
