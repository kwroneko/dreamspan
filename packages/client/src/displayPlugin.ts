import type { ClientPlugin } from "@rp/shared/pluginClient.ts"
import { PERF, perf } from "./features/chat/perf.ts"

export const DISPLAY_PLUGIN_DEADLINE_MS = 50
/** Calls waiting for the worker. Abandoned calls leave the queue, so this is live work only. */
const DISPLAY_PLUGIN_QUEUE = 512
const DISPLAY_REGISTRIES = ["displayTransforms", "displayScriptLists", "timelineTransforms"] as const
export const isDisplayPlugin = (p: ClientPlugin) =>
  p.manifest.surfaces.some((s) => DISPLAY_REGISTRIES.some((registry) => s === `client:${registry}`))
export interface DisplayRuleMetadata {
  readonly registry: (typeof DISPLAY_REGISTRIES)[number]
  readonly api: 1
  readonly id: string
  readonly order: number
}
export interface DisplayBridge {
  /** `signal` abandons the call: one not yet sent is dropped and never reaches the worker. */
  readonly call: (registry: string, entry: string, input: unknown, signal?: AbortSignal) => Promise<unknown>
  readonly close: () => void
  /** Called when the worker is stopped for a fault while no call is waiting to report it. */
  readonly onFault?: (listener: () => void) => void
}
/** The caller no longer wants this answer. Never a fault of the copy. */
export class DisplaySuperseded extends Error {
  constructor() {
    super("Display call superseded")
  }
}

/** What activation may announce: plain, bounded, and only in registries the plugin declared. */
const announced = (value: unknown, p: ClientPlugin): ReadonlyArray<DisplayRuleMetadata> => {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid display rules")
  const seen = new Set<string>()
  return value.map((entry: unknown) => {
    const rule = entry as Partial<DisplayRuleMetadata> | null
    const registry = DISPLAY_REGISTRIES.find((name) => name === rule?.registry)
    if (
      !rule ||
      !registry ||
      !p.manifest.surfaces.includes(`client:${registry}`) ||
      rule.api !== 1 ||
      typeof rule.id !== "string" ||
      !/^[a-z][a-zA-Z0-9._/-]{0,99}$/.test(rule.id) ||
      typeof rule.order !== "number" ||
      !Number.isFinite(rule.order) ||
      seen.has(`${registry}:${rule.id}`)
    )
      throw new Error("Invalid display rule")
    seen.add(`${registry}:${rule.id}`)
    return { registry, api: 1, id: rule.id, order: rule.order }
  })
}

interface Job {
  readonly message: {
    readonly kind: "call"
    readonly registry: string
    readonly entry: string
    readonly input: unknown
  }
  readonly signal: AbortSignal | undefined
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  abandon?: () => void
}

/** One worker per plugin and one callback at a time. The plugin shares the worker's global,
 * so every message from it is untrusted: an answer must carry the number of the one exchange
 * in flight, and anything else (an unknown shape, a repeated or early answer, a message while
 * nothing was asked) terminates the worker. Timeouts terminate too, reject queued work and
 * restore originals; a late answer can never publish again. */
