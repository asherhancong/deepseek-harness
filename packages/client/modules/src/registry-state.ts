/**
 * Transport-independent package inventory and module-graph state behind
 * {@link ClientModuleRegistry}. The caller supplies bundle locators;
 * this module resolves package metadata, hashes artifacts, and reconciles
 * enabled package names without importing Cordis or an HTTP server.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { optionalStringArray } from './client/manifest.ts'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'
import { orderByModuleGraph } from './module-graph.ts'

/** Resolve one package id to its exported package.json file. */
export type ResolveClientPackageJson = (packageName: string) => string

/** Project one bundle identity and revision onto the locator carried by the boot graph. */
export type LocateClientBundle = (id: string, rev: string) => string

/** One enabled-state reconciliation requested by the owning runtime. */
export interface ClientModuleRegistryChange {
  /** Loader entry name, equal to the package id. */
  id: string
  /** Whether at least one live, enabled Loader entry currently owns the id. */
  enabled: boolean
}

/** Result of one batched registry reconciliation. */
export interface ClientModuleRegistryUpdate {
  /** Whether a new ordered graph was committed. */
  changed: boolean
  /** Per-package failures plus any whole-graph ordering failure. */
  failures: Error[]
}

/** package.json `dsh.client` declaration fields, validated one by one after reading the file. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
  /** Non-baseline module-table requests declared by this package. */
  external?: string[]
}

/** The declared fields a graph row carries, normalized (absent array declarations become empty). */
interface WebBootRowFields {
  inject?: string[]
  /** Module specifiers the package requests from the module table. */
  external: string[]
  immediately: boolean
}

/** Resolved package metadata for one `dsh.client` package (cached per name, never expires). */
interface PkgMeta extends WebBootRowFields {
  clientPath: string
}

/** Recovery instruction shared by grouped startup and steady-state bundle diagnostics. */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** Missing built client export, retained as structured data for activation-error grouping. */
class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

/** Activation failures grouped by actionable package-build errors and unrelated failures. */
export class ClientPackageCompositionError extends AggregateError {
  /**
   * Group activation failures under one package-oriented diagnostic.
   * @param failures - failures collected while composing the initial Loader entries.
   */
  constructor(failures: Error[]) {
    const missingBundles = failures.filter((error): error is MissingClientBundleError => error instanceof MissingClientBundleError)
    const otherFailures = failures.filter(error => !(error instanceof MissingClientBundleError))
    const packageNoun = failures.length === 1 ? 'package' : 'packages'
    const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`]
    if (missingBundles.length > 0) {
      lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`)
      for (const error of missingBundles) {
        lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`)
      }
    }
    if (otherFailures.length > 0) {
      lines.push('  other failures:', ...otherFailures.map(error => `    - ${error.message}`))
    }
    super(failures, lines.join('\n'))
  }
}

/** One composed table row: the wire entry plus the resolved package metadata behind it. */
interface ClientModuleRecord {
  entry: WebBootEntry
  meta: PkgMeta
}

/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/**
 * Mutable registry data whose committed graph stays identity-stable between
 * successful reconciliations.
 */
export class ClientModuleRegistryState {
  private readonly table = new Map<string, ClientModuleRecord>()
  // Negative verdicts (unresolvable specifier — builtins like cordis:include,
  // subpath rows — or a package without a web `dsh.client` declaration) are
  // cached as null and never expire: plugin-set changes take effect on restart.
  private readonly pkgMeta = new Map<string, PkgMeta | null>()
  private composed: WebBootGraph

  /**
   * Create an empty registry state.
   * @param resolvePackageJson - package resolver anchored at the composing config tree.
   * @param locateBundle - caller-owned projection from bundle identity to boot locator.
   */
  constructor(
    private readonly resolvePackageJson: ResolveClientPackageJson,
    private readonly locateBundle: LocateClientBundle,
  ) {
    this.composed = this.compose()
  }

  /**
   * Current composed entry graph (stable object between changes).
   * @returns the latest successfully ordered graph.
   */
  graph(): WebBootGraph {
    return this.composed
  }

  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined {
    return this.table.get(id)?.meta.clientPath
  }

  /**
   * Re-hash one bundle without changing its package metadata.
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const rev = shortHash(readFileSync(record.meta.clientPath))
    if (rev === record.entry.rev) return rev
    record.entry = this.graphRow(id, rev, record.meta)
    this.composed = this.compose()
    return rev
  }

  /**
   * Apply enabled-state changes and commit one newly ordered graph.
   * Package failures do not stop other changes; a whole-graph ordering failure
   * leaves the last successfully composed graph active.
   * @param changes - package ids whose live enabled state changed or needs reconciliation.
   * @returns whether a graph committed plus every collected failure.
   */
  reconcile(changes: Iterable<ClientModuleRegistryChange>): ClientModuleRegistryUpdate {
    let changed = false
    const failures: Error[] = []
    for (const change of changes) {
      try {
        if (this.processOne(change)) changed = true
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (!changed) return { changed: false, failures }
    try {
      this.composed = this.compose()
    } catch (error) {
      failures.push(error as Error)
      return { changed: false, failures }
    }
    return { changed: true, failures }
  }

  private compose(): WebBootGraph {
    const entries = orderByModuleGraph([...this.table.values()].map(record => record.entry))
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  private resolveMeta(pkgName: string): PkgMeta | null {
    const cached = this.pkgMeta.get(pkgName)
    if (cached !== undefined) return cached
    let pkgPath: string
    try {
      pkgPath = this.resolvePackageJson(pkgName)
    } catch {
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries (…/gateway) land here — permanently not a client row.
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      pkgName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      external: decl.external ?? [],
      immediately: decl.immediately === true,
    }
    this.pkgMeta.set(pkgName, meta)
    return meta
  }

  /** Read the activation-time bundle revision. */
  private initialBundleRevision(pkgName: string, clientPath: string): string {
    try {
      return shortHash(readFileSync(clientPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(pkgName, clientPath, error)
    }
  }

  /** Reconcile one package id against its current enabled state. */
  private processOne(change: ClientModuleRegistryChange): boolean {
    if (!change.enabled) return this.table.delete(change.id)
    if (this.table.has(change.id)) return false
    const meta = this.resolveMeta(change.id)
    if (meta === null) return false
    // The rev rides the row from here on: a fiber restart reuses the row (and
    // its rev) untouched; only rebuilt() re-reads the bundle.
    const rev = this.initialBundleRevision(change.id, meta.clientPath)
    this.table.set(change.id, { entry: this.graphRow(change.id, rev, meta), meta })
    return true
  }

  /** Project one registry record into the caller's boot locator. */
  private graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
    return {
      id,
      url: this.locateBundle(id, rev),
      rev,
      ...(fields.inject !== undefined ? { inject: fields.inject } : {}),
      ...(fields.immediately ? { immediately: true } : {}),
      ...(fields.external.length > 0 ? { external: fields.external } : {}),
    }
  }
}
