/** Pure URL decisions used by the desktop BrowserWindow security policy. */

const DESKTOP_LOOPBACK_HOST = '127.0.0.1'

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Decide whether a top-level navigation stays within the desktop-owned server.
 * @param targetUrl - URL Chromium wants the main frame to load.
 * @param applicationOrigin - Verified desktop backend origin.
 * @returns True only for HTTP URLs on the exact same 127.0.0.1 origin.
 */
export function isAllowedNavigation(targetUrl: string, applicationOrigin: string): boolean {
  const target = parseUrl(targetUrl)
  const application = parseUrl(applicationOrigin)
  if (target === undefined || application === undefined) return false
  if (application.protocol !== 'http:' || application.hostname !== DESKTOP_LOOPBACK_HOST) return false
  return target.protocol === 'http:'
    && target.hostname === DESKTOP_LOOPBACK_HOST
    && target.origin === application.origin
}

/**
 * Return a canonical URL for a safe system-browser handoff.
 * Non-Web schemes are denied instead of reaching Electron's shell API.
 * @param targetUrl - URL requested by a new window or blocked navigation.
 * @returns The canonical HTTP(S) URL, or undefined when the scheme is denied.
 */
export function externalUrl(targetUrl: string): string | undefined {
  const target = parseUrl(targetUrl)
  if (target === undefined || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return undefined
  }
  return target.href
}
