import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function compileSource(path: string): string {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

const cosmokitSource = compileSource('../../../vendor/cosmokit/src/misc.ts')
const loaderSource = compileSource('../../../vendor/loader/src/config/utils.ts')

function loadUtils(strings: boolean): (expression: string) => unknown {
  const context = createContext({}, { codeGeneration: { strings, wasm: false } })
  // Both implementations and test inputs share a realm: isJsExpr uses instanceof Object.
  runInContext(`
    globalThis.compilations = 0;
    globalThis.Function = new Proxy(Function, {
      construct(target, args, newTarget) {
        compilations += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    const cosmokit = (() => { const exports = {}; ${cosmokitSource}; return exports; })();
    globalThis.loader = (() => {
      const exports = {};
      const require = name => {
        if (name === '@deepseek-ai/cosmokit') return cosmokit;
        throw new Error('Unexpected loader dependency: ' + name);
      };
      ${loaderSource}
      return exports;
    })();
  `, context)
  return expression => runInContext(expression, context) as unknown
}

describe('Loader initialization under desktop string-compilation restrictions', () => {
  it('loads the source module without compiling an expression evaluator', () => {
    const run = loadUtils(false)
    expect(run('typeof loader.evaluate')).toBe('function')
    expect(run('compilations')).toBe(0)
  })

  it('interpolates literal boot configuration without string compilation', () => {
    const run = loadUtils(false)
    expect(run(`loader.interpolate({}, {
      name: 'web', config: { enabled: true, count: 0 }, items: [null, false, 'literal'], empty: undefined,
    })`)).toEqual({ name: 'web', config: { enabled: true, count: 0 }, items: [null, false, 'literal'], empty: undefined })
    expect(run('compilations')).toBe(0)
  })

  it('still rejects an actual expression when string compilation is prohibited', () => {
    const run = loadUtils(false)
    expect(() => run('loader.interpolate({}, { __jsExpr: "1 + 1" })')).toThrow(/Code generation from strings disallowed/)
    expect(() => run('loader.evaluate({}, "1 + 1")')).toThrow(/Code generation from strings disallowed/)
  })
})

describe('Loader Host expression behavior', () => {
  it('caches compilation while reading each current context and preserving the receiver', () => {
    const run = loadUtils(true)
    expect(run('compilations')).toBe(0)
    expect(run(`(() => {
      const ctx = { value: 3 };
      const first = loader.evaluate(ctx, 'value * 2');
      ctx.value = 4;
      return [first, loader.evaluate(ctx, 'value * 2'), loader.evaluate({ value: 5 }, 'value * 2'),
        loader.evaluate.call({ bonus: 7 }, ctx, 'this.bonus + value')];
    })()`)).toEqual([6, 8, 10, 11])
    expect(run('compilations')).toBe(1)
  })

  it('recursively interpolates expression values without changing literal values', () => {
    const run = loadUtils(true)
    expect(run(`loader.interpolate({ count: 3, enabled: false }, {
      count: { __jsExpr: 'count + 1' }, values: [{ __jsExpr: 'enabled' }, null, 'literal'],
      nested: { empty: { __jsExpr: 'undefined' }, object: { __jsExpr: '({ count })' } },
    })`)).toEqual({ count: 4, values: [false, null, 'literal'], nested: { empty: undefined, object: { count: 3 } } })
    expect(run('compilations')).toBe(1)
  })

  it.each(['(', 'missingLoaderValue', '(() => { throw new Error("expression failed") })()'])(
    'keeps expression failures observable and the cached evaluator reusable: %s', (expression) => {
      const run = loadUtils(true)
      expect(() => run(`loader.evaluate({}, ${JSON.stringify(expression)})`)).toThrow()
      expect(run('loader.evaluate({ value: 9 }, "value")')).toBe(9)
      expect(run('compilations')).toBe(1)
    },
  )
})
