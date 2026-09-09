/** Persist signed archives and resume Apple submissions without rebuilding or resubmitting them. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { classifyNotary, mergeUpdateManifests, validateCheckpoint, validateReceipt, validateRun } from './release-state.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arches = ['arm64', 'x64']
const workflow = '.github/workflows/desktop-release.yml'
const teamId = 'YZM63RX87F'

function command(file, args, timeout = 60_000) {
  return execFileSync(file, args, {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function required(env, name) {
  const value = env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}

function expectedContext(env = process.env) {
  const runId = env.RESUME_RUN_ID || required(env, 'GITHUB_RUN_ID')
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error('Source run ID must be a positive integer')
  return {
    repository: required(env, 'GITHUB_REPOSITORY'),
    runId: Number(runId),
    commit: required(env, 'GITHUB_SHA'),
    tag: required(env, 'GITHUB_REF_NAME'),
    version: required(env, 'DESKTOP_VERSION'),
  }
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Validate checkpoint identity and archive bytes before extraction or Apple access. */
export async function readCheckpoint(directory, expected) {
  const checkpoint = validateCheckpoint(await json(join(directory, 'checkpoint.json')), expected)
  for (const archive of checkpoint.archives) {
    const path = join(directory, archive.file)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size !== archive.size || await digest(path) !== archive.sha256) {
      throw new Error('Signed archive does not match checkpoint: ' + archive.file)
    }
  }
  return checkpoint
}

function appPath(arch) {
  return join(desktop, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'DSH.app')
}

function verifyApp(path, arch, version, run = command) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path])
  // codesign writes its certificate identity to stderr.
  const details = execFileSync('/bin/sh', ['-c', 'exec codesign --display --verbose=4 "$1" 2>&1', 'codesign-display', path], {
    encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  })
  if (!details.includes('Authority=Developer ID Application:')
    || !details.split('\n').includes('TeamIdentifier=' + teamId)) {
    throw new Error('Application does not have the expected Developer ID signature')
  }
  const actualArch = run('lipo', ['-archs', join(path, 'Contents/MacOS/DSH')]).trim()
  if (actualArch !== (arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('Application architecture mismatch')
  const actualVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(path, 'Contents/Info.plist')]).trim()
  if (actualVersion !== version) throw new Error('Application version mismatch')
}

async function createCheckpoint(directory, expected) {
  await mkdir(directory)
  const archives = []
  for (const arch of arches) {
    const signedApp = join(desktop, 'signed', arch === 'arm64' ? 'mac-arm64' : 'mac', 'DSH.app')
    verifyApp(signedApp, arch, expected.version)
    const file = 'DSH-notary-' + expected.runId + '-' + arch + '.zip'
    const path = join(directory, file)
    await copyFile(join(desktop, 'signed', 'DSH-' + expected.version + '-' + arch + '.zip'), path)
    archives.push({ arch, file, sha256: await digest(path), size: (await lstat(path)).size })
  }
  const checkpoint = validateCheckpoint({
    schemaVersion: 1, ...expected, workflow, runAttempt: 1, teamId, archives,
  }, expected)
  await writeJson(join(directory, 'checkpoint.json'), checkpoint)
}

function appleArgs(env) {
  return ['--key', required(env, 'APPLE_API_KEY'), '--key-id', required(env, 'APPLE_API_KEY_ID'),
    '--issuer', required(env, 'APPLE_API_ISSUER'), '--output-format', 'json']
}

/** Submit once; a missing durable receipt on resume is an error, never a request to resubmit. */
export async function submitArchive(directory, expected, arch, env = process.env, run = command) {
  if (env.RESUME_RUN_ID) throw new Error('Resume must never submit a new archive')
  const checkpoint = await readCheckpoint(directory, expected)
  const archive = checkpoint.archives.find(item => item.arch === arch)
  if (!archive) throw new Error('Unknown architecture')
  const receiptPath = join(directory, 'receipt-' + arch + '.json')
  const attemptPath = join(directory, 'attempt-' + arch + '.json')
  await writeFile(attemptPath, JSON.stringify({ file: archive.file, runId: checkpoint.runId }) + '\n', { flag: 'wx' })
  const reply = JSON.parse(await run('xcrun', [
    'notarytool', 'submit', join(directory, archive.file), '--no-wait', ...appleArgs(env),
  ], 15 * 60_000))
  const { archives: _archives, ...identity } = checkpoint
  const receipt = validateReceipt({ ...identity, ...archive, id: reply.id }, checkpoint, arch)
  await writeJson(receiptPath, receipt)
  console.log(arch + ' Apple submission: ' + receipt.id)
  return receipt
}