export const startDisplayPlugin = (
  p: ClientPlugin,
  url: string
): {
  bridge: DisplayBridge
  ready: Promise<ReadonlyArray<DisplayRuleMetadata>>
} => {
  const worker = new Worker(new URL("./displayPlugin.worker.ts", import.meta.url), { type: "module" })
  let live = true
  let seq = 0
  let current:
    { readonly seq: number; readonly kind: "ready" | "result"; readonly settle: (value: unknown) => void } | undefined
  let rejectCurrent: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposing: ReturnType<typeof setTimeout> | undefined
  let activated = false
  const queue: Job[] = []
  const stopped = () => new Error("Display copy stopped")
  let faulted: (() => void) | undefined
  const terminate = () => {
    // Not a fault when the host closed it first, or before activation (that fails the load).
    const fault = live && activated
    clearTimeout(timer)
    clearTimeout(disposing)
    live = false
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    current = undefined
    rejectCurrent?.(stopped())
    rejectCurrent = undefined
    for (const job of queue.splice(0)) {
      job.abandon?.()
      job.reject(stopped())
    }
    if (fault) faulted?.()
  }
  const close = () => {
    if (!live) return
    live = false
    clearTimeout(timer)
    current = undefined
    rejectCurrent?.(stopped())
    rejectCurrent = undefined
    for (const job of queue.splice(0)) {
      job.abandon?.()
      job.reject(stopped())
    }
    // Revocation is immediate. Give cooperative worker cleanup one bounded turn;
    // a hung callback/cleanup is still terminated without blocking the page.
    worker.onmessage = () => terminate()
    worker.onerror = terminate
    disposing = setTimeout(terminate, DISPLAY_PLUGIN_DEADLINE_MS)
    worker.postMessage({ kind: "dispose" })
  }
  worker.onerror = terminate
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (!live) return
    const data = event.data as { kind?: unknown; seq?: unknown; entries?: unknown; value?: unknown } | null
    const expected = current
    if (
      !expected ||
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.kind !== expected.kind ||
      data.seq !== expected.seq
    ) {
      terminate()
      return
    }
    clearTimeout(timer)
    current = undefined
    rejectCurrent = undefined
    expected.settle(expected.kind === "ready" ? data.entries : data.value)
    pump()
  }
  const exchange = (
    message: object,
    ms: number,
    kind: "ready" | "result",
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ) => {
    const number = ++seq
    current = { seq: number, kind, settle: resolve }
    rejectCurrent = reject
    // When the page itself was busy past the deadline, an answer that already arrived is
    // waiting behind this timer: one more turn lets it be read before the copy is stopped.
    timer = setTimeout(() => {
      timer = setTimeout(terminate, 0)
    }, ms)
    try {
      worker.postMessage({ ...message, seq: number })
    } catch {
      // Input that cannot be cloned is the host's failure to project, never left pending.
      terminate()
    }
  }
  const pump = () => {
    if (!live || !activated || current) return
    const job = queue.shift()
    if (!job) return
    job.abandon?.()
    const sent = PERF ? performance.now() : 0
    exchange(
      job.message,
      DISPLAY_PLUGIN_DEADLINE_MS,
      "result",
      PERF
        ? (value) => {
            const ms = performance.now() - sent
            perf.displayCalls++
            perf.displayCallMaxMs = Math.max(perf.displayCallMaxMs, ms)
            perf.displayCallMs.push(ms)
            if (perf.displayCallMs.length > 5000) perf.displayCallMs.shift()
            job.resolve(value)
          }
        : job.resolve,
      job.reject
    )
  }
  const ready = new Promise<ReadonlyArray<DisplayRuleMetadata>>((resolve, reject) => {
    exchange(
      { kind: "init", id: p.id, url, surfaces: p.manifest.surfaces },
      3000,
      "ready",
      (entries) => {
        try {
          const rules = announced(entries, p)
          activated = true
          resolve(rules)
        } catch (error) {
          terminate()
          reject(error as Error)
        }
      },
      reject
    )
  })
  ready.catch(() => undefined)
  const bridge: DisplayBridge = {
    close,
    onFault: (listener) => {
      faulted = listener
    },
    call: (registry, entry, input, signal) =>
      new Promise((resolve, reject) => {
        const refused = !live
          ? new Error("Display copy is off")
          : signal?.aborted
            ? new DisplaySuperseded()
            : queue.length >= DISPLAY_PLUGIN_QUEUE
              ? new Error("Display copy is busy")
              : undefined
        if (refused) {
          reject(refused)
          return
        }
        const job: Job = { message: { kind: "call", registry, entry, input }, signal, resolve, reject }
        if (signal) {
          const abandoned = () => {
            const at = queue.indexOf(job)
            if (at < 0) return
            queue.splice(at, 1)
            reject(new DisplaySuperseded())
          }
          signal.addEventListener("abort", abandoned, { once: true })
          job.abandon = () => signal.removeEventListener("abort", abandoned)
        }
        queue.push(job)
        if (PERF) perf.displayQueueMax = Math.max(perf.displayQueueMax, queue.length)
        pump()
      })
  }
  return { bridge, ready }
}
