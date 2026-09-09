/** Validate persisted release identities and merge architecture-specific update metadata. */

import assert from 'node:assert/strict'

const workflow = '.github/workflows/desktop-release.yml'
const teamId = 'YZM63RX87F'
const architectures = ['arm64', 'x64']
const sha256Pattern = /^[a-f0-9]{64}$/u
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function check(condition, message) {
  assert(condition, `desktop release: ${message}`)
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validateExpected(expected) {
  check(isMapping(expected), 'expected release identity must be a mapping')
  check(typeof expected.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expected.repository), 'invalid expected repository')
  check(positiveInteger(expected.runId), 'expected source run ID must be a positive safe integer')
  check(typeof expected.commit === 'string' && /^[a-f0-9]{40}$/u.test(expected.commit), 'invalid expected commit')
  check(typeof expected.version === 'string' && versionPattern.test(expected.version), 'invalid expected version')
  check(expected.tag === `desktop-v${expected.version}`, 'expected tag does not match desktop version')
  check(expected.workflow === undefined || expected.workflow === workflow, 'unexpected release workflow')
  check(expected.teamId === undefined || expected.teamId === teamId, 'unexpected signing team')
}

function validateIdentity(value, expected, label) {
  check(isMapping(value), `${label} must be a mapping`)
  check(value.schemaVersion === 1, `${label} schema version must be 1`)
  for (const field of ['repository', 'runId', 'commit', 'tag', 'version']) {
    check(value[field] === expected[field], `${label} ${field} mismatch`)
  }
  check(value.workflow === workflow, `${label} workflow mismatch`)
  check(value.runAttempt === 1, `${label} must belong to the original run attempt`)
  check(value.teamId === teamId, `${label} signing team mismatch`)
}

/**
 * Reject a source run from another repository, workflow, commit, tag, or run attempt.
 * @param run Raw GitHub Actions run response.
 * @param expected Independently resolved source run and current release identity.
 * @returns The completed, matching original run; throws on mismatched or malformed input.
 */
export function validateRun(run, expected) {
  validateExpected(expected)
  check(isMapping(run), 'source run must be a mapping')
  check(run.id === expected.runId, 'source run ID mismatch')
  check(run.repository?.full_name === expected.repository, 'source run repository mismatch')
  check(run.path === workflow, 'source run workflow mismatch')
  check(run.head_sha === expected.commit, 'source run commit mismatch')
  check(run.head_branch === expected.tag, 'source run tag mismatch')
  check(run.event === 'push' || run.event === 'workflow_dispatch', 'unsupported source run event')
  check(run.status === 'completed', 'source run is not completed')
  check(run.run_attempt === 1, 'source run must be the original attempt')
  return run
}

/**
 * Validate both retained archive records against an independently resolved release identity.
 * @param checkpoint Parsed release checkpoint JSON.
 * @param expected Independently resolved source run and current release identity.
 * @returns The validated checkpoint; throws before any archive can be consumed on mismatch.
 */
export function validateCheckpoint(checkpoint, expected) {
  validateExpected(expected)
  validateIdentity(checkpoint, expected, 'checkpoint')
  check(Array.isArray(checkpoint.archives) && checkpoint.archives.length === 2,
    'checkpoint must contain exactly two architecture archives')
  const seen = new Set()
  for (const archive of checkpoint.archives) {
    check(isMapping(archive), 'checkpoint archive must be a mapping')
    check(architectures.includes(archive.arch), 'unsupported checkpoint architecture')
    check(!seen.has(archive.arch), 'duplicate checkpoint architecture')
    seen.add(archive.arch)
    check(archive.file === `DSH-notary-${expected.runId}-${archive.arch}.zip`, 'checkpoint archive filename mismatch')
    check(typeof archive.sha256 === 'string' && sha256Pattern.test(archive.sha256), 'invalid checkpoint archive SHA-256')
    check(positiveInteger(archive.size), 'checkpoint archive size must be a positive safe integer')
  }
  return checkpoint
}

/**
 * Bind an Apple submission receipt to one retained archive and its original source run.
 * @param receipt Parsed submission receipt JSON.
 * @param checkpoint Previously validated checkpoint for the same release.
 * @param arch Archive architecture, either arm64 or x64.
 * @returns The validated receipt; throws on mismatched identity, archive, or submission ID.
 */
