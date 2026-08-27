/** Per-launch capability helpers for the desktop-only loopback API. */

import { randomBytes } from 'node:crypto'

/** Request header verified by `@deepseek-ai/dsh-client-connection`. */
export const DESKTOP_CAPABILITY_HEADER = 'x-dsh-desktop-capability'

/** Create one unguessable capability that lives only for this app launch. */
export function createDesktopCapability(): string {
  return randomBytes(32).toString('base64url')
}

/** Exact Electron request-filter patterns for every desktop-origin transport. */
export function desktopCapabilityUrls(httpOrigin: string): string[] {
  const http = new URL(httpOrigin)
  if (http.protocol !== 'http:' || http.pathname !== '/' || http.search !== '' || http.hash !== '') {
    throw new Error('desktop capability origin must be a plain HTTP origin')
  }
  const websocket = new URL(http.origin)
  websocket.protocol = 'ws:'
  return [`${http.origin}/*`, `${websocket.origin}/*`]
}

/**
 * Replace any renderer-supplied spelling of the capability header with the
 * trusted value owned by Electron's session layer.
 */
export function withDesktopCapability(
  headers: Record<string, string>,
  capability: string,
): Record<string, string> {
  const authorized = Object.fromEntries(Object.entries(headers)
    .filter(([name]) => name.toLowerCase() !== DESKTOP_CAPABILITY_HEADER))
  authorized[DESKTOP_CAPABILITY_HEADER] = capability
  return authorized
}
