/**
 * Native picker tier selection and the execFile adapter: the macOS folder
 * chooser (osascript), the abort rule, and the cancel/cancellation mapping.
 */

type ExecFileCallback = (
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { encoding: string; signal: AbortSignal; windowsHide: boolean },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { describe, expect, it, vi } from 'vitest'
import { pickNativeDirectory, type DirectoryPickerRunner } from '../src/native-picker.ts'

function failure(code: string | number, stderr = ''): Error {
  return Object.assign(new Error(`command failed: ${String(code)}`), { code, stderr })
}

const signal = () => new AbortController().signal

describe('native directory picker', () => {
  it('uses the macOS folder chooser and maps user cancellation to null', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/Users/test/project/\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBe('/Users/test/project/')
    expect(run).toHaveBeenCalledWith('osascript', expect.arrayContaining(['POSIX path of selectedFolder']), expect.any(AbortSignal))

    run.mockRejectedValueOnce(failure(1, 'execution error: User canceled. (-128)'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBeNull()

    run.mockRejectedValueOnce(failure(2, 'permission denied'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toThrow('command failed')
  })

  it.each([
    ['a primitive error', 'failed'],
    ['an invalid code type', { code: true }],
    ['a missing stderr property', { code: 1 }],
    ['a non-string stderr property', { code: 1, stderr: 42 }],
  ])('does not mistake %s for macOS cancellation', async (_label, reason) => {
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw reason })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toBe(reason)
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    // Deterministic on the fork's only target: darwin answers from osascript.
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/default/platform\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { run })).resolves.toBe('/default/platform')
    expect(run).toHaveBeenCalledWith('osascript', expect.anything(), expect.any(AbortSignal))
  })

  it('maps empty command output to cancellation', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBeNull()
  })

  it('does not convert caller aborts into user cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ABORT_ERR') })
    await expect(pickNativeDirectory(abort.signal, { platform: 'darwin', run })).rejects.toThrow('command failed')
  })

  it('reports unsupported platforms', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'win32' })).rejects.toThrow('unsupported on win32')
    await expect(pickNativeDirectory(signal(), { platform: 'linux' })).rejects.toThrow('unsupported on linux')
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).rejects.toThrow('unsupported on aix')
  })
})
