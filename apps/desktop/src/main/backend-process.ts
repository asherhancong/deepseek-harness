/** Lifecycle wrapper for the local `dsh web` process owned by the desktop app. */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Writable } from 'node:stream'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const STDERR_TAIL_LIMIT = 8_192

/** Dedicated loopback port used by the packaged desktop application. */
export const DESKTOP_BACKEND_PORT = 43_121

/** Clock surface used for deterministic startup and shutdown tests. */
export interface BackendClock {
  /** Schedule one callback and return its opaque timer token. */
  setTimeout(callback: () => void, delayMs: number): unknown
  /** Cancel one previously scheduled timer. */
  clearTimeout(token: unknown): void
}

/** Terminal state of the owned backend process. */
export type BackendProcessExit =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error }

/** Narrow spawn seam used by production and injected test doubles. */
export type BackendSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Inputs used to launch and supervise the desktop-owned Web backend. */
export interface BackendProcessOptions {
  /** Built `@deepseek-ai/dsh` CLI entry. */
  cliEntry: string
  /** Desktop bootstrap required before importing the CLI. */
  bootstrapEntry: string
  /** Desktop-only Cordis overlay that enables capability authentication. */
  patchEntry: string
  /** Fresh 256-bit capability shared only with the Electron request layer. */
  desktopCapability: string
  /** Explicit working directory inherited by the Host composition and sessions. */
  cwd: string
  /** Electron executable put into Node mode for the CLI child. */
  electronExecutable: string
  /** Fixed desktop-only loopback port. */
  port?: number
  /** Maximum wait for the exact URL announcement. */
  startupTimeoutMs?: number
  /** Grace after SIGTERM before escalating to SIGKILL. */
  shutdownTimeoutMs?: number
  /** Environment inherited by the child before forcing Electron's Node mode. */
  env?: NodeJS.ProcessEnv
  /** Optional serialized sink for raw stdout and stderr chunks. */
  writeLog?: (text: string) => void | Promise<void>
  /** Process factory replaced by tests. */
  spawn?: BackendSpawn
  /** Timer implementation replaced by tests. */
  clock?: BackendClock
}

const SYSTEM_CLOCK: BackendClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (token) => { clearTimeout(token as ReturnType<typeof setTimeout>) },
}

const productionSpawn: BackendSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], options)

function positiveDelay(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`desktop backend: ${name} must be a positive finite number`)
  }
  return value
}

function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('desktop backend: port must be an integer from 1 through 65535')
  }
  return port
}

function nonEmpty(name: string, value: string): string {
  if (value === '') throw new Error(`desktop backend: ${name} must not be empty`)
  return value
}

function appendTail(previous: string, chunk: string): string {
  const combined = previous + chunk
  return combined.length <= STDERR_TAIL_LIMIT ? combined : combined.slice(-STDERR_TAIL_LIMIT)
}

function withStderr(message: string, stderrTail: string): Error {
  const diagnostic = stderrTail.trim()
  return new Error(diagnostic === '' ? message : `${message}\n${diagnostic}`)
}

function describeTerminal(exit: BackendProcessExit): string {
  return exit.kind === 'error'
    ? `process error: ${exit.error.message}`
    : `process exited (code ${String(exit.code)}, signal ${String(exit.signal)})`
}

/**
 * Owns one Electron-as-Node CLI child from launch through forced termination.
 * A backend is ready only when that child's stdout emits the exact configured
 * loopback URL line; probing an unrelated listener on the port is insufficient.
 */
export class BackendProcess {
  readonly #cliEntry: string
  readonly #bootstrapEntry: string
  readonly #patchEntry: string
  readonly #desktopCapability: string
  readonly #cwd: string
  readonly #electronExecutable: string
  readonly #port: number
  readonly #startupTimeoutMs: number
  readonly #shutdownTimeoutMs: number
  readonly #env: NodeJS.ProcessEnv
  readonly #writeLog: BackendProcessOptions['writeLog']
  readonly #spawn: BackendSpawn
  readonly #clock: BackendClock