/** Read both saved submissions, wait within a bounded budget, and fail closed on any terminal rejection. */
export async function checkSubmissions(directory, expected, env = process.env, run = command) {
  const checkpoint = await readCheckpoint(directory, expected)
  const receipts = await Promise.all(arches.map(async arch => {
    let receipt
    try { receipt = await json(join(directory, 'receipt-' + arch + '.json')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw new Error('Missing ' + arch + ' receipt for source run ' + expected.runId
        + '; inspect the original Apple submission and recover its receipt. Automatic resubmission is forbidden.')
    }
    return validateReceipt(receipt, checkpoint, arch)
  }))
  let accepted = true
  for (const receipt of receipts) {
    const info = async () => {
      const result = JSON.parse(await run('xcrun', ['notarytool', 'info', receipt.id, ...appleArgs(env)]))
      classifyNotary(result, receipt.id)
      if (result.name !== receipt.file) throw new Error('Apple submission filename does not match checkpoint')
      return result
    }
    let result = await info()
    if (result.status === 'In Progress') {
      try {
        await run('xcrun', ['notarytool', 'wait', receipt.id, '--timeout', '5m', ...appleArgs(env)], 6 * 60_000)
      } catch {
        // Wait can time out or report rejection; info below owns the authoritative current status.
        console.log(receipt.arch + ': wait ended; querying Apple status')
      }
      result = await info()
    }
    await writeJson(join(directory, 'status-' + receipt.arch + '.json'), result)
    console.log(receipt.arch + ': ' + result.status + ' (' + receipt.id + ')')
    if (result.status !== 'Accepted' && result.status !== 'In Progress') {
      throw new Error(receipt.arch + ' notarization rejected: ' + receipt.id)
    }
    if (result.status === 'In Progress') accepted = false
  }
  return accepted
}

async function restoreApps(directory, expected) {
  const checkpoint = await readCheckpoint(directory, expected)
  for (const archive of checkpoint.archives) {
    const destination = dirname(appPath(archive.arch))
    await mkdir(destination, { recursive: true })
    try {
      await lstat(appPath(archive.arch))
      throw new Error('Refusing to overwrite an existing restored application')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    command('ditto', ['-x', '-k', join(directory, archive.file), destination], 5 * 60_000)
    verifyApp(appPath(archive.arch), archive.arch, expected.version)
    command('xcrun', ['stapler', 'staple', appPath(archive.arch)], 5 * 60_000)
    command('xcrun', ['stapler', 'validate', appPath(archive.arch)])
    command('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath(archive.arch)])
  }
}

async function mergeArtifacts(expected) {
  const manifests = []
  for (const arch of arches) {
    const directory = join(desktop, 'final-' + arch)
    manifests.push(yaml.load(await readFile(join(directory, 'latest-mac.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA }))
  }
  const merged = mergeUpdateManifests(manifests, expected.version)
  for (const file of merged.files) {
    const arch = file.url.endsWith('-arm64.zip') || file.url.endsWith('-arm64.dmg') ? 'arm64' : 'x64'
    for (const name of [file.url, file.url + '.blockmap']) {
      await copyFile(join(desktop, 'final-' + arch, name), join(desktop, 'release', name))
    }
  }
  await writeFile(join(desktop, 'release/latest-mac.yml'), yaml.dump(merged))
}

async function main() {
  const expected = expectedContext()
  const directory = join(desktop, 'notarization')
  const action = process.argv[2]
  if (action === 'validate-source') {
    validateRun(await json(required(process.env, 'SOURCE_RUN_JSON')), expected)
  } else if (action === 'checkpoint') {
    await createCheckpoint(directory, expected)
  } else if (action === 'verify') {
    await readCheckpoint(directory, expected)
  } else if (action === 'submit') {
    await submitArchive(directory, expected, process.argv[3])
  } else if (action === 'check') {
    const accepted = await checkSubmissions(directory, expected)
    await appendFile(required(process.env, 'GITHUB_OUTPUT'), 'accepted=' + String(accepted) + '\n')
    await appendFile(required(process.env, 'GITHUB_STEP_SUMMARY'),
      '## Desktop notarization: ' + (accepted ? 'Accepted' : 'Waiting for Apple') + '\n\n'
      + 'Source run: ' + expected.runId + '. Both signed archives and submission receipts are retained for 30 days.\n\n'
      + (accepted ? 'Continuing with installer verification; Release remains a draft.\n'
        : 'No Release was created. Dispatch this workflow on ' + expected.tag
          + ' with resume_run_id=' + expected.runId + ' to query the same submissions. Do not rerun the build.\n'))
  } else if (action === 'restore') {
    await restoreApps(directory, expected)
  } else if (action === 'merge') {
    await mergeArtifacts(expected)
  } else {
    throw new Error('Expected validate-source, checkpoint, verify, submit, check, restore, or merge')
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
