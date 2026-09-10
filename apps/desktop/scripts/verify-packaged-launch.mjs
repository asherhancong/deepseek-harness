/** Launch the real packaged Electron entry, pass keyless onboarding, and await complete shutdown. */
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'

const origin = 'http://127.0.0.1:43121'
const startupTimeout = 60_000
const shutdownTimeout = 15_000

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

async function deadline(task, timeout, label) {
  let timer
  try {
    return await Promise.race([task, new Promise((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(label + ' timed out')) }, timeout)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function portAvailable() {
  const server = createServer()
  return new Promise((resolveAvailable, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolveAvailable(false)
      else reject(error)
    })
    server.listen({ host: '127.0.0.1', port: 43121, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolveAvailable(true))
    })
  })
}

async function awaitPortRelease() {
  const until = Date.now() + shutdownTimeout
  do {
    if (await portAvailable()) return
    await delay(100)
  } while (Date.now() < until)
  throw new Error('Port 43121 remains occupied after the owned application exited; no other process was stopped')
}

async function awaitOwnedGroupExit(child) {
  // Playwright starts a separate POSIX process group whose ID is the returned PID.
  // Signal 0 only observes that group; it never stops a different DSH instance.
  const until = Date.now() + shutdownTimeout
  do {
    try {
      process.kill(-child.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await delay(100)
  } while (Date.now() < until)
  throw new Error('Owned Electron process group still has live members after shutdown')
}

/**
 * Compare existing filesystem targets, accepting aliases but rejecting links outside the owned directory.
 * @param root - owned directory, including any platform path alias.
 * @param candidate - existing application path reported by Electron.
 * @returns whether both names resolve to the same directory or its descendant.
 */
export async function containsRealPath(root, candidate) {
  const [rootPath, candidatePath] = await Promise.all([realpath(root), realpath(candidate)])
  const suffix = relative(rootPath, candidatePath)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
}

async function isolatedEnvironment(root) {
  const homeDirectory = join(root, 'home')
  const temporaryDirectory = join(root, 'tmp')
  const electronDirectory = join(root, 'electron')
  await Promise.all([homeDirectory, temporaryDirectory, electronDirectory].map(path => mkdir(path, { mode: 0o700 })))
  // Only the child receives these paths. The caller's environment is never changed.
  return {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      HOME: homeDirectory,
      CFFIXED_USER_HOME: homeDirectory,
      TMPDIR: temporaryDirectory,
      DSH_HOME: join(homeDirectory, '.dsh'),
      DSH_AGENTS_HOME: join(homeDirectory, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    homeDirectory,
    electronDirectory,
  }
}

function observeExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise(resolveExit => {
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
}

async function closeApplication(application, child, exited) {
  try {
    // Playwright's close calls the real app.quit(), including DSH's backend teardown.
    await deadline(application.close(), shutdownTimeout, 'Graceful Electron quit')
    const result = await deadline(exited, shutdownTimeout, 'Electron process exit')
    if (result.code !== 0 || result.signal !== null) {
      throw new Error('Electron exit was not clean: ' + JSON.stringify(result))
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try {
        await deadline(exited, 5_000, 'Owned Electron SIGTERM exit')
      } catch {
        // Only the process returned by this launch is eligible for forced cleanup.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await deadline(exited, 5_000, 'Owned Electron SIGKILL exit')
      }
    }
    throw new Error('Packaged launch did not shut down cleanly: ' + message(error), { cause: error })
  }
}

/**
 * Verify the supplied bundle without changing its signed contents or using existing user data.
 * @param applicationInput Absolute or relative path to the actual DSH.app bundle.
 * @param evidenceInput Optional directory for a screenshot and keyless diagnostic report; existing files are not replaced.
 * @returns The observed packaged application identity and successful keyless startup result.
 */
export async function verifyPackagedLaunch(applicationInput, evidenceInput) {
  if (process.platform !== 'darwin') throw new Error('The packaged macOS launch check requires macOS')
  if (!applicationInput) throw new Error('Usage: verify-packaged-launch.mjs <DSH.app> [evidence-directory]')
  const bundle = await realpath(resolve(applicationInput))
  if (!bundle.endsWith('.app')) throw new Error('The launch target must be a .app bundle')
  const executable = join(bundle, 'Contents/MacOS/DSH')
  await access(executable, constants.X_OK)
  await access(join(bundle, 'Contents/Resources/app.asar'))
  // The product uses a fixed port. This preflight cannot reserve it across launch;
  // a concurrent claimant must make startup fail, never become a process we attach to or stop.
  if (!await portAvailable()) throw new Error('Port 43121 is already in use. Close the other DSH instance before this check; it was not touched')

  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-packaged-launch-')))
  let application
  let child
  let exited
  let page
  let report
  let backendLogPath
  let log = ''
  let stopping = false
  let portReleased = false
  let groupReleased = false
  const failures = []
  const fatal = Promise.withResolvers()
  // Rejections may arrive between awaited Playwright operations.
  void fatal.promise.catch(() => {})
  const fail = error => { if (!stopping) fatal.reject(error instanceof Error ? error : new Error(String(error))) }
  const onUnhandled = error => {
    // Playwright's parallel startup observers can reject together after a native crash.
    // Keep that failure observable while allowing the owned-process cleanup to finish.
    failures.push(error)
    fail(error)
  }
  process.on('unhandledRejection', onUnhandled)
  const observe = task => Promise.race([task, fatal.promise])
  const startupDeadline = setTimeout(() => { fail(new Error('Packaged Electron startup deadline expired')) }, startupTimeout)
  const record = chunk => {
    log = (log + String(chunk)).slice(-24_000)
    if (/Uncaught Exception|A JavaScript error occurred|UnhandledPromiseRejection|SyntaxError:|Named export .+ not found/u.test(log)) {
      fail(new Error('Packaged Electron main process reported an exception'))
    }
  }
  try {
    const isolation = await isolatedEnvironment(root)
    application = await _electron.launch({
      executablePath: executable,
      cwd: isolation.homeDirectory,
      env: isolation.env,
      args: [
        '--user-data-dir=' + isolation.electronDirectory,
        '--no-proxy-server',
        '--password-store=basic',
        '--use-mock-keychain',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
      chromiumSandbox: true,
      bypassCSP: false,
      timeout: startupTimeout,
    })
    child = application.process()
    exited = observeExit(child)
    void exited.then(result => { fail(new Error('Electron exited before verification completed: ' + JSON.stringify(result))) })
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    application.on('console', entry => {
      // The real updater also logs expected DNS failures through its own unprefixed logger.
      if (entry.type() === 'error') record(entry.text() + '\n')
    })
    const identity = await observe(application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      logs: app.getPath('logs'),
      electronVersion: process.versions.electron,
    })))
    report = { bundle, ...identity }
    if (!identity.packaged || await realpath(identity.appPath) !== join(bundle, 'Contents/Resources/app.asar')) {
      throw new Error('Electron did not load the supplied packaged ASAR entry')
    }
    for (const path of [identity.home, identity.userData, identity.sessionData, identity.logs]) {
      if (!await containsRealPath(root, path)) throw new Error('Electron did not use isolated application paths: ' + path)
    }
    backendLogPath = join(identity.logs, 'desktop-backend.log')
    page = await observe(application.firstWindow({ timeout: startupTimeout }))
    page.on('pageerror', fail)
    page.on('crash', () => { fail(new Error('DSH renderer crashed')) })
    page.on('requestfailed', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        fail(new Error('DSH navigation failed: ' + String(request.failure()?.errorText)))
      }
    })
    await observe(page.waitForURL(url => url.origin === origin, { timeout: startupTimeout }))
    const welcome = page.getByRole('dialog', { name: /^(Internal Testing Notice|内测声明)$/u })
    await observe(welcome.waitFor({ state: 'visible', timeout: startupTimeout }))
    await observe(welcome.getByRole('button', { name: /^(Continue|继续)$/u }).click({ timeout: startupTimeout }))
    await observe(page.getByRole('button', { name: /^(Configure later|稍后配置)$/u }).click({ timeout: startupTimeout }))
    await observe(page.getByRole('button', { name: /^(Settings|设置)$/u }).waitFor({ state: 'visible', timeout: startupTimeout }))
    await observe(page.waitForFunction(expectedOrigin => location.origin === expectedOrigin
      && document.querySelector('#root')?.textContent.trim().length > 30
      && !document.querySelector('[role="dialog"]'), origin, { timeout: startupTimeout }))
    const pageErrors = await page.pageErrors()
    if (pageErrors.length !== 0) throw new Error('DSH renderer errors: ' + pageErrors.map(message).join('; '))
    report = { bundle, ...identity, origin: new URL(page.url()).origin, onboarding: 'continued-without-api-key' }
    if (evidenceInput) {
      const evidence = resolve(evidenceInput)
      await mkdir(evidence, { recursive: true, mode: 0o700 })
      await writeFile(join(evidence, 'launch.png'), await observe(page.screenshot({ timeout: 5_000 })), { flag: 'wx', mode: 0o600 })
    }
    await observe(Promise.resolve())
  } catch (error) {
    failures.push(error)
  } finally {
    clearTimeout(startupDeadline)
    stopping = true
    if (application) {
      try { await closeApplication(application, child, exited) } catch (error) { failures.push(error) }
    }
    try {
      if (child) await awaitOwnedGroupExit(child)
      groupReleased = true
    } catch (error) { failures.push(error) }
    try {
      await awaitPortRelease()
      portReleased = true
    } catch (error) {
      failures.push(error)
    }
    if (evidenceInput) {
      try {
        const evidence = resolve(evidenceInput)
        await mkdir(evidence, { recursive: true, mode: 0o700 })
        if (backendLogPath) {
          let backendLog
          try {
            if (!await containsRealPath(root, backendLogPath)) throw new Error('Backend log escaped the isolated home')
            backendLog = await readFile(backendLogPath, 'utf8')
          } catch (error) {
            // A failure before Host startup may leave no backend log in the verified temporary home.
            if (error.code !== 'ENOENT') throw error
          }
          if (backendLog !== undefined) {
            await writeFile(join(evidence, 'backend.log'), backendLog.slice(-24_000), { flag: 'wx', mode: 0o600 })
          }
        }
        await writeFile(join(evidence, 'launch.log'), log + '\n', { flag: 'wx', mode: 0o600 })
        await writeFile(join(evidence, 'launch.json'), JSON.stringify({
          ...report, passed: failures.length === 0, portReleased, groupReleased,
          exit: child ? { code: child.exitCode, signal: child.signalCode } : null,
          errors: failures.map(message),
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      } catch (error) { failures.push(error) }
    }
    try {
      if (portReleased && groupReleased && (!child || child.exitCode !== null || child.signalCode !== null)) {
        await rm(root, { recursive: true, force: true })
      } else {
        failures.push(new Error('Retained launch state for unfinished process cleanup: ' + root))
      }
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }
  if (failures.length !== 0) throw new AggregateError(failures, failures.map(message).join('\n') + (log ? '\nElectron output:\n' + log : ''))
  return report
}

if (import.meta.main) {
  verifyPackagedLaunch(process.argv[2], process.argv[3]).then(
    report => { console.log(JSON.stringify({ ...report, passed: true }, null, 2)) },
    error => { console.error(message(error)); process.exitCode = 1 },
  )
}
