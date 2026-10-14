// The reply order follows the branch's tip, even when the message list is scrolled to
// older history. Read backwards in windows only until a character's last turn is found.
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import { useEffect, useState } from "react"
import type { ChatSession, ChatView } from "./session.ts"

export function useComposerTurn(session: ChatSession, view: ChatView, cast: Cast | null) {
  const [tail, setTail] = useState<{
    leaf: SlotId | null
    cast: Cast
    revision: number
    entries: ReadonlyArray<PathEntry>
  } | null>(null)
  const leaf = view.leafSlotId
  const revision = view.pathRevision
  useEffect(() => {
    if (cast === null) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
      let range: { _tag: "Bottom" } | { _tag: "Older"; from: SlotId } = { _tag: "Bottom" }
      while (!cancelled) {
        const result = await session.call((client) =>
          client("ReadPath", { chatId: session.id, leafSlotId: leaf, range, limit: 60 })
        )
        if (cancelled) return
        if (!result.ok) {
          timer = setTimeout(() => void read(), 2000)
          return
        }
        const { entries, older } = result.value
        if (
          characters.length === 0 ||
          older === null ||
          entries.some(
            (entry) => entry.version.speakerEntityId !== null && characters.includes(entry.version.speakerEntityId)
          )
        ) {
          setTail({ leaf, cast, revision, entries })
          return
        }
        range = { _tag: "Older", from: older }
      }
    }
    void read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [session, leaf, cast, revision])
  return tail?.leaf === leaf && tail.cast === cast && tail.revision === revision ? tail.entries : null
}
