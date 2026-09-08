import type { Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface SigningWalker {
  walkAsync: (directory: string) => Promise<string[]>
}

interface BinaryDetector {
  isBinaryFile: (file: string) => Promise<boolean>
}

interface WalkerFilesystem {
  stat: (file: string) => Promise<Stats>
  lstat: (file: string) => Promise<Stats>
}

// Resolve the exact copy electron-builder signs with, including pnpm's patched package.
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const signerRequire = createRequire(appBuilderRequire.resolve('@electron/osx-sign/package.json'))
const { walkAsync } = signerRequire('./dist/cjs/util.js') as SigningWalker
const binaryDetector = signerRequire('isbinaryfile') as BinaryDetector
const walkerFilesystem = signerRequire('fs-extra') as WalkerFilesystem
const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-signing-walker-'))
  temporaryRoots.push(root)
  return root
}

async function file(path: string, content: string | Buffer = binary): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { flag: 'wx' })
  return path
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('electron-builder signing dependency walker', () => {
  // macOS packaging uses POSIX links; Windows creation requires extra privileges.
  it.skipIf(process.platform === 'win32')('skips directory and file links while retaining physical binaries and bundle postorder', async () => {
    const root = await temporaryRoot()
    const app = join(root, 'DSH.app')
    const framework = join(app, 'Contents', 'Frameworks', 'Test.framework')
    const helper = join(app, 'Contents', 'Frameworks', 'Helper.app')
    const frameworkBinary = await file(join(framework, 'Versions', 'A', 'Test'))
    const helperBinary = await file(join(helper, 'Contents', 'MacOS', 'Helper'))
    const addon = await file(join(app, 'Contents', 'Resources', 'node_modules', '.pnpm', 'pkg', 'addon.node'))
    const outside = await file(join(root, 'external', 'outside.node'))
    await file(join(app, 'Contents', 'Resources', 'readme.txt'), 'package documentation\n')
    const staleSignature = await file(join(app, 'Contents', 'stale.cstemp'))
    const linkedSignature = join(app, 'Contents', 'linked.cstemp')

    await symlink('A', join(framework, 'Versions', 'Current'))
    await symlink(join('Versions', 'Current', 'Test'), join(framework, 'Test'))
    await symlink(join('.pnpm', 'pkg'), join(app, 'Contents', 'Resources', 'node_modules', 'pkg'))
    await symlink(dirname(outside), join(app, 'Contents', 'Resources', 'external'))
    await symlink(outside, linkedSignature)

    const paths = await walkAsync(app)
    expect([...paths].sort()).toEqual([frameworkBinary, framework, helperBinary, helper, addon].sort())
    expect(paths.indexOf(frameworkBinary)).toBeLessThan(paths.indexOf(framework))
    expect(paths.indexOf(helperBinary)).toBeLessThan(paths.indexOf(helper))
    await expect(lstat(staleSignature)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(linkedSignature)).isSymbolicLink()).toBe(true)
    expect(await readFile(outside)).toEqual(binary)
  })

  it.skipIf(process.platform === 'win32').each(['cyclic', 'dangling'] as const)('ignores a %s symlink without resolving its target', async (kind) => {
    const root = await temporaryRoot()
    const link = join(root, 'link.node')
    await symlink(kind === 'cyclic' ? 'link.node' : 'absent.node', link)
    await expect(walkAsync(root)).resolves.toEqual([])
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('bounds metadata and real binary detection to one operation across a many-file tree', async () => {
    const root = await temporaryRoot()
    const expected: string[] = []
    for (let directory = 0; directory < 16; directory += 1) {
      const folder = join(root, `package-${String(directory)}`, 'lib')
      await mkdir(folder, { recursive: true })
      const writes: Promise<void>[] = []
      for (let index = 0; index < 64; index += 1) {
        const path = join(folder, `file-${String(index)}.node`)
        const isBinary = index % 2 === 0
        if (isBinary) expected.push(path)
        writes.push(writeFile(path, isBinary ? binary : 'export default 1\n', { flag: 'wx' }))
      }
      await Promise.all(writes)
    }

    let activeMetadata = 0
    let peakMetadata = 0
    let activeDetection = 0
    let peakDetection = 0
    let detected = 0
    const originalStat = walkerFilesystem.stat
    const originalLstat = walkerFilesystem.lstat
    const originalDetection = binaryDetector.isBinaryFile
    const measureMetadata = (operation: (path: string) => Promise<Stats>) => async (path: string) => {
      activeMetadata += 1
      peakMetadata = Math.max(peakMetadata, activeMetadata)
      try {
        return await operation(path)
      } finally {
        activeMetadata -= 1
      }
    }
    vi.spyOn(walkerFilesystem, 'stat').mockImplementation(measureMetadata(originalStat))
    vi.spyOn(walkerFilesystem, 'lstat').mockImplementation(measureMetadata(originalLstat))
    vi.spyOn(binaryDetector, 'isBinaryFile').mockImplementation(async (path) => {
      activeDetection += 1
      detected += 1
      peakDetection = Math.max(peakDetection, activeDetection)
      try {
        return await originalDetection(path)
      } finally {
        activeDetection -= 1
      }
    })
    let paths: string[]
    try {
      paths = await walkAsync(root)
    } finally {
      vi.restoreAllMocks()
    }
    expect({ peakMetadata, peakDetection, activeMetadata, activeDetection, detected }).toEqual({
      peakMetadata: 1, peakDetection: 1, activeMetadata: 0, activeDetection: 0, detected: 1024,
    })
    expect([...paths].sort()).toEqual(expected.sort())
    expect(walkerFilesystem.stat).toBe(originalStat)
    expect(walkerFilesystem.lstat).toBe(originalLstat)
    expect(binaryDetector.isBinaryFile).toBe(originalDetection)
  })

  it('keeps filesystem errors observable', async () => {
    const root = await temporaryRoot()
    await expect(walkAsync(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    const ordinaryFile = await file(join(root, 'ordinary.node'))
    await expect(walkAsync(ordinaryFile)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
