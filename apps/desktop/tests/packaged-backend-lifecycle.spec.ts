import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true)
}

interface LifecycleHelpers {
  websocketProbe: (socket: unknown, headers: Record<string, string>, expected: number | 'open') => Promise<string>
  stopChild: (child: FakeChild) => Promise<void>
}

const scriptUrl = new URL('../scripts/verify-packaged-backend.mjs', import.meta.url).href
const { websocketProbe, stopChild } = await import(scriptUrl) as LifecycleHelpers

function setupProbe(expected: number | 'open') {
  const instances: ProbeSocket[] = []
  class ProbeSocket extends EventEmitter {
    readonly terminate = vi.fn()
    constructor() {
      super()
      instances.push(this)
    }
  }
  const task = websocketProbe(ProbeSocket, {}, expected)
  const socket = instances[0]!
  let settled = false
  void task.then(() => { settled = true }, () => { settled = true })
  return { task, socket, settled: () => settled }
}

function rejectedStream(statusCode?: number) {
  return Object.assign(new EventEmitter(), {
    closed: false,
    statusCode,
    destroy: vi.fn(),
  })
}

afterEach(() => { vi.useRealTimers() })

describe('packaged backend probe cleanup', () => {
  it('waits for socket close after observing a successful upgrade', async () => {
    vi.useFakeTimers()
    const { task, socket, settled } = setupProbe('open')
    socket.emit('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(settled()).toBe(false)

    socket.emit('close')
    await expect(task).resolves.toBe('open')
    expect(socket.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([401, 403])('waits for every rejected HTTP resource after status %s', async (status) => {
    vi.useFakeTimers()
    const { task, socket, settled } = setupProbe(401)
    const request = rejectedStream()
    const response = rejectedStream(status)
    socket.emit('unexpected-response', request, response)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(request.destroy).toHaveBeenCalledOnce()
    expect(response.destroy).toHaveBeenCalledOnce()

    // ws can emit close before the rejected ClientRequest releases its socket.
    socket.emit('error', new Error('WebSocket was closed before the connection was established'))
    socket.emit('close')
    response.emit('close')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled()).toBe(false)
    request.emit('close')
    if (status === 401) await expect(task).resolves.toBe('401')
    else await expect(task).rejects.toThrow('WebSocket returned HTTP 403 while expecting 401')
    expect(socket.eventNames()).toEqual([])
    expect(request.eventNames()).toEqual([])
    expect(response.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for close before reporting an upgrade error', async () => {
    vi.useFakeTimers()
    const { task, socket, settled } = setupProbe('open')
    socket.emit('error', new Error('connection refused'))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(settled()).toBe(false)
    socket.emit('close')
    await expect(task).rejects.toThrow('connection refused')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminates a handshake timeout and waits for the close event', async () => {
    vi.useFakeTimers()
    const { task, socket, settled } = setupProbe('open')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(settled()).toBe(false)
    socket.emit('close')
    await expect(task).rejects.toThrow('WebSocket probe timed out')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a bounded cleanup failure and contains a late abort', async () => {
    vi.useFakeTimers()
    const { task, socket } = setupProbe('open')
    socket.emit('open')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(task).rejects.toThrow('resources did not close after termination')
    expect(() => { socket.emit('error', new Error('late abort')) }).not.toThrow()
    socket.emit('close')
    expect(socket.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('packaged backend child cleanup', () => {
  it('registers its exit observer before asking the child to stop', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    child.kill.mockImplementation(() => {
      child.emit('exit', 0, 'SIGTERM')
      return true
    })
    await stopChild(child)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for exit after escalating to SIGKILL', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const task = stopChild(child)
    let settled = false
    void task.then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(settled).toBe(false)
    child.emit('exit', null, 'SIGKILL')
    await task
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a bounded failure when the child never exits', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const task = stopChild(child)
    const assertion = expect(task).rejects.toThrow('did not exit after SIGKILL')
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
