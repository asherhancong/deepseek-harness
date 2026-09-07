import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  BackendProcess,
  DESKTOP_BACKEND_PORT,
  type BackendClock,
  type BackendProcessOptions,
  type BackendSpawn,
} from '../src/main/backend-process.ts'

class ManualClock implements BackendClock {
  readonly delays: number[] = []
  readonly #tasks = new Map<number, () => void>()
  #nextToken = 1

  setTimeout(callback: () => void, delayMs: number): unknown {
    const token = this.#nextToken++
    this.delays.push(delayMs)
    this.#tasks.set(token, callback)
    return token
  }

  clearTimeout(token: unknown): void {
    if (typeof token === 'number') this.#tasks.delete(token)
  }

  runNext(): void {
    const next = this.#tasks.entries().next().value
    if (next === undefined) throw new Error('manual clock has no pending timer')
    const [token, callback] = next
    this.#tasks.delete(token)
    callback()
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly launchPipe = new PassThrough()
  readonly stdio = [null, this.stdout, this.stderr, this.launchPipe]
  readonly signals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal)
    return true
  }
}

interface SpawnCall {
  executable: string
  args: readonly string[]
  options: SpawnOptions
}

function setup(overrides: Partial<BackendProcessOptions> = {}): {
  backend: BackendProcess
  child: FakeChild
  clock: ManualClock
  calls: SpawnCall[]
} {
  const child = new FakeChild()
  const clock = new ManualClock()
  const calls: SpawnCall[] = []
  const spawn: BackendSpawn = (executable, args, options) => {
    calls.push({ executable, args, options })
    return child as unknown as ChildProcess
  }
  const backend = new BackendProcess({
    cliEntry: '/app/Resources/dsh/lib/bin.js',
    bootstrapEntry: '/app/Resources/backend-bootstrap.cjs',
    patchEntry: '/app/Resources/desktop.cordis.patch.yml',
    desktopCapability: 'A'.repeat(43),
    cwd: '/Users/tester',
    electronExecutable: '/app/Contents/MacOS/DSH',
    port: DESKTOP_BACKEND_PORT,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 250,
    env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '0' },
    spawn,
    clock,
    ...overrides,
  })
  return { backend, child, clock, calls }
}

describe('BackendProcess', () => {
  it('spawns the CLI through Electron and accepts a fragmented exact readiness line', async () => {
    const logs: string[] = []
    const { backend, child, calls } = setup({ writeLog: (text) => { logs.push(text) } })
    const started = backend.start()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      executable: '/app/Contents/MacOS/DSH',
      args: [
        '--expose-internals',
        '--require', '/app/Resources/backend-bootstrap.cjs',
        '/app/Resources/dsh/lib/bin.js',
        'web',
        '--patch', '/app/Resources/desktop.cordis.patch.yml',
        '--host', '127.0.0.1',
        '--port', String(DESKTOP_BACKEND_PORT),
        '--no-open',
      ],
      options: {
        cwd: '/Users/tester',
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    })
    expect(calls[0]?.options.env).toMatchObject({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(calls[0]?.options.env).not.toHaveProperty('DSH_DESKTOP_CAPABILITY')
    expect(calls[0]?.options.env).not.toHaveProperty('DSH_DESKTOP_PARENT_PID')
    expect(JSON.parse(String(child.launchPipe.read()))).toEqual({
      capability: 'A'.repeat(43),
      parentPid: process.pid,
    })

    child.stderr.write('diagnostic\n')
    child.stdout.write(`dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT + 1)}\n`)
    child.stdout.write('dsh web: http://127.0.')
    child.stdout.write(`0.1:${String(DESKTOP_BACKEND_PORT)}\r\n`)

    await expect(started).resolves.toMatchObject({
      origin: `http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}`,
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(logs.join('')).toBe(
      `diagnostic\ndsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT + 1)}\n`
      + `dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}\r\n`,
    )

    const stopped = backend.stop()
    expect(child.signals).toEqual(['SIGTERM'])
    child.emit('exit', 0, null)
    await stopped
  })

  it('ignores near matches, times out, then escalates SIGTERM to SIGKILL', async () => {
    const { backend, child, clock } = setup()
    const started = backend.start()
    const rejected = expect(started).rejects.toThrow(
      `waiting for dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}`,
    )

    child.stdout.write(`prefix dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}\n`)
    child.stdout.write(`dsh web: http://localhost:${String(DESKTOP_BACKEND_PORT)}\n`)
    child.stdout.write(`dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)} suffix\n`)
    child.stdout.write(`dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}/?token=browser-token\n`)
    clock.runNext()

    await rejected
    expect(child.signals).toEqual(['SIGTERM'])
    expect(clock.delays).toEqual([1_000, 250])
    const stopped = backend.stop()
    clock.runNext()
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('exit', null, 'SIGKILL')
    await stopped
  })

  it('reports stderr when the child exits before readiness', async () => {
    const unexpected = vi.fn()
    const { backend, child } = setup()
    backend.onUnexpectedExit(unexpected)
    const started = backend.start()
    const rejected = expect(started).rejects.toThrow(/process exited \(code 7, signal null\).*configuration failed/s)

    child.stderr.write('configuration failed\n')
    child.emit('exit', 7, null)

    await rejected
    expect(unexpected).not.toHaveBeenCalled()
  })

  it('reports a spawn error before readiness', async () => {
    const { backend, child } = setup()
    const started = backend.start()
    const rejected = expect(started).rejects.toThrow('process error: spawn ENOENT before readiness')

    child.emit('error', new Error('spawn ENOENT'))

    await rejected
  })

  it('notifies observers when the ready child exits unexpectedly', async () => {
    const observer = vi.fn<(failure: Error) => void>()
    const { backend, child } = setup()
    backend.onUnexpectedExit(observer)
    const started = backend.start()
    child.stdout.write(`dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}\n`)
    await started

    child.emit('exit', 9, 'SIGABRT')

    expect(observer).toHaveBeenCalledOnce()
    const failure = observer.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain('process exited (code 9, signal SIGABRT) after readiness')
  })

  it('coalesces requested stops and suppresses the unexpected-exit callback', async () => {
    const observer = vi.fn<(failure: Error) => void>()
    const { backend, child } = setup()
    backend.onUnexpectedExit(observer)
    const started = backend.start()
    child.stdout.write(`dsh web: http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}\n`)
    await started

    const first = backend.stop()
    const second = backend.stop()
    expect(first).toBe(second)
    expect(child.signals).toEqual(['SIGTERM'])
    child.emit('exit', 0, 'SIGTERM')
    await first

    expect(observer).not.toHaveBeenCalled()
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('validates child identity, port, and timing inputs before spawn', () => {
    const required = {
      cliEntry: '/cli.js',
      bootstrapEntry: '/bootstrap.cjs',
      patchEntry: '/desktop.patch.yml',
      desktopCapability: 'A'.repeat(43),
      cwd: '/cwd',
      electronExecutable: '/Electron',
    }
    expect(() => new BackendProcess({ ...required, port: 0 })).toThrow(/port/)
    expect(() => new BackendProcess({ ...required, port: 65_536 })).toThrow(/port/)
    expect(() => new BackendProcess({ ...required, startupTimeoutMs: 0 })).toThrow(/startupTimeoutMs/)
    expect(() => new BackendProcess({ ...required, electronExecutable: '' })).toThrow(/electronExecutable/)
    expect(() => new BackendProcess({ ...required, desktopCapability: 'guessable' })).toThrow(/desktopCapability/)
  })
})
