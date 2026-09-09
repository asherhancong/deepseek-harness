import { describe, expect, it } from 'vitest'
import {
  classifyNotary,
  mergeUpdateManifests,
  validateCheckpoint,
  validateReceipt,
  validateRun,
} from '../scripts/release-state.mjs'

const expected = {
  repository: 'asherhancong/deepseek-harness',
  runId: 123456789,
  commit: 'a'.repeat(40),
  tag: 'desktop-v0.1.0',
  version: '0.1.0',
}
const identity = {
  ...expected,
  schemaVersion: 1,
  workflow: '.github/workflows/desktop-release.yml',
  runAttempt: 1,
  teamId: 'YZM63RX87F',
}
const submissionId = 'c2808b91-6d15-42df-aba6-5114a7798ba4'
const sha512 = Buffer.alloc(64, 1).toString('base64')

function run() {
  return {
    id: expected.runId,
    repository: { full_name: expected.repository },
    path: identity.workflow,
    head_sha: expected.commit,
    head_branch: expected.tag,
    event: 'push',
    status: 'completed',
    run_attempt: 1,
  }
}

function archive(arch: 'arm64' | 'x64') {
  return {
    arch,
    file: `DSH-notary-${expected.runId}-${arch}.zip`,
    sha256: 'b'.repeat(64),
    size: 12345,
  }
}

function checkpoint() {
  const archives: [ReturnType<typeof archive>, ReturnType<typeof archive>] = [archive('arm64'), archive('x64')]
  return {
    ...identity,
    archives,
  }
}

function receipt() {
  return { ...identity, ...checkpoint().archives[0], id: submissionId }
}

function updateFile(arch: 'arm64' | 'x64', extension: 'dmg' | 'zip') {
  return {
    url: `DSH-${expected.version}-${arch}.${extension}`,
    sha512,
    size: 12345,
    blockMapSize: 789,
  }
}

function manifest(arch: 'arm64' | 'x64') {
  const files: [ReturnType<typeof updateFile>, ReturnType<typeof updateFile>] = [
    updateFile(arch, 'dmg'),
    updateFile(arch, 'zip'),
  ]
  return {
    version: expected.version,
    files,
    path: `DSH-${expected.version}-${arch}.zip`,
    sha512,
    releaseDate: '2026-09-09T00:00:00.000Z',
  }
}

describe('release source identity', () => {
  it.each(['push', 'workflow_dispatch'])('accepts a completed original %s run', (event) => {
    const source = { ...run(), event }
    expect(validateRun(source, expected)).toBe(source)
  })

  it.each([
    ['id', 999],
    ['repository', { full_name: 'attacker/deepseek-harness' }],
    ['path', '.github/workflows/ci.yml'],
    ['head_sha', 'c'.repeat(40)],
    ['head_branch', 'master'],
    ['event', 'pull_request'],
    ['status', 'in_progress'],
    ['run_attempt', 2],
  ])('rejects a mismatched source %s', (field, value) => {
    expect(() => validateRun({ ...run(), [field]: value }, expected)).toThrow()
  })

  it.each([
    ['runId', 0],
    ['runId', Number.MAX_SAFE_INTEGER + 1],
    ['repository', 'not-a-repository'],
    ['commit', 'a'.repeat(39)],
    ['tag', 'v0.1.0'],
    ['version', '../0.1.0'],
    ['workflow', '.github/workflows/other.yml'],
    ['teamId', 'OTHERTEAM'],
  ])('rejects malformed expected %s', (field, value) => {
    expect(() => validateRun(run(), { ...expected, [field]: value })).toThrow()
  })

  it('rejects non-object source responses', () => {
    expect(() => validateRun(null, expected)).toThrow()
    expect(() => validateRun([], expected)).toThrow()
  })
})

