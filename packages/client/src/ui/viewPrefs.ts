// Account-owned viewer choices. Each account has its own query, including when users
// sign out and back in in the same tab. Writes patch one choice in the writer transaction.
import { useAtomValue } from "@effect/atom-react"
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs, type DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { useEffect, useSyncExternalStore } from "react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useAction } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"

const prefsFor = Atom.family((userId: string) =>
  AppClient.query("GetDisplayPrefs", {}, { reactivityKeys: ["displayPrefs", `displayPrefs:${userId}`] })
)

// Shared by the account's consumers in this React atom registry. Keep local choices
// over query refreshes until acknowledged, and send rapid changes in their click order.
class PreferenceWrites {
  private entries: Array<{ change: DisplayPrefsChange; savedAt: number | null }> = []
  private listeners = new Set<() => void>()
  private tail: Promise<unknown> = Promise.resolve()
  private value: DisplayPrefsChange = {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.value
  private publish() {
    this.value = Object.assign({}, ...this.entries.map((entry) => entry.change))
    this.listeners.forEach((listener) => listener())
  }
  confirm(prefs: DisplayPrefs, timestamp: number) {
    const saved = this.entries.filter((entry) => entry.savedAt !== null)
    const patch: DisplayPrefsChange = Object.assign({}, ...saved.map((entry) => entry.change))
    if (
      saved.length === 0 ||
      saved.some((entry) => entry.savedAt! > timestamp) ||
      !Object.entries(patch).every(([key, value]) => prefs[key as keyof DisplayPrefs] === value)
    )
      return
    this.entries = this.entries.filter((entry) => entry.savedAt === null)
    this.publish()
  }
  change<A extends { ok: boolean }>(change: DisplayPrefsChange, save: () => Promise<A>) {
    const entry: { change: DisplayPrefsChange; savedAt: number | null } = { change, savedAt: null }
    this.entries.push(entry)
    this.publish()
    const result = this.tail.then(save).then((result) => {
      if (result.ok) entry.savedAt = Date.now()
      else this.entries = this.entries.filter((item) => item !== entry)
      this.publish()
      return result
    })
    this.tail = result.catch(() => {})
    return result
  }
}
const writesFor = Atom.family((_userId: string) => Atom.make(new PreferenceWrites()))

export function useViewPrefs() {
  const userId = useSession().user.id
  const result = useAtomValue(prefsFor(userId))
  const action = useAction()
  const writes = useAtomValue(writesFor(userId))
  const optimistic = useSyncExternalStore(writes.subscribe, writes.snapshot)
  const prefs = AsyncResult.isSuccess(result) ? result.value : DEFAULT_DISPLAY_PREFS
  useEffect(() => {
    if (AsyncResult.isSuccess(result) && !result.waiting) writes.confirm(result.value, result.timestamp)
  }, [writes, result, optimistic])
  return {
    prefs: { ...prefs, ...optimistic },
    ready: AsyncResult.isSuccess(result),
    pending: action.pending,
    error: action.error,
    change: (change: DisplayPrefsChange) =>
      writes.change(change, () =>
        action.run((client) => client("SetDisplayPrefs", { prefs: change }), ["displayPrefs"])
      )
  }
}
