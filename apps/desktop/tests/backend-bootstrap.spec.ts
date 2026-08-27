import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const bootstrap = fileURLToPath(new URL('../resources/backend-bootstrap.cjs', import.meta.url))
const capability = 'A'.repeat(43)

function bootstrapEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_DESKTOP_CAPABILITY: 'stale-environment-value',
    DSH_DESKTOP_PARENT_PID: '999',
    ELECTRON_RUN_AS_NODE: '1',
  }
}

async function runBootstrap(
  launchPayload: unknown,
  program: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--require', bootstrap, '--eval', program], {
    env: bootstrapEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const childStdout = child.stdout
  const childStderr = child.stderr
  if (childStdout === null || childStderr === null) {
    child.kill('SIGKILL')
    throw new Error('desktop bootstrap test requires piped stdout and stderr')
  }
  childStdout.setEncoding('utf8')
  childStderr.setEncoding('utf8')
  childStdout.on('data', (chunk: string) => { stdout += chunk })
  childStderr.on('data', (chunk: string) => { stderr += chunk })
  const launchPipe = child.stdio[3] as Writable | null
  if (launchPipe === null) {
    child.kill('SIGKILL')
    throw new Error('desktop bootstrap test requires the launch pipe')
  }
  launchPipe.on('error', () => {})
  launchPipe.end(JSON.stringify(launchPayload))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  return { code, signal, stdout, stderr }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

describe('desktop backend bootstrap', () => {
  it('moves the private-pipe capability into a sealed global and scrubs launch-only environment values', async () => {
    const probe = await runBootstrap({ capability, parentPid: process.pid }, `
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__DSH_DESKTOP_CAPABILITY__')
        process.stdout.write(JSON.stringify({
          capability: descriptor?.value,
          configurable: descriptor?.configurable,
          enumerable: descriptor?.enumerable,
          writable: descriptor?.writable,
          capabilityEnv: process.env.DSH_DESKTOP_CAPABILITY,
          parentPidEnv: process.env.DSH_DESKTOP_PARENT_PID,
          electronNodeMode: process.env.ELECTRON_RUN_AS_NODE,
        }))
      `)

    expect(probe.code, probe.stderr).toBe(0)
    expect(probe.signal).toBeNull()
    expect(JSON.parse(probe.stdout)).toEqual({
      capability,
      configurable: false,
      enumerable: false,
      writable: false,
    })
  })

  it('fails before loading the CLI without a valid 256-bit capability', async () => {
    const invalid = await runBootstrap(
      { capability: 'guessable', parentPid: process.pid },
      'process.stdout.write("unreachable")',
    )
    expect(invalid.code).not.toBe(0)
    expect(invalid.stderr).toContain('requires a fresh 256-bit launch capability')
    expect(invalid.stdout).toBe('')
  })

  it('terminates when a live claimed owner PID is not the actual parent', async () => {
    const unrelatedPid = process.ppid
    expect(unrelatedPid).toBeGreaterThan(1)
    expect(processExists(unrelatedPid)).toBe(true)
    const mismatched = await runBootstrap(
      { capability, parentPid: unrelatedPid },
      'setInterval(() => {}, 60_000)',
    )
    expect(mismatched.code).toBeNull()
    expect(mismatched.signal).toBe('SIGTERM')
  }, 5_000)

  it('terminates an orphaned backend after its Electron parent disappears', async () => {
    const launcher = spawnSync(process.execPath, ['--eval', `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, [
        '--require', ${JSON.stringify(bootstrap)},
        '--eval', 'setInterval(() => {}, 60_000)',
      ], {
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      })
      child.stdio[3].end(JSON.stringify({ capability: ${JSON.stringify(capability)}, parentPid: process.pid }))
      process.stdout.write(String(child.pid))
      child.unref()
    `], { encoding: 'utf8', env: bootstrapEnvironment() })
    expect(launcher.status, launcher.stderr).toBe(0)
    const orphanPid = Number(launcher.stdout)
    expect(Number.isSafeInteger(orphanPid) && orphanPid > 0).toBe(true)

    try {
      await vi.waitFor(() => {
        expect(processExists(orphanPid)).toBe(false)
      }, { interval: 100, timeout: 5_000 })
    } finally {
      if (processExists(orphanPid)) process.kill(orphanPid, 'SIGKILL')
    }
  }, 10_000)
})
