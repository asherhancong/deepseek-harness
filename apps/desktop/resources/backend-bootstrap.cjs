'use strict'

const { closeSync, readFileSync } = require('node:fs')

// This file is loaded by Electron-as-Node before the DSH CLI entry. Keep the
// capability in backend memory for Cordis interpolation. Electron sends it
// over a private one-shot pipe: never argv, environment, renderer, or disk.
const capabilityGlobalName = '__DSH_DESKTOP_CAPABILITY__'
let launchPayload
try {
  launchPayload = JSON.parse(readFileSync(3, 'utf8'))
} catch (error) {
  throw new Error('DSH desktop backend could not read its secure launch channel', { cause: error })
} finally {
  try {
    closeSync(3)
  } catch {
    // A failed read may already have closed or never opened the descriptor.
  }
}

// Scrub stale or caller-injected spellings as defense in depth. The secure
// channel above is the only source of truth.
delete process.env.DSH_DESKTOP_CAPABILITY
delete process.env.DSH_DESKTOP_PARENT_PID
delete process.env.ELECTRON_RUN_AS_NODE

const capability = launchPayload?.capability
if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
  throw new Error('DSH desktop backend requires a fresh 256-bit launch capability')
}
const electronParentPid = launchPayload?.parentPid
if (!Number.isSafeInteger(electronParentPid) || electronParentPid <= 1) {
  throw new Error('DSH desktop backend received an invalid Electron owner PID')
}

Object.defineProperty(globalThis, capabilityGlobalName, {
  configurable: false,
  enumerable: false,
  value: capability,
  writable: false,
})

// A normal application quit asks the Host to shut down directly. This guard
// covers Electron crashes and force-kills, where Unix would otherwise reparent
// the long-running backend and leave the fixed port occupied.
let parentLossHandled = false
const parentWatchdog = setInterval(() => {
  if (parentLossHandled) return
  let parentExists = process.ppid === electronParentPid
  if (parentExists) {
    try {
      process.kill(electronParentPid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') parentExists = false
      else if (error?.code !== 'EPERM') throw error
    }
  }
  if (parentExists) return
  parentLossHandled = true
  clearInterval(parentWatchdog)
  process.kill(process.pid, 'SIGTERM')
}, 1_000)
parentWatchdog.unref()
