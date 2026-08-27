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

function websocketProbe(WebSocket, headers, expected) {
  return new Promise((resolveProbe, reject) => {
    const websocket = new WebSocket(`${desktopOrigin.replace('http:', 'ws:')}/api/events.host`, { headers })
    const timer = setTimeout(() => {
      websocket.terminate()
      reject(new Error(`WebSocket probe timed out while expecting ${String(expected)}`))
    }, 10_000)

    websocket.once('open', () => {
      if (expected !== 'open') {
        clearTimeout(timer)
        websocket.terminate()
        reject(new Error(`WebSocket opened while expecting HTTP ${String(expected)}`))
        return
      }
      clearTimeout(timer)
      websocket.close()
      resolveProbe('open')
    })
    websocket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      if (response.statusCode !== expected) {
        reject(new Error(
          `WebSocket returned HTTP ${String(response.statusCode)} while expecting ${String(expected)}`,
        ))
        return
      }
      resolveProbe(String(response.statusCode))
    })
    websocket.once('error', (error) => {
      if (expected === 'open') {
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
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
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
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
    if (readinessSettled || !output.includes(`dsh web: ${desktopOrigin}`)) return
    readinessSettled = true
    clearTimeout(readinessTimer)
    resolveReady()
  }
  child.stdout?.on('data', recordOutput)
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
      { label: 'static', path: '/', headers: {} },
      { label: 'missingCapability', path: '/api/events.host', headers: {} },
      {
        label: 'wrongCapability',
        path: '/api/events.host',
        headers: { [capabilityHeader]: 'B'.repeat(43) },
      },
      {
        label: 'authenticated',
        path: '/api/events.host',
        headers: { [capabilityHeader]: capability },
      },
    ]) {
      const response = await fetch(`${desktopOrigin}${probe.path}`, { headers: probe.headers })
      statuses[probe.label] = response.status
      await response.arrayBuffer()
    }
    const expectedStatuses = {
      static: 200,
      missingCapability: 401,
      wrongCapability: 401,
      authenticated: 426,
    }
    if (JSON.stringify(statuses) !== JSON.stringify(expectedStatuses)) {
      throw new Error(
        `packaged backend HTTP authorization mismatch: ${JSON.stringify(statuses)}`,
      )
    }

    const deniedWebSocket = await websocketProbe(WebSocket, {}, 401)
    const authorizedWebSocket = await websocketProbe(
      WebSocket,
      { [capabilityHeader]: capability },
      'open',
    )
    process.stdout.write(`${JSON.stringify({
      application,
      http: statuses,
      websocket: { missingCapability: deniedWebSocket, authenticated: authorizedWebSocket },
      capabilityTransport: 'private-fd-3',
    }, null, 2)}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}\nPackaged backend output:\n${output}`, { cause: error })
  } finally {
    clearTimeout(readinessTimer)
    await stopChild(child)
    rmSync(workDirectory, { recursive: true, force: true })
  }
}

await main()
