/** Electron main process for the macOS DSH desktop distribution. */

import { appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'
import { BackendProcess, DESKTOP_BACKEND_PORT } from './backend-process.ts'
import {
  createDesktopCapability,
  desktopCapabilityUrls,
  withDesktopCapability,
} from './desktop-auth.ts'
import { externalUrl, isAllowedNavigation } from './window-policy.ts'
import { startDesktopUpdater, type DesktopUpdater } from './updater.ts'

const DESKTOP_ORIGIN = `http://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}`
const require = createRequire(import.meta.url)
let mainWindow: BrowserWindow | undefined
let backend: BackendProcess | undefined
let updater: DesktopUpdater | undefined
let quitting = false
let quitPromise: Promise<void> | undefined

/** Resolve the staged packaged CLI or the workspace dependency in development. */
function resolveCliEntry(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'dsh-runtime',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
  }
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifest), 'lib', 'bin.js')
}

/** Resolve one desktop-only resource in source and packaged layouts. */
function resolveDesktopResource(filename: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, filename)
    : join(app.getAppPath(), 'resources', filename)
}

/** Install request, navigation, and permission rules before the first page loads. */
function secureDesktopSession(capability: string): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permission === 'clipboard-sanitized-write'
      && isAllowedNavigation(requestingOrigin, DESKTOP_ORIGIN)
      && details.isMainFrame)
  desktopSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write'
      && isAllowedNavigation(details.requestingUrl, DESKTOP_ORIGIN)
      && details.isMainFrame)
  })
  desktopSession.webRequest.onBeforeSendHeaders({
    urls: desktopCapabilityUrls(DESKTOP_ORIGIN),
  }, (details, callback) => {
    callback({
      requestHeaders: withDesktopCapability(details.requestHeaders, capability),
    })
  })
  desktopSession.webRequest.onHeadersReceived({ urls: [`${DESKTOP_ORIGIN}/*`] }, (details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data:",
      `connect-src 'self' ws://127.0.0.1:${String(DESKTOP_BACKEND_PORT)}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

/** Create the native window after the owned backend has announced readiness. */
function createWindow(url: URL): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAllowedNavigation(target, url.origin)) void window.loadURL(target)
    else {
      const external = externalUrl(target)
      if (external !== undefined) void shell.openExternal(external)
    }
    return { action: 'deny' }
  })
  const guardNavigation = (event: Electron.Event, target: string): void => {
    if (isAllowedNavigation(target, url.origin)) return
    event.preventDefault()
    const external = externalUrl(target)
    if (external !== undefined) void shell.openExternal(external)
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.once('ready-to-show', () => { window.show() })
  void window.loadURL(url.href)
  return window
}

/** Install a compact native menu whose update action shares the automatic updater. */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => { void updater?.check() } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]))
}

/** Stop the backend once; callers may await the same bounded shutdown. */
function stopBackend(): Promise<void> {
  quitPromise ??= backend?.stop() ?? Promise.resolve()
  return quitPromise
}

/** Mark the next quit as intentional, detach update listeners, and stop the Host. */
async function prepareToQuit(): Promise<void> {
  quitting = true
  updater?.dispose()
  await stopBackend()
}

/** Start the DSH backend, then expose only its verified loopback origin. */
async function launch(): Promise<void> {
  if (quitting) return
  app.setAppLogsPath()
  const logPath = join(app.getPath('logs'), 'desktop-backend.log')
  const capability = createDesktopCapability()
  backend = new BackendProcess({
    cliEntry: resolveCliEntry(),
    bootstrapEntry: resolveDesktopResource('backend-bootstrap.cjs'),
    patchEntry: resolveDesktopResource('desktop.cordis.patch.yml'),
    desktopCapability: capability,
    cwd: app.getPath('home'),
    electronExecutable: process.execPath,
    port: DESKTOP_BACKEND_PORT,
    writeLog: async (line) => { await appendFile(logPath, line) },
  })
  backend.onUnexpectedExit((failure) => {
    if (quitting) return
    dialog.showErrorBox('DSH Backend Stopped', failure.message)
    app.quit()
  })
  const url = await backend.start()
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- before-quit can change this state while backend readiness is pending.
  if (quitting) return
  secureDesktopSession(capability)
  mainWindow = createWindow(url)
  updater = startDesktopUpdater(app, mainWindow, { prepareToQuit })
  installMenu()
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => { event.preventDefault() })
  })
  app.on('activate', () => {
    if (mainWindow !== undefined) mainWindow.show()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    void prepareToQuit().finally(() => { app.quit() })
  })
  app.whenReady().then(launch).catch((error: unknown) => {
    if (quitting) return
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('DSH Could Not Start', message)
    app.quit()
  })
}
