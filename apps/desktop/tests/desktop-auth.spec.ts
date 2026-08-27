import { describe, expect, it } from 'vitest'
import {
  createDesktopCapability,
  desktopCapabilityUrls,
  DESKTOP_CAPABILITY_HEADER,
  withDesktopCapability,
} from '../src/main/desktop-auth.ts'

describe('desktop capability', () => {
  it('generates independent 256-bit base64url values', () => {
    const first = createDesktopCapability()
    const second = createDesktopCapability()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  it('overwrites every renderer-controlled spelling of its request header', () => {
    const capability = 'A'.repeat(43)
    expect(withDesktopCapability({
      Accept: 'application/json',
      'X-DSH-Desktop-Capability': 'renderer-value',
    }, capability)).toEqual({
      Accept: 'application/json',
      [DESKTOP_CAPABILITY_HEADER]: capability,
    })
  })

  it('covers both HTTP requests and WebSocket upgrades at the exact desktop origin', () => {
    expect(desktopCapabilityUrls('http://127.0.0.1:43121')).toEqual([
      'http://127.0.0.1:43121/*',
      'ws://127.0.0.1:43121/*',
    ])
    expect(() => desktopCapabilityUrls('https://127.0.0.1:43121')).toThrow(/plain HTTP origin/)
    expect(() => desktopCapabilityUrls('http://127.0.0.1:43121/path')).toThrow(/plain HTTP origin/)
  })
})
