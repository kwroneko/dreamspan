import type { DisplayPrefsChange } from "@dreamspan/shared/chatApi.ts"

// Shared by the account's consumers in one atom registry. Reads carry the last
// acknowledged write at request start, so an older read cannot retire newer choices.
export class PreferenceWrites {
  private entries: Array<{ change: DisplayPrefsChange; revision: number; saved: boolean }> = []
  private listeners = new Set<() => void>()
  private tail: Promise<unknown> = Promise.resolve()
  private value: DisplayPrefsChange = {}
  private revision = 0
  private acknowledged = 0
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.value
  readRevision = () => this.acknowledged
  private publish() {
    this.value = Object.assign({}, ...this.entries.map((entry) => entry.change))
    this.listeners.forEach((listener) => listener())
  }
  confirm(revision: number) {
    const remaining = this.entries.filter((entry) => !entry.saved || entry.revision > revision)
    if (remaining.length === this.entries.length) return
    this.entries = remaining
    this.publish()
  }
  change<A extends { ok: boolean }>(change: DisplayPrefsChange, save: (acknowledge: () => void) => Promise<A>) {
    const entry = { change, revision: ++this.revision, saved: false }
    this.entries.push(entry)
    this.publish()
    const result = this.tail
      .then(() =>
        save(() => {
          // The caller acknowledges before invalidating queries, so the resulting
          // read can retire this write even if another browser has changed it since.
          entry.saved = true
          this.acknowledged = entry.revision
        })
      )
      .then((result) => {
        if (!result.ok) this.entries = this.entries.filter((item) => item !== entry)
        this.publish()
        return result
      })
    this.tail = result.catch(() => {})
    return result
  }
}
