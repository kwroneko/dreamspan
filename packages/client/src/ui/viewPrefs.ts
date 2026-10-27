// Account-owned viewer choices. Each account has its own query, including when users
// sign out and back in in the same tab. Writes patch one choice in the writer transaction.
import { useAtomValue } from "@effect/atom-react"
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import { useAction } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"

const prefsFor = Atom.family((userId: string) =>
  AppClient.query("GetDisplayPrefs", {}, { reactivityKeys: ["displayPrefs", `displayPrefs:${userId}`] })
)

export function useViewPrefs() {
  const userId = useSession().user.id
  const result = useAtomValue(prefsFor(userId))
  const action = useAction()
  const prefs = AsyncResult.isSuccess(result) ? result.value : DEFAULT_DISPLAY_PREFS
  return {
    prefs,
    ready: AsyncResult.isSuccess(result),
    pending: action.pending,
    error: action.error,
    change: (change: DisplayPrefsChange) =>
      action.run((client) => client("SetDisplayPrefs", { prefs: change }), ["displayPrefs"])
  }
}
