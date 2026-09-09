import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string | number>
}

interface ReleaseWorkflow {
  permissions: Record<string, string>
  jobs: { release: { environment: string; steps: Step[] } }
}

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')) as ReleaseWorkflow
const steps = workflow.jobs.release.steps

function named(name: string): Step {
  const step = steps.find(candidate => candidate.name === name)
  if (!step) throw new Error('Missing release step: ' + name)
  return step
}

describe('resumable desktop release workflow', () => {
  it('retains archives before submitting and each receipt before the next submission', () => {
    const checkpoint = named('Retain signed archives before Apple submission')
    const armSubmit = named('Submit arm64 archive once')
    const armReceipt = named('Retain arm64 submission receipt')
    const x64Submit = named('Submit x64 archive once')
    expect(steps.indexOf(checkpoint)).toBeLessThan(steps.indexOf(armSubmit))
    expect(steps.indexOf(armSubmit)).toBeLessThan(steps.indexOf(armReceipt))
    expect(steps.indexOf(armReceipt)).toBeLessThan(steps.indexOf(x64Submit))
    for (const step of [checkpoint, armReceipt, named('Retain x64 submission receipt')]) {
      expect(step.uses).toBe('actions/upload-artifact@v4')
      expect(step.with?.['retention-days']).toBe(30)
      expect(step.with?.['if-no-files-found']).toBe('error')
      expect(step.with?.path).not.toMatch(/\.p8|\.p12|AuthKey/)
    }
  })

  it('never rebuilds or submits while resuming and validates provenance before download', () => {
    for (const name of [
      'Build official runtime and desktop entry', 'Build signed updater archives without submitting to Apple',
      'Submit arm64 archive once', 'Submit x64 archive once',
    ]) expect(named(name).if).toBe("env.RESUME_RUN_ID == ''")
    const provenance = named('Validate resume source provenance')
    expect(provenance.if).toBe("env.RESUME_RUN_ID != ''")
    const downloads = steps.filter(step => step.uses === 'actions/download-artifact@v4')
    expect(downloads).toHaveLength(3)
    for (const step of downloads) {
      expect(steps.indexOf(provenance)).toBeLessThan(steps.indexOf(step))
      expect(step.if).toBe("env.RESUME_RUN_ID != ''")
      expect(step.with?.['run-id']).toBe('${{ env.RESUME_RUN_ID }}')
    }
    expect(workflow.permissions.actions).toBe('read')
    expect(workflow.jobs.release.environment).toBe('desktop-release')
  })

  it('requires both Apple acceptances before every finalization and draft publication step', () => {
    for (const name of [
      'Restore and staple accepted applications', 'Assemble final installers from the notarized applications',
      'Verify signed and notarized applications', 'Smoke test packaged backend authorization',
      'Verify update and installer artifacts', 'Create or update draft GitHub Release',
    ]) expect(named(name).if).toBe("steps.notary.outputs.accepted == 'true'")
    expect(named('Create or update draft GitHub Release').run).toContain('--draft')
    expect(named('Create or update draft GitHub Release').run).toContain('already published and will not be overwritten')
  })

  it('exposes signing credentials only to the fresh signed-archive build', () => {
    const signingSteps = steps.filter(step => step.env?.CSC_LINK !== undefined || step.env?.CSC_KEY_PASSWORD !== undefined)
    expect(signingSteps).toEqual([named('Build signed updater archives without submitting to Apple')])
  })

  it.skipIf(process.platform === 'win32')('keeps every inline Bash script syntactically valid', () => {
    for (const step of steps.filter(candidate => candidate.run !== undefined)) {
      const result = spawnSync('/bin/bash', ['-n'], { input: step.run, encoding: 'utf8', timeout: 5_000 })
      expect(result.error, step.name).toBeUndefined()
      expect(result.signal, step.name).toBeNull()
      expect(result.status, result.stderr).toBe(0)
    }
  })

  it('builds signed updater-ready ZIPs without builder-owned notarization', () => {
    const config = fileURLToPath(new URL('../electron-builder.checkpoint.cjs', import.meta.url))
    const result: unknown = JSON.parse(execFileSync(process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', config],
      { encoding: 'utf8', env: { DSH_DESKTOP_RELEASE: '1' }, timeout: 5_000 }))
    expect(result).toMatchObject({
      forceCodeSigning: true, mac: { notarize: false, hardenedRuntime: true },
      publish: { provider: 'github', releaseType: 'draft', tagNamePrefix: 'desktop-v' },
    })
    const build = named('Build signed updater archives without submitting to Apple').run
    expect(build).toContain('--mac zip --arm64 --x64')
    expect(build).toContain('--publish never')
  })
})
