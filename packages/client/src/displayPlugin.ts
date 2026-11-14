import type { ClientPlugin } from "@rp/shared/pluginClient.ts"

export const DISPLAY_PLUGIN_DEADLINE_MS = 50
export const isDisplayPlugin = (p: ClientPlugin) =>
  p.manifest.surfaces.some(
    (s) => s === "client:displayTransforms" || s === "client:displayScriptLists" || s === "client:timelineTransforms"
  )
export interface DisplayRuleMetadata {
  readonly registry: "displayTransforms" | "displayScriptLists" | "timelineTransforms"
  readonly api: 1
  readonly id: string
  readonly order: number
}
export interface DisplayBridge {
  readonly call: (registry: string, entry: string, input: unknown) => Promise<unknown>
  readonly close: () => void
}

/** One worker per plugin and one callback at a time. Timeouts terminate execution,
 * reject queued work and restore originals; a late answer can never publish again. */
export const startDisplayPlugin = (
  p: ClientPlugin,
  url: string
): {
  bridge: DisplayBridge
  ready: Promise<ReadonlyArray<DisplayRuleMetadata>>
} => {
  const worker = new Worker(new URL("./displayPlugin.worker.ts", import.meta.url), { type: "module" })
  let live = true
  let pending = 0
  let queue: Promise<unknown> = Promise.resolve()
  let rejectCurrent: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposing: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    clearTimeout(timer)
    clearTimeout(disposing)
    live = false
    worker.terminate()
    rejectCurrent?.(new Error("Display copy stopped"))
    rejectCurrent = undefined
  }
  const close = () => {
    if (!live) return
    live = false
    clearTimeout(timer)
    rejectCurrent?.(new Error("Display copy stopped"))
    rejectCurrent = undefined
    // Revocation is immediate. Give cooperative worker cleanup one bounded turn;
    // a hung callback/cleanup is still terminated without blocking the page.
    worker.onmessage = () => terminate()
    worker.onerror = terminate
    disposing = setTimeout(terminate, DISPLAY_PLUGIN_DEADLINE_MS)
    worker.postMessage({ kind: "dispose" })
  }
  const exchange = <A>(job: unknown, ms: number, kind: string) =>
    new Promise<A>((resolve, reject) => {
      if (!live) {
        reject(new Error("Display copy is off"))
        return
      }
      rejectCurrent = reject
      timer = setTimeout(terminate, ms)
      worker.onerror = terminate
      worker.onmessage = (event: MessageEvent<{ kind: string; entries: A; value: A }>) => {
        if (!live) return
        if (event.data.kind !== kind) {
          terminate()
          return
        }
        clearTimeout(timer)
        rejectCurrent = undefined
        resolve(kind === "ready" ? event.data.entries : event.data.value)
      }
      worker.postMessage(job)
    })
  const ready = exchange<ReadonlyArray<DisplayRuleMetadata>>(
    {
      kind: "init",
      id: p.id,
      url,
      surfaces: p.manifest.surfaces
    },
    3000,
    "ready"
  )
  queue = ready.catch(() => undefined)
  const bridge: DisplayBridge = {
    close,
    call: (registry, entry, input) => {
      if (!live || pending >= 128) return Promise.reject(new Error("Display copy is busy or off"))
      pending++
      const result = queue
        .then(() => exchange<unknown>({ kind: "call", registry, entry, input }, DISPLAY_PLUGIN_DEADLINE_MS, "result"))
        .finally(() => {
          pending--
        })
      queue = result.catch(() => undefined)
      return result
    }
  }
  return { bridge, ready }
}
