// Account-owned viewer choices. Each account has its own query, including when users
// sign out and back in in the same tab. Writes patch one choice in the writer transaction.
import { useAtomValue } from "@effect/atom-react"
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { useEffect, useSyncExternalStore } from "react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useAction } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { PreferenceWrites } from "./preferenceWrites.ts"

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
  const action = useAction()
  const writes = useAtomValue(writesFor(userId))
  const optimistic = useSyncExternalStore(writes.subscribe, writes.snapshot)
  const prefs = AsyncResult.isSuccess(result) ? result.value.prefs : DEFAULT_DISPLAY_PREFS
  useEffect(() => {
    if (AsyncResult.isSuccess(result) && !result.waiting) writes.confirm(result.value.revision)
  }, [writes, result, optimistic])
  return {
    prefs: { ...prefs, ...optimistic },
    ready: AsyncResult.isSuccess(result),
    pending: action.pending,
    error: action.error,
    change: (change: DisplayPrefsChange) =>
      writes.change(change, (acknowledge) =>
        action.run(
          (client) => client("SetDisplayPrefs", { prefs: change }).pipe(Effect.tap(() => Effect.sync(acknowledge))),
          ["displayPrefs"]
        )
      )
  }
}
