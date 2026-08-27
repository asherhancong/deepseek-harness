/** Signed-release update policy for the desktop application. */

import type { App, BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Functions the main process needs to stop its owned backend before replacement. */
export interface UpdateLifecycle {
  /** Enter the unguarded quit path and stop the owned DSH backend. */
  prepareToQuit(): Promise<void>
}

/** Update controls exposed to the native application menu. */
export interface DesktopUpdater {
  /** Ask the configured GitHub provider for a newer signed release. */
  check(): Promise<void>
  /** Stop scheduled checks. */
  dispose(): void
}

/**
 * Start packaged-only update checks and prompt after a release is downloaded.
 * The generated app-update.yml owns the feed; callers never replace it at runtime.
 * @param app - Electron application instance.
 * @param window - owner for update dialogs.
 * @param lifecycle - backend shutdown required before quitAndInstall.
 * @returns update controls for the native menu and application teardown.
 */
export function startDesktopUpdater(
  app: App,
  window: BrowserWindow,
  lifecycle: UpdateLifecycle,
): DesktopUpdater {
  let disposed = false
  let installing = false
  let interval: NodeJS.Timeout | undefined
  let initialCheck: NodeJS.Timeout | undefined

  const check = async (): Promise<void> => {
    if (!app.isPackaged || disposed) return
    try {
      await autoUpdater.checkForUpdatesAndNotify()
    } catch (error) {
      console.error('[desktop-updater] update check failed:', error)
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  const onError = (error: Error): void => {
    console.error('[desktop-updater] updater error:', error)
  }
  const onUpdateDownloaded = (): void => {
    if (disposed) return
    void dialog.showMessageBox(window, {
      type: 'info',
      title: 'DSH Update Ready',
      message: 'A new version of DSH is ready to install.',
      detail: 'Restart DSH to finish the update.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(async ({ response }) => {
      if (disposed || response !== 0 || installing) return
      installing = true
      await lifecycle.prepareToQuit()
      autoUpdater.quitAndInstall()
    }).catch((error: unknown) => {
      console.error('[desktop-updater] update prompt failed:', error)
    })
  }
  autoUpdater.on('error', onError)
  autoUpdater.on('update-downloaded', onUpdateDownloaded)

  if (app.isPackaged) {
    initialCheck = setTimeout(() => { void check() }, 3_000)
    initialCheck.unref()
    interval = setInterval(() => { void check() }, UPDATE_INTERVAL_MS)
    interval.unref()
  }

  return {
    check,
    dispose() {
      if (disposed) return
      disposed = true
      if (initialCheck !== undefined) clearTimeout(initialCheck)
      if (interval !== undefined) clearInterval(interval)
      autoUpdater.removeListener('error', onError)
      autoUpdater.removeListener('update-downloaded', onUpdateDownloaded)
    },
  }
}
