import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  interface QuitEvent { preventDefault(): void }
  function newState() {
    return {
      ready: Promise.withResolvers<undefined>(),
      backendReady: Promise.withResolvers<URL>(),
      backendStarted: Promise.withResolvers<undefined>(),
      stopStarted: Promise.withResolvers<undefined>(),
      stopped: Promise.withResolvers<undefined>(),
      quitCompleted: Promise.withResolvers<undefined>(),
      beforeQuit: undefined as ((event: QuitEvent) => void) | undefined,
      launchTask: undefined as Promise<void> | undefined,
    }
  }
  let state = newState()
  const app = {
    isPackaged: false,
    name: 'DSH',
    requestSingleInstanceLock: vi.fn(() => true),
    getAppPath: vi.fn(() => '/test-app'),
    getPath: vi.fn((name: string) => '/test-paths/' + name),
    setAppLogsPath: vi.fn(),
    on: vi.fn((event: string, listener: (event: QuitEvent) => void) => {
      if (event === 'before-quit') state.beforeQuit = listener
    }),
    // The Electron-boundary adapter exposes completion of the real main module's
    // ready/launch/catch chain without sleeps or assumptions about microtask count.
    whenReady: vi.fn(() => ({
      then: (launch: () => Promise<void>) => ({
        catch: (onError: (error: unknown) => void) => {
          state.launchTask = state.ready.promise.then(launch).catch(onError)
          return state.launchTask
        },
      }),
    })),
    quit: vi.fn(() => {
      let prevented = false
      state.beforeQuit?.({ preventDefault: () => { prevented = true } })
      if (!prevented) state.quitCompleted.resolve(undefined)
    }),
  }
  const backend = {
    start: vi.fn(() => {
      state.backendStarted.resolve(undefined)
      return state.backendReady.promise
    }),
    stop: vi.fn(() => {
      state.stopStarted.resolve(undefined)
      return state.stopped.promise
    }),
    onUnexpectedExit: vi.fn(),
  }
  const createBackend = vi.fn(function () { return backend })
  const createWindow = vi.fn(function () {
    return {
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
      on: vi.fn(),
      once: vi.fn(),
      loadURL: vi.fn(async () => {}),
      show: vi.fn(),
      hide: vi.fn(),
    }
  })
  return {
    get state() { return state },
    reset() { state = newState() },
    app,
    backend,
    createBackend,
    createWindow,
    showErrorBox: vi.fn(),
    startUpdater: vi.fn(() => ({ dispose: vi.fn(), check: vi.fn(async () => {}) })),
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.createWindow,
  dialog: { showErrorBox: harness.showErrorBox },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((template: unknown) => template) },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
    },
  },
  shell: { openExternal: vi.fn(async () => {}) },
}))

vi.mock('../src/main/backend-process.ts', () => ({
  BackendProcess: harness.createBackend,
  DESKTOP_BACKEND_PORT: 43121,
}))

vi.mock('../src/main/updater.ts', () => ({ startDesktopUpdater: harness.startUpdater }))

async function launchSettled(): Promise<void> {
  const task = harness.state.launchTask
  if (!task) throw new Error('Main did not register its launch chain')
  await task
}

async function importMain(): Promise<void> {
  await import('../src/main/index.ts')
}

async function beginBackendStartup(): Promise<void> {
  await importMain()
  harness.state.ready.resolve(undefined)
  await harness.state.backendStarted.promise
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.reset()
})

afterEach(async () => {
  // Release every owned barrier even after an assertion fails, then await the
  // registered startup chain and intentional-quit completion before the next case.
  harness.app.quit()
  harness.state.ready.resolve(undefined)
  harness.state.backendReady.resolve(new URL('http://127.0.0.1:43121'))
  harness.state.stopped.resolve(undefined)
  if (harness.state.launchTask) await harness.state.launchTask
  await harness.state.quitCompleted.promise
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('desktop quit during startup', () => {
  it('does not launch a backend after quitting before Electron becomes ready', async () => {
    await importMain()
    harness.app.quit()
    await harness.state.quitCompleted.promise
    harness.state.ready.resolve(undefined)
    harness.state.backendReady.resolve(new URL('http://127.0.0.1:43121'))
    await launchSettled()

    expect(harness.createBackend).not.toHaveBeenCalled()
    expect(harness.createWindow).not.toHaveBeenCalled()
    expect(harness.startUpdater).not.toHaveBeenCalled()
    expect(harness.showErrorBox).not.toHaveBeenCalled()
  })

  it('does not display a startup error when requested shutdown rejects readiness', async () => {
    await beginBackendStartup()
    harness.app.quit()
    await harness.state.stopStarted.promise
    harness.state.backendReady.reject(new Error('desktop backend: process exited before readiness'))
    await launchSettled()
    harness.state.stopped.resolve(undefined)
    await harness.state.quitCompleted.promise

    expect(harness.backend.stop).toHaveBeenCalledOnce()
    expect(harness.showErrorBox).not.toHaveBeenCalled()
    expect(harness.createWindow).not.toHaveBeenCalled()
    expect(harness.startUpdater).not.toHaveBeenCalled()
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
  })

  it('does not create a window or updater when backend readiness wins after quit starts', async () => {
    await beginBackendStartup()
    harness.app.quit()
    await harness.state.stopStarted.promise
    harness.state.backendReady.resolve(new URL('http://127.0.0.1:43121'))
    await launchSettled()
    harness.state.stopped.resolve(undefined)
    await harness.state.quitCompleted.promise

    expect(harness.createWindow).not.toHaveBeenCalled()
    expect(harness.startUpdater).not.toHaveBeenCalled()
    expect(harness.showErrorBox).not.toHaveBeenCalled()
    expect(harness.backend.stop).toHaveBeenCalledOnce()
  })

  it('still reports a genuine startup failure and stops its backend', async () => {
    await beginBackendStartup()
    harness.state.backendReady.reject(new Error('invalid backend configuration'))
    await launchSettled()
    harness.state.stopped.resolve(undefined)
    await harness.state.quitCompleted.promise

    expect(harness.showErrorBox).toHaveBeenCalledExactlyOnceWith('DSH Could Not Start', 'invalid backend configuration')
    expect(harness.backend.stop).toHaveBeenCalledOnce()
    expect(harness.createWindow).not.toHaveBeenCalled()
    expect(harness.startUpdater).not.toHaveBeenCalled()
  })
})
