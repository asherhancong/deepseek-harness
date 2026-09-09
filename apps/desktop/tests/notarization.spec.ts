import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSubmissions, readCheckpoint, submitArchive } from '../scripts/notarization.mjs'

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
const appleEnv = {
  APPLE_API_KEY: 'test-only-key.p8',
  APPLE_API_KEY_ID: 'TESTONLY01',
  APPLE_API_ISSUER: '11111111-1111-4111-8111-111111111111',
}
const submissionIds = {
  arm64: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  x64: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const temporaryRoots: string[] = []
type Arch = keyof typeof submissionIds

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value) + '\n')
}

function archiveBytes(arch: Arch): Buffer {
  // A valid empty ZIP with an architecture comment exercises the retained-byte checks.
  const comment = Buffer.from(arch)
  const bytes = Buffer.alloc(22 + comment.length)
  bytes.writeUInt32LE(0x06054b50)
  bytes.writeUInt16LE(comment.length, 20)
  comment.copy(bytes, 22)
  return bytes
}

async function fixture(withReceipts = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notarization-'))
  temporaryRoots.push(directory)
  const createArchive = async (arch: Arch) => {
    const bytes = archiveBytes(arch)
    const archive = {
      arch,
      file: `DSH-notary-${expected.runId}-${arch}.zip`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }
    await writeFile(join(directory, archive.file), bytes, { flag: 'wx' })
    return archive
  }
  const archives = await Promise.all([createArchive('arm64'), createArchive('x64')])
  const checkpoint = { ...identity, archives }
  const receipts = archives.map(archive => ({ ...identity, ...archive, id: submissionIds[archive.arch] }))
  await writeJson(join(directory, 'checkpoint.json'), checkpoint)
  if (withReceipts) {
    await Promise.all(receipts.map(receipt => writeJson(join(directory, `receipt-${receipt.arch}.json`), receipt)))
  }
  return { directory, checkpoint, receipts }
}

function info(arch: Arch, status = 'Accepted') {
  return { id: submissionIds[arch], name: `DSH-notary-${expected.runId}-${arch}.zip`, status }
}

