import { describe, expect, it } from 'vitest'
import { externalUrl, isAllowedNavigation } from '../src/main/window-policy.ts'

describe('isAllowedNavigation', () => {
  const origin = 'http://127.0.0.1:43121'

  it.each([
    'http://127.0.0.1:43121/',
    'http://127.0.0.1:43121/session/abc?panel=files#latest',
  ])('allows the exact desktop loopback origin: %s', (target) => {
    expect(isAllowedNavigation(target, origin)).toBe(true)
  })

  it.each([
    'https://127.0.0.1:43121/',
    'http://localhost:43121/',
    'http://127.0.0.1:43122/',
    'http://127.0.0.2:43121/',
    'file:///tmp/index.html',
    'javascript:alert(1)',
    '/relative/path',
    'not a url',
  ])('rejects navigation outside that origin: %s', (target) => {
    expect(isAllowedNavigation(target, origin)).toBe(false)
  })

  it.each([
    'https://127.0.0.1:43121',
    'http://localhost:43121',
    'not a url',
  ])('fails closed when the configured application origin is not trusted: %s', (applicationOrigin) => {
    expect(isAllowedNavigation('http://127.0.0.1:43121/', applicationOrigin)).toBe(false)
  })
})

describe('externalUrl', () => {
  it.each([
    ['https://example.com/docs?q=dsh', 'https://example.com/docs?q=dsh'],
    ['HTTP://EXAMPLE.COM', 'http://example.com/'],
  ])('canonicalizes an HTTP(S) system-browser handoff: %s', (target, expected) => {
    expect(externalUrl(target)).toBe(expected)
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'mailto:test@example.com',
    'dsh://session/1',
    '/relative/path',
    'not a url',
  ])('denies non-HTTP(S) and malformed external targets: %s', (target) => {
    expect(externalUrl(target)).toBeUndefined()
  })
})
