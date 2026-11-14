// Only admitted, approved browser plugin URLs arrive here. Content is never imported.
// This is a liveness boundary for display callbacks, not a new plugin trust category.
import type { DisplayTransformV1, DisplayScriptListV1, TimelineTransformV1 } from "../../plugin-api/src/display.ts"

const disposers: Array<() => void> = []
const dispose = async () => {
  for (const stop of disposers.splice(0).reverse()) {
    try {
      await stop()
    } catch {
      /* Continue cleanup. */
    }
  }
  entries.clear()
}
const entries = new Map<string, DisplayTransformV1 | DisplayScriptListV1 | TimelineTransformV1>()
const freeze = (value: unknown): unknown => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
self.onmessage = async (
  event: MessageEvent<{
    kind: "init" | "call" | "dispose"
    url?: string
    id?: string
    surfaces?: ReadonlyArray<string>
    registry?: string
    entry?: string
    input?: unknown
  }>
) => {
  try {
    const job = event.data
    if (job.kind === "dispose") {
      await dispose()
      self.postMessage({ kind: "disposed" })
      return
    }
    if (job.kind === "init") {
      const registries: Record<string, unknown> = {}
      const metadata: Array<{ registry: string; api: number; id: string; order: number }> = []
      for (const registry of ["displayTransforms", "displayScriptLists", "timelineTransforms"]) {
        if (!job.surfaces?.includes(`client:${registry}`)) continue
        registries[registry] = Object.freeze({
          register: (entry: DisplayTransformV1 | DisplayScriptListV1 | TimelineTransformV1) => {
            const key = `${registry}:${entry.id}`
            if (entry.api !== 1 || entries.has(key) || !Number.isFinite(entry.order)) throw new Error("Invalid rule")
            entries.set(key, entry)
            metadata.push({ registry, api: entry.api, id: entry.id, order: entry.order })
            return () => {
              entries.delete(key)
            }
          },
          list: () => [],
          disable: () => {
            throw new Error("Register a replacement rule instead")
          }
        })
      }
      if (!job.url || !/^\/plugins\/(instance|user)\/[a-z][a-z0-9-]{0,63}\/[a-f0-9]{40}\/client\.mjs$/.test(job.url))
        throw new Error("Invalid display plugin URL")
      const module = (await import(/* @vite-ignore */ job.url)) as {
        activate: (host: unknown) => unknown
      }
      await module.activate(
        Object.freeze({
          api: 1,
          id: job.id,
          registries: Object.freeze(registries),
          onDispose: (stop: () => void) => {
            disposers.push(stop)
          }
        })
      )
      if (metadata.length > 100) throw new Error("Too many rules")
      self.postMessage({ kind: "ready", entries: metadata })
    } else {
      const entry = entries.get(`${job.registry}:${job.entry}`)
      if (!entry) throw new Error("Rule is off")
      freeze(job.input)
      const value =
        "transform" in entry
          ? await (entry.transform as (input: unknown) => unknown)(job.input)
          : await entry.scripts(job.input as Parameters<DisplayScriptListV1["scripts"]>[0])
      // Validation/serialization is inside the same host deadline as the callback.
      const encoded = JSON.stringify(value)
      if (encoded.length > 2_000_000) throw new Error("Output limit")
      self.postMessage({ kind: "result", value })
    }
  } catch {
    await dispose()
    self.postMessage({ kind: "fault" })
  }
}
