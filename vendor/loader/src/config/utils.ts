import { valueMap } from '@deepseek-ai/cosmokit'

type Evaluator = (this: unknown, ctx: object, expr: string) => any

let evaluator: Evaluator | undefined

/** Evaluate in the loader scope; string compilation is required only on first use. */
export function evaluate(this: unknown, ctx: object, expr: string): any {
  // eslint-disable-next-line no-new-func
  evaluator ??= new Function('ctx', 'expr', `
    with (ctx) {
      return eval(expr)
    }
  `) as Evaluator
  return evaluator.call(this, ctx, expr)
}

/** Recursively replace YAML `!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/** Return true when a value is a serialized loader JavaScript expression. */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}