export function validateReceipt(receipt, checkpoint, arch) {
  validateCheckpoint(checkpoint, checkpoint)
  check(architectures.includes(arch), 'unsupported receipt architecture')
  validateIdentity(receipt, checkpoint, 'receipt')
  const archive = checkpoint.archives.find(candidate => candidate.arch === arch)
  check(receipt.arch === arch, 'receipt architecture mismatch')
  for (const field of ['file', 'sha256', 'size']) {
    check(receipt[field] === archive[field], `receipt archive ${field} mismatch`)
  }
  check(typeof receipt.id === 'string' && uuidPattern.test(receipt.id), 'invalid receipt submission ID')
  return receipt
}

/**
 * Read only the documented Apple states for the exact recorded submission.
 * @param info Parsed notarytool info JSON.
 * @param id Submission UUID from a validated receipt.
 * @returns Accepted, In Progress, Invalid, or Rejected; throws on an unknown state or ID mismatch.
 */
export function classifyNotary(info, id) {
  check(typeof id === 'string' && uuidPattern.test(id), 'invalid expected submission ID')
  check(isMapping(info), 'notary response must be a mapping')
  check(info.id === id, 'notary response submission ID mismatch')
  check(['Accepted', 'In Progress', 'Invalid', 'Rejected'].includes(info.status), 'unknown notary status')
  return info.status
}

function validSha512(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9+/]{86}==$/u.test(value)
    && Buffer.from(value, 'base64').length === 64
    && Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * Merge one DMG/ZIP manifest per architecture without changing their artifact records.
 * @param manifests Two parsed electron-builder YAML mappings, in either architecture order.
 * @param version Expected desktop package version.
 * @returns Four ordered file records, the x64 ZIP legacy pointer, and the x64 release date.
 */
export function mergeUpdateManifests(manifests, version) {
  check(typeof version === 'string' && versionPattern.test(version), 'invalid update version')
  check(Array.isArray(manifests) && manifests.length === 2, 'expected exactly two update manifests')
  const seenArchitectures = new Set()
  const files = []
  let x64Manifest
  for (const manifest of manifests) {
    check(isMapping(manifest), 'update manifest must be a mapping')
    check(manifest.version === version, 'update manifest version mismatch')
    check(Array.isArray(manifest.files) && manifest.files.length === 2,
      'each update manifest must contain one DMG and one ZIP')
    const seenExtensions = new Set()
    let manifestArch
    for (const file of manifest.files) {
      check(isMapping(file), 'update file must be a mapping')
      const match = architectures.flatMap(arch => ['dmg', 'zip'].map(extension => ({ arch, extension })))
        .find(({ arch, extension }) => file.url === `DSH-${version}-${arch}.${extension}`)
      check(match !== undefined, 'update URL must be the expected safe artifact basename')
      check(manifestArch === undefined || manifestArch === match.arch, 'update manifest mixes architectures')
      manifestArch = match.arch
      check(!seenExtensions.has(match.extension), 'duplicate update artifact')
      seenExtensions.add(match.extension)
      check(validSha512(file.sha512), 'invalid update artifact SHA-512')
      check(positiveInteger(file.size), 'update artifact size must be a positive safe integer')
      check(file.blockMapSize === undefined || positiveInteger(file.blockMapSize), 'invalid update artifact blockMapSize')
      files.push({ ...file })
    }
    check(!seenArchitectures.has(manifestArch), 'duplicate update architecture')
    seenArchitectures.add(manifestArch)
    if (manifestArch === 'x64') x64Manifest = manifest
    if (manifest.path !== undefined || manifest.sha512 !== undefined) {
      const legacyFile = manifest.files.find(file => file.url === manifest.path && file.url.endsWith('.zip'))
      check(legacyFile !== undefined && legacyFile.sha512 === manifest.sha512, 'invalid update manifest legacy ZIP pointer')
    }
    check(manifest.releaseDate === undefined
      || (typeof manifest.releaseDate === 'string' && Number.isFinite(Date.parse(manifest.releaseDate))),
    'invalid update manifest release date')
  }
  const orderedFiles = ['zip', 'dmg'].flatMap(extension => ['x64', 'arm64'].map(arch =>
    files.find(file => file.url === `DSH-${version}-${arch}.${extension}`),
  ))
  const legacyFile = orderedFiles[0]
  return {
    version,
    files: orderedFiles,
    path: legacyFile.url,
    sha512: legacyFile.sha512,
    ...(x64Manifest.releaseDate === undefined ? {} : { releaseDate: x64Manifest.releaseDate }),
  }
}
