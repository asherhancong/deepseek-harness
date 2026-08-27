/** WebServer binding for the client module registry and browser boot protocol. */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { WebBootGraph } from './client/manifest.ts'

/** Registry reads needed by the WebServer binding. */
export interface ClientModuleWebSource {
  /** Return the current stable browser boot graph. */
  graph(): WebBootGraph
  /** Resolve one graph id to its built bundle path. */
  clientPath(id: string): string | undefined
}

/**
 * Project a bundle id and revision onto the Web carrier's route.
 * @param id - client package id.
 * @param rev - bundle content revision.
 * @returns the same-origin bundle URL carried by the boot graph.
 */
export function webClientBundleUrl(id: string, rev: string): string {
  return `/plugins/${id}/client.js?rev=${rev}`
}

/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** Dynamic package whose ordinary client bundle must be registered before plugin boot starts. */
const CLIENT_RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

/** Ordinary dynamic bundles the HTML parser executes before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const

/**
 * The boot protocol as index injection rows. The inline registration queue
 * precedes blocking classic scripts for modules' and runtime's ordinary
 * `lib/client.js` artifacts. Its `create()` method materializes the modules
 * bundle, delegates construction to that bundle, and leaves the same facade
 * in live-registration mode. The graph global follows before the shell reads
 * it.
 * @param graph - the composed entry graph.
 * @returns head rows in execution order: queue script, preload scripts, graph global.
 */
export function bootInjections(graph: WebBootGraph): IndexInjection[] {
  const bootstrapId = JSON.stringify(CLIENT_MODULES_ID)
  const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
  const preload = PARSER_PRELOAD_IDS.map(id => graph.entries.find(entry => entry.id === id))
    .filter((entry): entry is WebBootGraph['entries'][number] => entry !== undefined)
    .map((entry): IndexInjection => ({ kind: 'script-src', placement: 'head', src: entry.url }))
  return [
    { kind: 'script', placement: 'head', text: queue },
    ...preload,
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ]
}

/**
 * Bind one registry to the WebServer route and index-injection event.
 * @param ctx - plugin context carrying the WebServer service.
 * @param source - registry graph and artifact reader.
 */
export function bindClientModulesToWeb(ctx: Context, source: ClientModuleWebSource): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: createBundleHandler(source),
    }),
    'client-modules: bundle route',
  )
  ctx.on('webserver/index-inject', (table) => {
    table.push(...bootInjections(source.graph()))
  })
}

/** Serve one registered bundle or source map through the Web carrier. */
function createBundleHandler(source: ClientModuleWebSource) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    // The id may contain a scope slash. Anything else under /plugins (including
    // /plugins/events when the HMR row is absent) is an unknown resource.
    const prefix = '/plugins/'
    const mapSuffix = '/client.js.map'
    const bundleSuffix = '/client.js'
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    const clientPath = pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? source.clientPath(pathname.slice(prefix.length, -suffix.length))
      : undefined
    const path = clientPath === undefined ? undefined : `${clientPath}${isSourceMap ? '.map' : ''}`
    if (path === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      // Registered but unreadable (bundle not built yet): loud 404 beats a silent SPA-fallback HTML page.
      res.writeHead(404)
      res.end()
    }
  }
}
