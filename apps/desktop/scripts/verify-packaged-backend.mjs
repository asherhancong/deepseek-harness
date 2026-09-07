#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const releaseDirectory = join(desktopDirectory, 'release')
const desktopOrigin = 'http://127.0.0.1:43121'
const capabilityHeader = 'x-dsh-desktop-capability'
const streamPath = '/api/remote.mux'

function resolveApplication() {
  const requested = process.argv[2]
  if (requested !== undefined) return resolve(requested)

  const candidates = process.arch === 'arm64'
    ? [join(releaseDirectory, 'mac-arm64', 'DSH.app')]
    : [
        join(releaseDirectory, 'mac', 'DSH.app'),
        join(releaseDirectory, 'mac-x64', 'DSH.app'),
      ]
  for (const candidate of candidates) {
    const executable = join(candidate, 'Contents', 'MacOS', 'DSH')
    if (existsSync(executable)) return candidate
  }
  throw new Error(`no packaged DSH.app matches the runner architecture ${process.arch}`)
}

/**
 * Probe one upgrade and await closure of its WebSocket and any rejected HTTP exchange.
 * @param WebSocket - WebSocket constructor from the staged Gateway dependency.
 * @param headers - request authorization headers.
 * @param expected - expected HTTP rejection status or successful open.
 * @returns observed status after all probe resources close.
 */
export async function websocketProbe(WebSocket, headers, expected) {
  const websocket = new WebSocket(`${desktopOrigin.replace('http:', 'ws:')}${streamPath}`, { headers })
  const closed = Promise.withResolvers()
  const result = Promise.withResolvers()
  const onError = error => { result.reject(error) }
  const onClose = () => {
    websocket.off('error', onError)
    closed.resolve()
    result.reject(new Error('WebSocket closed before the probe observed an upgrade response'))
  }
  const onOpen = () => {
    if (expected === 'open') result.resolve('open')
    else result.reject(new Error(`WebSocket opened while expecting HTTP ${String(expected)}`))
  }
  let rejectedExchange
  const onResponse = (request, response) => {
    rejectedExchange = [request, response]
    if (response.statusCode === expected) result.resolve(String(response.statusCode))
    else result.reject(new Error(
      `WebSocket returned HTTP ${String(response.statusCode)} while expecting ${String(expected)}`,
    ))
  }
  websocket.once('close', onClose)
  websocket.on('error', onError)
  websocket.once('open', onOpen)
  websocket.once('unexpected-response', onResponse)
  const timer = setTimeout(() => {
    result.reject(new Error(`WebSocket probe timed out while expecting ${String(expected)}`))
  }, 10_000)
  try {
    return await result.promise
  } finally {
    clearTimeout(timer)
    const streams = rejectedExchange ?? []
    const listeners = []
    const streamClosures = streams.map(stream => stream.closed === true
      ? Promise.resolve()
      : new Promise(resolveClose => {
        listeners.push([stream, resolveClose])
        stream.once('close', resolveClose)
      }))
    // ws emits close after aborting a rejected upgrade, before the HTTP
    // request necessarily closes. Observe both owners before the next probe.
    websocket.terminate()
    for (const stream of streams) stream.destroy()
    let deadline
    try {
      await Promise.race([
        Promise.all([closed.promise, ...streamClosures]),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => {
            reject(new Error('WebSocket probe resources did not close after termination'))
          }, 5_000)
        }),
      ])
    } finally {
      clearTimeout(deadline)
      for (const [stream, listener] of listeners) stream.off('close', listener)
      websocket.off('open', onOpen)
      websocket.off('unexpected-response', onResponse)
      // The close observer retains the error handler until a late close if
      // the teardown deadline failed; a later abort must not crash the process.
    }
  }
}

/**
 * Stop the owned backend and observe exit before deleting its temporary home.
 * @param child - the backend process owned by this smoke run.
 * @returns completion after exit; rejects if SIGKILL fails to stop the child.
 */
export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers()
  const onExit = () => { exited.resolve() }
  child.once('exit', onExit)
  const force = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
  let deadline
  try {
    child.kill('SIGTERM')
    await Promise.race([
      exited.promise,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error('packaged backend did not exit after SIGKILL'))
        }, 10_000)
      }),
    ])
  } finally {
    clearTimeout(force)
    clearTimeout(deadline)
    child.off('exit', onExit)
  }
}

