import type { Notice } from "@dreamspan/shared/noticeApi.ts"
// Account-owned viewer choices. Each account has its own query, including when users
// sign out and back in in the same tab. Writes patch one choice in the writer transaction.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs, type DisplayPrefsChange } from "@dreamspan/shared/chatApi.ts"
import { useEffect, useSyncExternalStore } from "react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useAction } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { PreferenceWrites } from "./preferenceWrites.ts"

const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("dreamspan.displayPrefs")

const notifyDisplayPrefsChanged = () => channel?.postMessage("changed")
const listeners = new Set<() => void>()
export const onDisplayPrefsChanged = (refresh: () => void) => {
  listeners.add(refresh)
  return () => {
    listeners.delete(refresh)
  }
}
// Deduplicate prefs refreshes per userId across all mounted `useViewPrefs()` callers.
const refreshers = new Map<string, { refresh: () => void; count: number }>()
const refreshAllPrefs = () => {
  for (const { refresh } of refreshers.values()) refresh()
}
channel?.addEventListener("message", refreshAllPrefs)
if (typeof window !== "undefined") window.addEventListener("focus", refreshAllPrefs)

export const displayNoticeReceiver = {
  id: "display.live",
  receive: (notice: Notice) => {
    if (notice._tag === "DisplayPrefsChanged" || notice._tag === "UserDraftSync") {
      refreshAllPrefs()
      for (const refresh of listeners) refresh()
    }
  }
}

const writesFor = Atom.family((_userId: string) => Atom.make(new PreferenceWrites()))
const prefsFor = Atom.family((userId: string) =>
  AppClient.runtime
    .atom((get) => {
      const writes = get(writesFor(userId))
      return Effect.gen(function* () {
        const client = yield* AppClient
        const revision = writes.readRevision()
        const prefs = yield* client("GetDisplayPrefs", {})
        return { prefs, revision }
      })
    })
    .pipe(AppClient.runtime.factory.withReactivity(["displayPrefs", `displayPrefs:${userId}`]))
)

export function useViewPrefs() {
  const userId = useSession().user.id
  const result = useAtomValue(prefsFor(userId))
  const refresh = useAtomRefresh(prefsFor(userId))
  useEffect(() => {
    const existing = refreshers.get(userId)
    if (existing) {
      existing.count++
      existing.refresh = refresh
    } else refreshers.set(userId, { refresh, count: 1 })
    return () => {
      const current = refreshers.get(userId)
      if (!current) return
      current.count--
      if (current.count <= 0) refreshers.delete(userId)
    }
  }, [userId, refresh])
  const action = useAction()
  const writes = useAtomValue(writesFor(userId))
  const optimistic = useSyncExternalStore(writes.subscribe, writes.snapshot)
  const prefs = AsyncResult.isSuccess(result) ? result.value.prefs : DEFAULT_DISPLAY_PREFS
  useEffect(() => {
    if (AsyncResult.isSuccess(result) && !result.waiting) writes.confirm(result.value.revision)
  }, [writes, result, optimistic])
  return {
    prefs: {
      ...prefs,
      ...optimistic,
      chatBackground: { ...prefs.chatBackground, ...optimistic.chatBackground }
    } satisfies DisplayPrefs,
    ready: AsyncResult.isSuccess(result),
    pending: action.pending,
    error: action.error,
    /**
     * `change` shows at once; `sent` (by default the same) is what the server is asked to
     * merge, for a choice it merges by key (the message toolbar's) where the change shown is
     * the whole map.
     */
    change: (change: DisplayPrefsChange, sent: DisplayPrefsChange = change) =>
      writes.change(change, (acknowledge) =>
        action.run(
          (client) =>
            client("SetDisplayPrefs", { prefs: sent }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  acknowledge()
                  notifyDisplayPrefsChanged()
                })
              )
            ),
          ["displayPrefs"]
        )
      )
  }
}