  #child: ChildProcess | undefined
  #terminal: BackendProcessExit | undefined
  #terminalListeners = new Set<(exit: BackendProcessExit) => void>()
  #unexpectedExitListeners = new Set<(failure: Error) => void>()
  #unexpectedFailure: Error | undefined
  #stderrTail = ''
  #ready = false
  #stopping = false
  #startTask: Promise<URL> | undefined
  #stopTask: Promise<void> | undefined
  #logTask: Promise<void> = Promise.resolve()

  /**
   * Validate and retain one process configuration without spawning yet.
   * @param options - Executable, child arguments, lifecycle policy, and test seams.
   */
  constructor(options: BackendProcessOptions) {
    this.#cliEntry = nonEmpty('cliEntry', options.cliEntry)
    this.#bootstrapEntry = nonEmpty('bootstrapEntry', options.bootstrapEntry)
    this.#patchEntry = nonEmpty('patchEntry', options.patchEntry)
    this.#desktopCapability = nonEmpty('desktopCapability', options.desktopCapability)
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.#desktopCapability)) {
      throw new Error('desktop backend: desktopCapability must encode exactly 32 random bytes as base64url')
    }
    this.#cwd = nonEmpty('cwd', options.cwd)
    this.#electronExecutable = nonEmpty('electronExecutable', options.electronExecutable)
    this.#port = validPort(options.port ?? DESKTOP_BACKEND_PORT)
    this.#startupTimeoutMs = positiveDelay(
      'startupTimeoutMs',
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    )
    this.#shutdownTimeoutMs = positiveDelay(
      'shutdownTimeoutMs',
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    )
    this.#env = options.env ?? process.env
    this.#writeLog = options.writeLog
    this.#spawn = options.spawn ?? productionSpawn
    this.#clock = options.clock ?? SYSTEM_CLOCK
  }

  /**
   * Register for a terminal failure after readiness, excluding requested stops.
   * @param listener - Observer invoked once for an unexpected terminal state.
   * @returns A function that removes the listener.
   */
  onUnexpectedExit(listener: (failure: Error) => void): () => void {
    if (this.#unexpectedFailure !== undefined) {
      try {
        listener(this.#unexpectedFailure)
      } catch (error) {
        this.#log(`desktop backend: unexpected-exit listener threw: ${String(error)}\n`)
      }
      return () => {}
    }
    this.#unexpectedExitListeners.add(listener)
    return () => { this.#unexpectedExitListeners.delete(listener) }
  }

  /**
   * Spawn once and resolve with the verified loopback URL.
   * @returns The canonical application URL announced by the owned child.
   */
  start(): Promise<URL> {
    if (this.#startTask !== undefined) return this.#startTask
    if (this.#stopping) return Promise.reject(new Error('desktop backend: cannot start after stop'))
    this.#startTask = this.#start()
    return this.#startTask
  }

  /**
   * Coalesce graceful stops and escalate to SIGKILL after the configured grace.
   * @returns A promise that resolves after the child exits and queued logs flush.
   */
  stop(): Promise<void> {
    this.#stopping = true
    this.#stopTask ??= this.#stop()
    return this.#stopTask
  }
  async #start(): Promise<URL> {
    const urlText = `http://${LOOPBACK_HOST}:${String(this.#port)}`
    const url = new URL(urlText)
    const readinessLine = `dsh web: ${urlText}`
    const child = this.#spawn(this.#electronExecutable, [
      '--expose-internals',
      '--require', this.#bootstrapEntry,
      this.#cliEntry,
      'web',
      '--patch', this.#patchEntry,
      '--host', LOOPBACK_HOST,
      '--port', String(this.#port),
      '--no-open',
    ], {
      cwd: this.#cwd,
      env: {
        ...this.#env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    child.once('error', (error) => { this.#publishTerminal({ kind: 'error', error }) })
    child.once('exit', (code, signal) => { this.#publishTerminal({ kind: 'exit', code, signal }) })

    const launchPipe = child.stdio[3] as Writable | null | undefined
    if (launchPipe === null || launchPipe === undefined) {
      child.kill('SIGKILL')
      throw new Error('desktop backend: secure launch pipe is unavailable')
    }
    launchPipe.once('error', (error) => {
      this.#log(`desktop backend: secure launch pipe failed: ${String(error)}\n`)
    })
    launchPipe.end(JSON.stringify({
      capability: this.#desktopCapability,
      parentPid: process.pid,
    }))

    if (child.stdout === null) {
      void this.stop()
      throw new Error('desktop backend: child stdout is unavailable')
    }
    const stdout = child.stdout
    stdout.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.#stderrTail = appendTail(this.#stderrTail, chunk)
      this.#log(chunk)
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let pendingLine = ''
      let unsubscribeTerminal = (): void => {}
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        this.#clock.clearTimeout(startupTimer)
        unsubscribeTerminal()
        if (error === undefined) resolve()
        else reject(error)
      }
      const startupTimer = this.#clock.setTimeout(() => {
        finish(withStderr(
          `desktop backend: timed out after ${String(this.#startupTimeoutMs)}ms waiting for ${readinessLine}`,
          this.#stderrTail,
        ))
        void this.stop()
      }, this.#startupTimeoutMs)
      unsubscribeTerminal = this.#subscribeTerminal((exit) => {
        finish(withStderr(
          `desktop backend: ${describeTerminal(exit)} before readiness`,
          this.#stderrTail,
        ))
      })
      stdout.on('data', (chunk: string) => {
        this.#log(chunk)
        if (settled) return
        const lines = (pendingLine + chunk).split('\n')
        pendingLine = lines.pop() ?? ''
        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          if (line === readinessLine) {
            this.#ready = true
            finish()
            return
          }
        }
      })
    })

    return url
  }

  async #stop(): Promise<void> {
    const child = this.#child
    if (child === undefined || this.#terminal !== undefined) {
      await this.#logTask
      return
    }
    this.#unexpectedExitListeners.clear()
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = this.#clock.setTimeout(() => {
        if (this.#terminal === undefined) child.kill('SIGKILL')
      }, this.#shutdownTimeoutMs)
      this.#subscribeTerminal(() => {
        this.#clock.clearTimeout(timer)
        resolve()
      })
    })
    await this.#logTask
  }

  #publishTerminal(exit: BackendProcessExit): void {
    if (this.#terminal !== undefined) return
    this.#terminal = exit
    for (const listener of [...this.#terminalListeners]) listener(exit)
    this.#terminalListeners.clear()
    if (!this.#ready || this.#stopping) return
    const failure = withStderr(
      `desktop backend: ${describeTerminal(exit)} after readiness`,
      this.#stderrTail,
    )
    this.#unexpectedFailure = failure
    for (const listener of [...this.#unexpectedExitListeners]) {
      try {
        listener(failure)
      } catch (error) {
        this.#log(`desktop backend: unexpected-exit listener threw: ${String(error)}\n`)
      }
    }
    this.#unexpectedExitListeners.clear()
  }

  #subscribeTerminal(listener: (exit: BackendProcessExit) => void): () => void {
    if (this.#terminal !== undefined) {
      listener(this.#terminal)
      return () => {}
    }
    this.#terminalListeners.add(listener)
    return () => { this.#terminalListeners.delete(listener) }
  }

  #log(text: string): void {
    if (this.#writeLog === undefined) return
    this.#logTask = this.#logTask
      .then(async () => { await this.#writeLog?.(text) })
      .catch(() => {
        // Diagnostic I/O failures must not change backend availability.
      })
  }
}