async function main() {
  const application = resolveApplication()
  const resources = join(application, 'Contents', 'Resources')
  const runtime = join(resources, 'dsh-runtime')
  const executable = join(application, 'Contents', 'MacOS', 'DSH')
  const bootstrap = join(resources, 'backend-bootstrap.cjs')
  const patch = join(resources, 'desktop.cordis.patch.yml')
  const cli = realpathSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const runtimeRequire = createRequire(realpathSync(
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'package.json'),
  ))
  const WebSocket = runtimeRequire('ws')
  for (const required of [executable, bootstrap, patch, join(resources, 'app.asar')]) statSync(required)

  const capability = randomBytes(32).toString('base64url')
  const workDirectory = mkdtempSync(join(tmpdir(), 'dsh-packaged-backend-smoke-'))
  const childEnvironment = {
    ...process.env,
    DSH_HOME: workDirectory,
    ELECTRON_RUN_AS_NODE: '1',
  }
  delete childEnvironment.DSH_DESKTOP_CAPABILITY
  delete childEnvironment.DSH_DESKTOP_PARENT_PID

  const child = spawn(executable, [
    '--expose-internals',
    '--require', bootstrap,
    cli,
    'web',
    '--patch', patch,
    '--host', '127.0.0.1',
    '--port', '43121',
    '--no-open',
  ], {
    cwd: workDirectory,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })

  let output = ''
  let pendingStdout = ''
  let readinessSettled = false
  let resolveReady
  let rejectReady
  const readiness = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  const readinessTimer = setTimeout(() => {
    if (readinessSettled) return
    readinessSettled = true
    rejectReady(new Error('packaged backend readiness timed out'))
  }, 45_000)
  const recordOutput = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-12_000)
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    recordOutput(chunk)
    if (readinessSettled) return
    const lines = `${pendingStdout}${chunk}`.split('\n')
    pendingStdout = lines.pop().slice(-12_000)
    if (!lines.some(line => line.replace(/\r$/u, '') === `dsh web: ${desktopOrigin}`)) return
    readinessSettled = true
    clearTimeout(readinessTimer)
    resolveReady()
  })
  child.stderr?.on('data', recordOutput)
  child.once('error', (error) => {
    if (readinessSettled) return
    readinessSettled = true
    clearTimeout(readinessTimer)
    rejectReady(error)
  })
  child.once('exit', (code, signal) => {
    if (readinessSettled) return
    readinessSettled = true
    clearTimeout(readinessTimer)
    rejectReady(new Error(`packaged backend exited before readiness (${String(code)}/${String(signal)})`))
  })

  const launchPipe = child.stdio[3]
  if (launchPipe === null || !('end' in launchPipe)) {
    await stopChild(child)
    throw new Error('packaged backend secure launch pipe is unavailable')
  }
  launchPipe.on('error', recordOutput)
  launchPipe.end(JSON.stringify({ capability, parentPid: process.pid }))

  try {
    await readiness
    const statuses = {}
    for (const probe of [
      { label: 'indexMissingCapability', path: '/', headers: {} },
      {
        label: 'indexWrongCapability',
        path: '/',
        headers: { [capabilityHeader]: 'B'.repeat(43) },
      },
      {
        label: 'indexAuthenticated',
        path: '/',
        headers: { [capabilityHeader]: capability },
      },
      { label: 'missingCapability', path: streamPath, headers: {} },
      {
        label: 'wrongCapability',
        path: streamPath,
        headers: { [capabilityHeader]: 'B'.repeat(43) },
      },
      {
        label: 'authenticated',
        path: streamPath,
        headers: { [capabilityHeader]: capability },
      },
    ]) {
      const response = await fetch(`${desktopOrigin}${probe.path}`, {
        headers: probe.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      statuses[probe.label] = response.status
      const body = await response.text()
      if (body.includes(capability) || response.headers.get('set-cookie') !== null) {
        throw new Error('packaged backend exposed a desktop capability or minted an authentication cookie')
      }
      if (probe.label === 'indexAuthenticated' && !body.includes('__DSH_BOOT__')) {
        throw new Error('packaged backend index omitted the Web client bootstrap')
      }
    }
    const expectedStatuses = {
      indexMissingCapability: 401,
      indexWrongCapability: 401,
      indexAuthenticated: 200,
      missingCapability: 401,
      wrongCapability: 401,
      authenticated: 404,
    }
    if (JSON.stringify(statuses) !== JSON.stringify(expectedStatuses)) {
      throw new Error(
        `packaged backend HTTP authorization mismatch: ${JSON.stringify(statuses)}`,
      )
    }

    const deniedWebSocket = await websocketProbe(WebSocket, {}, 401)
    const wrongCapabilityWebSocket = await websocketProbe(
      WebSocket,
      { [capabilityHeader]: 'B'.repeat(43) },
      401,
    )
    const authorizedWebSocket = await websocketProbe(
      WebSocket,
      { [capabilityHeader]: capability },
      'open',
    )
    if (output.includes(capability) || /[?&]token=/u.test(output)) {
      throw new Error('packaged backend printed authentication material instead of a clean readiness URL')
    }
    process.stdout.write(`${JSON.stringify({
      application,
      http: statuses,
      websocket: {
        path: streamPath,
        missingCapability: deniedWebSocket,
        wrongCapability: wrongCapabilityWebSocket,
        authenticated: authorizedWebSocket,
      },
      capabilityTransport: 'private-fd-3',
    }, null, 2)}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const diagnostic = output.replaceAll(capability, '[redacted]')
      .replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1[redacted]')
    throw new Error(`${detail}\nPackaged backend output:\n${diagnostic}`, { cause: error })
  } finally {
    clearTimeout(readinessTimer)
    await stopChild(child)
    rmSync(workDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
