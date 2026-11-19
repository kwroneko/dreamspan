import type { VersionId } from "@dreamspan/shared/chat.ts"
import { MAX_METRICS_VERSIONS, type VersionMetrics } from "@dreamspan/shared/inspectorApi.ts"
import type { ChatSession } from "./session.ts"

/** One batched read per microtask for the messages that asked; again when a version's status changes. */
export class MetricsLoader {
  private readonly loaded = new Map<VersionId, { readonly key: string; readonly metrics: VersionMetrics | null }>()
  private readonly wanted = new Map<VersionId, string>()
  private readonly listeners = new Set<() => void>()
  private scheduled = false
  private readonly session: ChatSession
  constructor(session: ChatSession) {
    this.session = session
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  /** Undefined until read for this key; null when the version has none. */
  peek(id: VersionId, key: string) {
    const entry = this.loaded.get(id)
    return entry?.key === key ? entry.metrics : undefined
  }
  want(id: VersionId, key: string) {
    if (this.loaded.get(id)?.key === key || this.wanted.get(id) === key) return
    this.wanted.set(id, key)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => void this.read())
  }
  /**
   * The version can finish a moment before its ledger row closes: a read that still found
   * the request running is read again, a few times, a second apart.
   */
  private readonly rereads = new Map<VersionId, { key: string; count: number }>()
  private reread(id: VersionId, key: string) {
    const before = this.rereads.get(id)
    const n = before?.key === key ? before.count : 0
    if (n >= 5) return
    this.rereads.set(id, { key, count: n + 1 })
    setTimeout(() => {
      this.loaded.delete(id)
      this.want(id, key)
    }, 1000)
  }
  private async read() {
    this.scheduled = false
    const batch = [...this.wanted].slice(0, MAX_METRICS_VERSIONS)
    for (const [id] of batch) this.wanted.delete(id)
    if (this.wanted.size > 0) {
      this.scheduled = true
      queueMicrotask(() => void this.read())
    }
    const outcome = await this.session.call((client) =>
      client("GetVersionMetrics", { versionIds: batch.map(([id]) => id) })
    )
    if (!outcome.ok) {
      for (const [id, key] of batch) this.reread(id, key)
      return
    }
    const found = new Map(outcome.value.map((metrics) => [metrics.versionId, metrics]))
    for (const [id, key] of batch) {
      const metrics = found.get(id) ?? null
      this.loaded.set(id, { key, metrics })
      if (metrics?.running) this.reread(id, key)
    }
    for (const listener of this.listeners) listener()
  }
}
