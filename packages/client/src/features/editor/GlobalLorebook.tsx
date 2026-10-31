// A lorebook used in every chat or not (DESIGN §5.0): the user's, for all chats; each chat can
// still turn it off in its Lorebooks tab.
import type { RefId } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { Switch } from "../../ui/Choice.tsx"
import type { Caller } from "./caller.ts"

export function GlobalLorebook({ refId, call }: { refId: RefId; call: Caller }) {
  const [global, setGlobal] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void call((client) => client("GetGlobalLorebooks", undefined)).then(
      (result) => live && result.ok && setGlobal(result.value.includes(refId))
    )
    return () => {
      live = false
    }
  }, [call, refId])
  return (
    <Switch
      checked={global ?? false}
      disabled={global === null}
      onCheckedChange={(next) =>
        void call((client) => client("SetGlobalLorebook", { ref: refId, global: next })).then(
          (result) => result.ok && setGlobal(result.value.includes(refId))
        )
      }
      description="Unless a chat turns it off in its Lorebooks tab."
    >
      Use in every chat
    </Switch>
  )
}
