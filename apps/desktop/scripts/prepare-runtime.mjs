/** Stage a verified, portable production runtime for Electron extraResources. */

import { spawn } from 'node:child_process'
import { access, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(desktopDirectory, '../..')
const runtimeDirectory = join(desktopDirectory, 'runtime')
const deployRootPackage = '@deepseek-ai/dsh-desktop-runtime'
const reviewedAutomaticBuild = '@deepseek-ai/dsh-subprocess-local'

if (dirname(runtimeDirectory) !== desktopDirectory) {
  throw new Error(`desktop runtime: unsafe staging directory ${runtimeDirectory}`)
}

function run(label, executable, args, options = {}) {
  const capture = options.capture === true
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? workspaceRoot,
      // Deploy may replay the repository postinstall; staging is intentionally
      // non-interactive and must not rewrite a developer's Git hook config.
      env: { ...process.env, CI: 'true' },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(stdout)
      else {
        const diagnostic = capture ? `\n${stdout}${stderr}`.trimEnd() : ''
        rejectRun(new Error(
          `desktop runtime: ${label} failed (code ${String(code)}, signal ${String(signal)})${diagnostic}`,
        ))
      }
    })
  })
}

function runPnpm(label, args, options) {
  return run(label, 'pnpm', args, options)
}

function isInsideRuntime(target) {
  const pathFromRuntime = relative(runtimeDirectory, target)
  return pathFromRuntime === ''
    || (!isAbsolute(pathFromRuntime)
      && pathFromRuntime !== '..'
      && !pathFromRuntime.startsWith(`..${sep}`))
}

/** Reject broken or external links and collect the reviewed staged helper. */
async function inspectRuntimeTree(directory, state) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (!isInsideRuntime(target)) {
        throw new Error(`desktop runtime: symlink escapes staging directory: ${path} -> ${target}`)
      }
      state.symlinks += 1
    } else if (entry.isDirectory()) {
      await inspectRuntimeTree(path, state)
    } else if (entry.isFile() && entry.name === 'ensure-spawn-helper.mjs') {
      const packageDirectory = dirname(dirname(path))
      const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
      if (manifest.name === reviewedAutomaticBuild) state.spawnHelpers.push(path)
    }
  }
}

async function verifyIgnoredBuilds() {
  const report = await runPnpm('ignored build audit', [
    '--dir', runtimeDirectory,
    'ignored-builds',
  ], { capture: true })
  const automatic = []
  let inAutomaticSection = false
  for (const line of report.split(/\r?\n/u)) {
    if (line === 'Automatically ignored builds during installation:') {
      inAutomaticSection = true
    } else if (inAutomaticSection && (line.startsWith('hint:')
      || line === 'Explicitly ignored package builds (via allowBuilds):')) {
      inAutomaticSection = false
    } else if (inAutomaticSection && line.startsWith('  ') && line.trim() !== '') {
      automatic.push(line.trim())
    }
  }
  if (automatic.length !== 1 || !automatic[0].startsWith(`${reviewedAutomaticBuild}@`)) {
    throw new Error(
      `desktop runtime: unexpected automatically ignored builds: ${JSON.stringify(automatic)}`,
    )
  }
}

await runPnpm('dependency closure verification', [
  '--dir', workspaceRoot,
  '--config.verify-deps-before-run=false',
  'exec', 'tsx', 'scripts/verify-runtime-closure.ts',
  '--manifest', 'apps/desktop-runtime/package.json',
  '--platforms', 'apps/desktop-runtime/platforms.json',
])

await rm(runtimeDirectory, { recursive: true, force: true })
await runPnpm('pnpm deploy', [
  '--dir', workspaceRoot,
  '--config.inject-workspace-packages=true',
  // The root install already verifies this lockfile. Trusting it here prevents
  // deploy from repeating registry-backed trust checks.
  '--config.trust-lockfile=true',
  // The absolute file locator used for an injected workspace package cannot
  // match pnpm's repository-relative allowBuilds entry. Audit it below and run
  // its reviewed, idempotent executable-bit repair explicitly.
  '--config.strict-dep-builds=false',
  '--filter', deployRootPackage,
  'deploy', '--prod', '--frozen-lockfile',
  runtimeDirectory,
])

await verifyIgnoredBuilds()

const treeState = { symlinks: 0, spawnHelpers: [] }
await inspectRuntimeTree(runtimeDirectory, treeState)
if (treeState.spawnHelpers.length !== 1) {
  throw new Error(
    `desktop runtime: expected one reviewed spawn-helper repair, found ${treeState.spawnHelpers.length}`,
  )
}
await run(
  'spawn-helper executable repair',
  process.execPath,
  [treeState.spawnHelpers[0]],
  { cwd: dirname(treeState.spawnHelpers[0]) },
)

const runtimeManifest = JSON.parse(await readFile(join(runtimeDirectory, 'package.json'), 'utf8'))
await Promise.all(Object.keys(runtimeManifest.dependencies ?? {}).map(dependency =>
  access(join(runtimeDirectory, 'node_modules', dependency, 'package.json')),
))

const runtimeRequire = createRequire(join(runtimeDirectory, 'package.json'))
const cliManifest = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
const cliDirectory = dirname(cliManifest)
const cliEntry = join(cliDirectory, 'lib', 'bin.js')
const presetsManifest = runtimeRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')
const standardPreset = join(dirname(presetsManifest), 'presets', 'standard', 'agent.cordis.yml')
const cosmokitManifest = runtimeRequire.resolve('@deepseek-ai/cosmokit/package.json')
const webAppManifest = runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
const webAppRequire = createRequire(webAppManifest)
const webIndex = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
for (const path of [cliManifest, presetsManifest, standardPreset, cosmokitManifest, webAppManifest, webIndex]) {
  if (!isInsideRuntime(await realpath(path))) {
    throw new Error(`desktop runtime: dependency resolved outside staging directory: ${path}`)
  }
}

await Promise.all([
  access(join(runtimeDirectory, 'package.json')),
  access(cliEntry),
  access(standardPreset),
  access(webIndex),
])

console.log(
  `desktop runtime: staged a frozen dependency closure with ${treeState.symlinks} contained symlinks`,
)