describe('release checkpoint and submission receipt', () => {
  it('accepts both archive architectures and a matching receipt without mutation', () => {
    const state = checkpoint()
    const recorded = receipt()
    expect(validateCheckpoint(state, expected)).toBe(state)
    expect(validateReceipt(recorded, state, 'arm64')).toBe(recorded)
    expect(validateReceipt({ ...recorded, ...state.archives[1] }, state, 'x64').arch).toBe('x64')
  })

  it.each([
    ['schemaVersion', 2],
    ['repository', 'attacker/deepseek-harness'],
    ['workflow', '.github/workflows/ci.yml'],
    ['runId', 987],
    ['runAttempt', 2],
    ['commit', 'c'.repeat(40)],
    ['tag', 'desktop-v0.2.0'],
    ['version', '0.2.0'],
    ['teamId', 'OTHERTEAM'],
  ])('rejects checkpoint and receipt identity mismatch: %s', (field, value) => {
    expect(() => validateCheckpoint({ ...checkpoint(), [field]: value }, expected)).toThrow()
    expect(() => validateReceipt({ ...receipt(), [field]: value }, checkpoint(), 'arm64')).toThrow()
  })

  it.each([
    { archives: null },
    { archives: [] },
    { archives: [checkpoint().archives[0]] },
    { archives: [checkpoint().archives[0], checkpoint().archives[0]] },
    { archives: [...checkpoint().archives, checkpoint().archives[0]] },
    { archives: [null, checkpoint().archives[1]] },
  ])('rejects incomplete or duplicate archive sets %#', ({ archives }) => {
    expect(() => validateCheckpoint({ ...checkpoint(), archives }, expected)).toThrow()
  })

  it.each([
    ['arch', 'universal'],
    ['file', '../DSH-notary-arm64.zip'],
    ['file', 'DSH-notary-999-arm64.zip'],
    ['sha256', 'a'.repeat(63)],
    ['sha256', 'z'.repeat(64)],
    ['size', 0],
    ['size', 1.5],
    ['size', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid checkpoint archive %s', (field, value) => {
    const state = checkpoint()
    state.archives[0] = { ...state.archives[0], [field]: value }
    expect(() => validateCheckpoint(state, expected)).toThrow()
  })

  it.each([
    ['arch', 'x64'],
    ['file', 'DSH-notary-999-arm64.zip'],
    ['sha256', 'c'.repeat(64)],
    ['size', 54321],
    ['id', 'not-a-submission'],
  ])('rejects mismatched receipt archive or ID: %s', (field, value) => {
    expect(() => validateReceipt({ ...receipt(), [field]: value }, checkpoint(), 'arm64')).toThrow()
  })

  it('rejects an unsupported requested architecture', () => {
    expect(() => validateReceipt(receipt(), checkpoint(), 'universal')).toThrow()
  })

  it('does not trust an invalid checkpoint passed to receipt validation', () => {
    expect(() => validateReceipt(receipt(), { ...checkpoint(), commit: 'short' }, 'arm64')).toThrow()
  })
})

describe('notary response status', () => {
  it.each(['Accepted', 'In Progress', 'Invalid', 'Rejected'])('retains the %s state', (status) => {
    expect(classifyNotary({ id: submissionId, status }, submissionId)).toBe(status)
  })

  it.each(['accepted', 'Success', '', null, undefined])('rejects an unknown state %#', (status) => {
    expect(() => classifyNotary({ id: submissionId, status }, submissionId)).toThrow()
  })

  it('rejects malformed responses and another submission', () => {
    expect(() => classifyNotary(null, submissionId)).toThrow()
    expect(() => classifyNotary({ id: submissionId, status: 'Accepted' }, 'invalid')).toThrow()
    expect(() => classifyNotary({ id: 'd2808b91-6d15-42df-aba6-5114a7798ba4', status: 'Accepted' }, submissionId)).toThrow()
  })
})

describe('update metadata merging', () => {
  it('orders four artifact records and chooses the x64 ZIP independent of input order', () => {
    const arm64 = manifest('arm64')
    const x64 = { ...manifest('x64'), releaseDate: '2026-09-09T01:00:00.000Z' }
    const merged = mergeUpdateManifests([arm64, x64], expected.version)
    expect(merged).toEqual({
      version: expected.version,
      files: [x64.files[1], arm64.files[1], x64.files[0], arm64.files[0]],
      path: x64.path,
      sha512: x64.sha512,
      releaseDate: x64.releaseDate,
    })
    expect(merged.files[0]).not.toBe(x64.files[1])
    expect(mergeUpdateManifests([x64, arm64], expected.version)).toEqual(merged)
  })

  it('permits absent legacy metadata and release dates', () => {
    const sources = [manifest('arm64'), manifest('x64')].map(({ version, files }) => ({ version, files }))
    expect(mergeUpdateManifests(sources, expected.version)).not.toHaveProperty('releaseDate')
  })

  it.each([
    { sources: [] },
    { sources: [manifest('arm64')] },
    { sources: [manifest('arm64'), manifest('arm64')] },
    { sources: [manifest('arm64'), null] },
  ])('rejects missing or duplicate architecture manifests %#', ({ sources }) => {
    expect(() => mergeUpdateManifests(sources, expected.version)).toThrow()
  })

  it.each([
    ['version', '0.2.0'],
    ['files', []],
    ['path', 'DSH-0.1.0-arm64.dmg'],
    ['sha512', 'wrong'],
    ['releaseDate', 'not-a-date'],
  ])('rejects malformed manifest %s', (field, value) => {
    expect(() => mergeUpdateManifests([
      { ...manifest('arm64'), [field]: value },
      manifest('x64'),
    ], expected.version)).toThrow()
  })

  it.each([
    ['url', '../DSH-0.1.0-arm64.dmg'],
    ['url', 'https://example.com/DSH-0.1.0-arm64.dmg'],
    ['url', 'DSH-0.1.0-arm64.zip'],
    ['url', 'DSH-0.1.0-x64.dmg'],
    ['url', 'DSH-0.2.0-arm64.dmg'],
    ['sha512', Buffer.alloc(63, 1).toString('base64')],
    ['sha512', `${sha512.slice(0, 85)}B==`],
    ['size', 0],
    ['size', Number.POSITIVE_INFINITY],
    ['blockMapSize', -1],
  ])('rejects malformed or mismatched artifact %s', (field, value) => {
    const source = manifest('arm64')
    source.files[0] = { ...source.files[0], [field]: value }
    expect(() => mergeUpdateManifests([source, manifest('x64')], expected.version)).toThrow()
  })

  it('rejects non-object artifact records and malformed versions', () => {
    expect(() => mergeUpdateManifests([
      { ...manifest('arm64'), files: [null, manifest('arm64').files[1]] },
      manifest('x64'),
    ], expected.version)).toThrow()
    expect(() => mergeUpdateManifests([manifest('arm64'), manifest('x64')], '../0.1.0')).toThrow()
  })
})
