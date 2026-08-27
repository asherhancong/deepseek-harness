/**
 * Node half of the client module system (`dsh.client` dual-face package).
 * `ClientModuleRegistry` translates live Loader entries into registry-state
 * reconciliations, preserves the public HMR notification API, and installs
 * the existing WebServer binding. Package resolution, artifact hashing, and
 * graph composition live in a Cordis- and transport-independent state object;
 * the Web binding alone owns `/plugins` and HTML boot injection.
 * @module @deepseek-ai/dsh-client-modules
 */

import { createRequire } from 'node:module'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebBootGraph } from './client/manifest.ts'
import {
  ClientModuleRegistryState,
  ClientPackageCompositionError,
  type ClientModuleRegistryChange,
} from './registry-state.ts'
import { bindClientModulesToWeb, webClientBundleUrl } from './web-binding.ts'

export { stripClientSuffix } from './client/manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'
export { orderByModuleGraph } from './module-graph.ts'
export { bootInjections } from './web-binding.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web plugin table (provided by the client-modules node half). */
    clientModules: ClientModuleRegistry
  }
}

/**
 * The web plugin table service: incremental `dsh.client` scan, HMR-facing
 * graph notifications, and the WebServer binding. Construction runs the
 * activation scan synchronously — malformed declarations or missing bundles
 * among already-loaded entries aggregate into one loud throw.
 */
export class ClientModuleRegistry extends Service {
  static inject = ['webServer', 'loader']

  private readonly state: ClientModuleRegistryState
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private flushQueued = false

  /**
   * Build the service: subscribe, seed, run the activation flush, and bind the
   * committed graph to the WebServer.
   * @param ctx - plugin context carrying webServer and loader.
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    // Resolution anchor: the config tree's baseUrl (the cordis.yml directory,
    // whose package declares every composed plugin as a dependency). The
    // modules package's own URL would miss sibling packages under pnpm's
    // isolated node_modules.
    if (ctx.baseUrl === undefined) {
      throw new Error('client-modules: ctx.baseUrl is unset — the node half needs the config-tree anchor to resolve plugin packages')
    }
    const require = createRequire(ctx.baseUrl)
    this.state = new ClientModuleRegistryState(
      spec => require.resolve(`${spec}/package.json`),
      webClientBundleUrl,
    )

    // Subscribe before seeding so a fiber arriving mid-activation lands in the
    // same dirty set (Set idempotence makes the overlap harmless). An entry-less
    // fiber is a child plugin or a manual mount — never a loader row; O(1) drop.
    ctx.on('internal/plugin', (fiber) => {
      const entryName = fiber.entry?.options.name
      if (entryName === undefined) return
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        this.flush((err) => { ctx.logger.warn(err) })
      })
    })

    // Activation pass: the initial scan IS the incremental path over the
    // current entries, flushed synchronously (nothing async between subscribe,
    // seed, and flush).
    for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)
    const failures: Error[] = []
    this.flush(err => failures.push(err))
    if (failures.length > 0) {
      throw new ClientPackageCompositionError(failures)
    }

    bindClientModulesToWeb(ctx, this)
  }

  /**
   * Current composed entry graph (stable object between changes).
   * @returns the graph served as `window.__DSH_BOOT__`.
   */
  graph(): WebBootGraph {
    return this.state.graph()
  }

  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined {
    return this.state.clientPath(id)
  }

  /**
   * Re-hash one bundle (the HMR watch's registration hook — the only entry
   * point through which bundle content changes reach the graph).
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const previous = this.state.graph()
    const rev = this.state.rebuilt(id)
    if (rev === undefined || this.state.graph() === previous) return rev
    for (const notify of this.rebuildListeners) {
      // Containment: rebuilt() runs inside the HMR watch callback — a
      // throwing subscriber must not kill the poll or skip later subscribers.
      try {
        notify(id, rev)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    this.notifyGraphChanged()
    return rev
  }

  /**
   * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
   * @param listener - receives the entry id and its new bundle rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  /**
   * Fires after any flush that recomposed the graph (row added/removed, or a
   * rebuilt rev change). Pull model: listeners re-read {@link graph}.
   * @param listener - notified with no payload.
   * @returns the unsubscriber.
   */
  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  private notifyGraphChanged(): void {
    for (const listener of this.graphListeners) {
      // A throwing subscriber must not skip later subscribers (or escape into
      // whatever triggered the flush — possibly an fs watch callback).
      try {
        listener()
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  private flush(onError: (err: Error) => void): void {
    const changes: ClientModuleRegistryChange[] = []
    for (const entryName of this.dirty) {
      let enabled = false
      for (const entry of this.ctx.loader.entries()) {
        if (entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled) {
          enabled = true
          break
        }
      }
      changes.push({ id: entryName, enabled })
    }
    this.dirty.clear()
    const update = this.state.reconcile(changes)
    for (const failure of update.failures) onError(failure)
    if (update.changed) this.notifyGraphChanged()
  }
}

export default ClientModuleRegistry
