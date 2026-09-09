/** Types for release JSON accepted after source-run and archive validation. */

/** Release identity resolved independently of downloaded checkpoint artifacts. */
export interface ReleaseIdentity {
  repository: string
  runId: number
  commit: string
  tag: string
  version: string
}

/** One signed application archive retained for an Apple notarization submission. */
export interface Archive {
  arch: 'arm64' | 'x64'
  file: string
  sha256: string
  size: number
}

/** Validated original-run identity and both retained architecture archives. */
export interface Checkpoint extends ReleaseIdentity {
  schemaVersion: 1
  workflow: string
  runAttempt: 1
  teamId: string
  archives: Archive[]
}

/** Validated Apple submission ID bound to one original-run archive. */
export interface Receipt extends Omit<Checkpoint, 'archives'>, Archive {
  id: string
}

/** Documented Apple submission states accepted by the release workflow. */
export type NotaryStatus = 'Accepted' | 'In Progress' | 'Invalid' | 'Rejected'

/** Validated updater file record with electron-builder extension fields retained. */
export interface UpdateFile {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
  [key: string]: unknown
}

/** Merged architecture metadata with the x64 ZIP legacy download pointer. */
export interface UpdateManifest {
  version: string
  files: UpdateFile[]
  path: string
  sha512: string
  releaseDate?: string
}

/**
 * Validate the completed original GitHub run against an independently resolved release identity.
 * @param run Raw GitHub Actions run response.
 * @param expected Independently resolved source run and current release identity.
 * @returns The validated response; throws on malformed or mismatched input.
 */
export function validateRun(run: unknown, expected: unknown): unknown

/**
 * Validate both retained archives and their original source-run identity.
 * @param checkpoint Parsed release checkpoint JSON.
 * @param expected Independently resolved source run and current release identity.
 * @returns The validated checkpoint; throws on malformed or mismatched input.
 */
export function validateCheckpoint(checkpoint: unknown, expected: unknown): Checkpoint

/**
 * Validate a submission receipt against its source run and retained archive.
 * @param receipt Parsed submission receipt JSON.
 * @param checkpoint Checkpoint for the same release; its fields are revalidated.
 * @param arch Requested archive architecture.
 * @returns The validated receipt; throws on malformed or mismatched input.
 */
export function validateReceipt(receipt: unknown, checkpoint: unknown, arch: unknown): Receipt

/**
 * Classify only documented Apple states for the recorded submission.
 * @param info Parsed notarytool info JSON.
 * @param id Submission UUID from a validated receipt.
 * @returns The Apple state; throws on unknown states or a submission ID mismatch.
 */
export function classifyNotary(info: unknown, id: string): NotaryStatus

/**
 * Merge one DMG/ZIP manifest per architecture, preserving each artifact's fields.
 * @param manifests Two parsed electron-builder YAML mappings.
 * @param version Expected desktop package version.
 * @returns Ordered artifact records and x64 legacy metadata; throws on invalid inputs.
 */
export function mergeUpdateManifests(manifests: unknown, version: string): UpdateManifest
