import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('links the authored updater import against the real CommonJS package in native Node ESM', () => {
  const source = ts.createSourceFile('updater.ts',
    readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = source.statements.filter(ts.isImportDeclaration).filter(statement =>
    ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'electron-updater'
    && statement.importClause !== undefined && statement.importClause.phaseModifier !== ts.SyntaxKind.TypeKeyword)
  expect(imports).toHaveLength(1)
  // Import linking does not access the updater getter, which requires a running Electron app.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    imports[0]!.getText(source) + '\nconsole.log("updater-linked")'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {},
    encoding: 'utf8',
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('updater-linked')
})
