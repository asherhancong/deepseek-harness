import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'

interface LaunchPaths {
  containsRealPath: (root: string, candidate: string) => Promise<boolean>
}

const scriptUrl = new URL('../scripts/verify-packaged-launch.mjs', import.meta.url).href
const { containsRealPath } = await import(scriptUrl) as LaunchPaths

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-launch-paths-'))
  const links: string[] = []
  context.onTestFinished(async () => {
    for (const link of links) await unlink(link)
    await rm(root, { recursive: true, force: true })
  })
  const home = join(root, 'home')
  const outside = join(root, 'home-other')
  const child = join(home, 'browser')
  await Promise.all([mkdir(child, { recursive: true }), mkdir(outside)])
  async function link(target: string, path: string) {
    await symlink(target, path, 'junction')
    links.push(path)
  }
  return { root, home, outside, child, link }
}

it('accepts an alias and a canonical name for the same owned application directories', async (context) => {
  const state = await fixture(context)
  const alias = join(state.root, 'home-alias')
  await state.link(state.home, alias)
  await expect(containsRealPath(await realpath(state.home), alias)).resolves.toBe(true)
  await expect(containsRealPath(alias, await realpath(state.child))).resolves.toBe(true)
  await expect(containsRealPath(state.home, join(alias, 'browser'))).resolves.toBe(true)
})

it('rejects an outside directory and a symlink escape even with an owned textual prefix', async (context) => {
  const state = await fixture(context)
  const escape = join(state.home, 'escape')
  await state.link(state.outside, escape)
  await expect(containsRealPath(state.home, state.outside)).resolves.toBe(false)
  await expect(containsRealPath(state.home, escape)).resolves.toBe(false)
})

it('reports a missing path instead of treating it as isolated', async (context) => {
  const state = await fixture(context)
  await expect(containsRealPath(state.home, join(state.home, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
})