function appleReplies(replies: Array<{ action: 'info' | 'wait' | 'submit'; arch: Arch; value: unknown }>) {
  const remaining = [...replies]
  const run = vi.fn((file: string, args: string[], _timeout?: number): string => {
    expect(file).toBe('xcrun')
    expect(args[0]).toBe('notarytool')
    const reply = remaining.shift()
    if (!reply) throw new Error('Unexpected Apple command: ' + args.join(' '))
    expect(args[1]).toBe(reply.action)
    if (reply.action !== 'submit') expect(args[2]).toBe(submissionIds[reply.arch])
    if (reply.value instanceof Error) throw reply.value
    return JSON.stringify(reply.value)
  })
  return { run, remaining }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('retained signed archives', () => {
  it('reads the real checkpoint and both unchanged archive byte streams', async () => {
    const { directory, checkpoint } = await fixture()
    await expect(readCheckpoint(directory, expected)).resolves.toEqual(checkpoint)
    expect(await readFile(join(directory, checkpoint.archives[0].file))).toEqual(archiveBytes('arm64'))
  })

  it('rejects same-size archive corruption before submitting or querying Apple', async () => {
    const { directory, checkpoint } = await fixture()
    const path = join(directory, checkpoint.archives[0].file)
    const damaged = await readFile(path)
    damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 1, damaged.length - 1)
    await writeFile(path, damaged)
    const { run } = appleReplies([])
    await expect(submitArchive(directory, expected, 'arm64', appleEnv, run)).rejects.toThrow('does not match checkpoint')
    await expect(checkSubmissions(directory, expected, appleEnv, run)).rejects.toThrow('does not match checkpoint')
    expect(run).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'attempt-arm64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('resume existing Apple submissions', () => {
  it('rejects a missing receipt before querying either architecture', async () => {
    const { directory } = await fixture()
    await rm(join(directory, 'receipt-x64.json'))
    const { run } = appleReplies([])
    await expect(checkSubmissions(directory, expected, appleEnv, run)).rejects.toThrow('Missing x64 receipt')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a foreign receipt before querying either architecture', async () => {
    const { directory, receipts } = await fixture()
    await writeJson(join(directory, 'receipt-x64.json'), { ...receipts[1], commit: 'b'.repeat(40) })
    const { run } = appleReplies([])
    await expect(checkSubmissions(directory, expected, appleEnv, run)).rejects.toThrow('receipt commit mismatch')
    expect(run).not.toHaveBeenCalled()
  })

  it('persists both Accepted statuses without submitting again', async () => {
    const { directory } = await fixture()
    const { run, remaining } = appleReplies([
      { action: 'info', arch: 'arm64', value: info('arm64') },
      { action: 'info', arch: 'x64', value: info('x64') },
    ])
    await expect(checkSubmissions(directory, expected, { ...appleEnv, RESUME_RUN_ID: String(expected.runId) }, run)).resolves.toBe(true)
    expect(remaining).toEqual([])
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['info', 'info'])
    for (const arch of ['arm64', 'x64'] as const) {
      expect(JSON.parse(await readFile(join(directory, `status-${arch}.json`), 'utf8'))).toEqual(info(arch))
    }
  })

  it('survives a wait timeout, saves pending status, and later resumes the same IDs', async () => {
    const { directory } = await fixture()
    const { run, remaining } = appleReplies([
      { action: 'info', arch: 'arm64', value: info('arm64', 'In Progress') },
      { action: 'wait', arch: 'arm64', value: new Error('wait deadline expired') },
      { action: 'info', arch: 'arm64', value: info('arm64', 'In Progress') },
      { action: 'info', arch: 'x64', value: info('x64') },
      { action: 'info', arch: 'arm64', value: info('arm64') },
      { action: 'info', arch: 'x64', value: info('x64') },
    ])
    await expect(checkSubmissions(directory, expected, appleEnv, run)).resolves.toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'status-arm64.json'), 'utf8'))).toEqual(info('arm64', 'In Progress'))
    expect(run.mock.calls[1]?.[1]).toContain('--timeout')
    expect(run.mock.calls[1]?.[1]).toContain('5m')
    expect(run.mock.calls[1]?.[2]).toBe(6 * 60_000)
    await expect(checkSubmissions(directory, expected, appleEnv, run)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(directory, 'status-arm64.json'), 'utf8'))).toEqual(info('arm64'))
    expect(remaining).toEqual([])
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['info', 'wait', 'info', 'info', 'info', 'info'])
  })

  it('queries authoritative status again after a successful wait', async () => {
    const { directory } = await fixture()
    const { run, remaining } = appleReplies([
      { action: 'info', arch: 'arm64', value: info('arm64', 'In Progress') },
      { action: 'wait', arch: 'arm64', value: info('arm64') },
      { action: 'info', arch: 'arm64', value: info('arm64') },
      { action: 'info', arch: 'x64', value: info('x64') },
    ])
    await expect(checkSubmissions(directory, expected, appleEnv, run)).resolves.toBe(true)
    expect(remaining).toEqual([])
  })

  it.each([
    ['rejected', { ...info('arm64'), status: 'Invalid' }, 'notarization rejected'],
    ['unknown status', { ...info('arm64'), status: 'Success' }, 'unknown notary status'],
    ['foreign ID', { ...info('arm64'), id: submissionIds.x64 }, 'submission ID mismatch'],
    ['foreign filename', { ...info('arm64'), name: info('x64').name }, 'filename does not match'],
  ])('fails closed on a %s response', async (_label, response, message) => {
    const { directory } = await fixture()
    const { run } = appleReplies([{ action: 'info', arch: 'arm64', value: response }])
    await expect(checkSubmissions(directory, expected, appleEnv, run)).rejects.toThrow(message)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('durable submission receipts', () => {
  it('refuses a resume submission before creating an attempt or contacting Apple', async () => {
    const { directory } = await fixture(false)
    const { run } = appleReplies([])
    await expect(submitArchive(directory, expected, 'arm64', {
      ...appleEnv,
      RESUME_RUN_ID: String(expected.runId),
    }, run)).rejects.toThrow('Resume must never submit')
    expect(run).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'attempt-arm64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes the bound receipt and refuses a second submission attempt', async () => {
    const { directory, receipts, checkpoint } = await fixture(false)
    const { run } = appleReplies([{ action: 'submit', arch: 'arm64', value: { id: submissionIds.arm64 } }])
    await expect(submitArchive(directory, expected, 'arm64', appleEnv, run)).resolves.toEqual(receipts[0])
    expect(JSON.parse(await readFile(join(directory, 'receipt-arm64.json'), 'utf8'))).toEqual(receipts[0])
    expect(JSON.parse(await readFile(join(directory, 'attempt-arm64.json'), 'utf8'))).toEqual({
      file: checkpoint.archives[0].file,
      runId: expected.runId,
    })
    expect(run.mock.calls[0]?.[1]).toContain('--no-wait')
    expect(run.mock.calls[0]?.[2]).toBe(15 * 60_000)
    await expect(submitArchive(directory, expected, 'arm64', appleEnv, run)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retains an ambiguous attempt and refuses to resubmit after the first command fails', async () => {
    const { directory } = await fixture(false)
    const { run } = appleReplies([{ action: 'submit', arch: 'arm64', value: new Error('connection ended after upload') }])
    await expect(submitArchive(directory, expected, 'arm64', appleEnv, run)).rejects.toThrow('connection ended after upload')
    await expect(readFile(join(directory, 'receipt-arm64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(submitArchive(directory, expected, 'arm64', appleEnv, run)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
