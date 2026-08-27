import type { App, BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdatesAndNotify: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return autoUpdater
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener)
      return autoUpdater
    }),
  }
  return {
    autoUpdater,
    listeners,
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
})

vi.mock('electron', () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
}))

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))

import { startDesktopUpdater, type UpdateLifecycle } from '../src/main/updater.ts'

const window = {} as BrowserWindow

function app(isPackaged: boolean): App {
  return { isPackaged } as App
}

function lifecycle(prepareToQuit = vi.fn(async () => {})): UpdateLifecycle {
  return { prepareToQuit }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  mocks.listeners.clear()
  vi.clearAllMocks()
  mocks.autoUpdater.autoDownload = false
  mocks.autoUpdater.autoInstallOnAppQuit = false
  mocks.autoUpdater.quitAndInstall.mockReset()
  mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startDesktopUpdater', () => {
  it('does not check for updates outside a packaged application', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const updater = startDesktopUpdater(app(false), window, lifecycle())

    await updater.check()

    expect(mocks.autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    updater.dispose()
  })

  it('clears both schedules and unregisters its listeners on dispose', () => {
    const initialUnref = vi.fn()
    const intervalUnref = vi.fn()
    const initialTimer = { unref: initialUnref } as unknown as ReturnType<typeof setTimeout>
    const intervalTimer = { unref: intervalUnref } as unknown as ReturnType<typeof setInterval>
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => initialTimer)
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => intervalTimer)
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const updater = startDesktopUpdater(app(true), window, lifecycle())
    const registrations = mocks.autoUpdater.on.mock.calls.map(([event, listener]) => [event, listener])

    updater.dispose()
    updater.dispose()

    expect(initialUnref).toHaveBeenCalledOnce()
    expect(intervalUnref).toHaveBeenCalledOnce()
    expect(clearTimeoutSpy).toHaveBeenCalledOnce()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(initialTimer)
    expect(clearIntervalSpy).toHaveBeenCalledOnce()
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalTimer)
    expect(mocks.autoUpdater.removeListener.mock.calls).toEqual(registrations)
    expect(mocks.listeners.get('error')?.size ?? 0).toBe(0)
    expect(mocks.listeners.get('update-downloaded')?.size ?? 0).toBe(0)
  })

  it('prepares the application to quit before installing a downloaded update', async () => {
    const order: string[] = []
    const prepareToQuit = vi.fn(async () => { order.push('prepare') })
    mocks.autoUpdater.quitAndInstall.mockImplementation(() => { order.push('install') })
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const updater = startDesktopUpdater(app(false), window, lifecycle(prepareToQuit))

    mocks.emit('update-downloaded')
    await flushMicrotasks()

    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(prepareToQuit).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
    expect(order).toEqual(['prepare', 'install'])
    updater.dispose()
  })

  it('does not open the update prompt after disposal', async () => {
    const updater = startDesktopUpdater(app(false), window, lifecycle())

    updater.dispose()
    mocks.emit('update-downloaded')
    await flushMicrotasks()

    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
