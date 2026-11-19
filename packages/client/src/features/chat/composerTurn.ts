// The reply order follows the branch's tip, even when the message list is scrolled to
// older history. Read backwards in windows only until a character's last turn is found, unless
// the messages shown already reach the tip with one in them. Either way the entries run to the
// tip, whose message Auto's pick reads (replyPolicy.ts).
import type { PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import type { Cast } from "@dreamspan/shared/chatSetupApi.ts"
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
  // The messages shown reach the tip and hold a character's turn: they answer it without a read,
  // so the composer doesn't wait on the server after every reply.
  const characters = cast?.participants.filter((id) => !cast.playedByMe.includes(id)) ?? []
  const shown =
    cast !== null &&
    !view.loading &&
    view.newer === null &&
    view.entries.at(-1)?.slotId === leaf &&
    (characters.length === 0 ||
      view.entries.some(
        (entry) => entry.version.speakerEntityId !== null && characters.includes(entry.version.speakerEntityId)
      ))
  useEffect(() => {
    if (cast === null || shown) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
      let range: { _tag: "Bottom" } | { _tag: "Older"; from: SlotId } = { _tag: "Bottom" }
      // The windows read so far, oldest first.
      let windows: ReadonlyArray<PathEntry> = []
      while (!cancelled) {
        const result = await session.call((client) =>
          client("ReadPath", { chatId: session.id, leafSlotId: leaf, range, limit: 60 })
        )
        if (cancelled) return
        if (!result.ok) {
          timer = setTimeout(() => void read(), 2000)
          return
        }
        const { older } = result.value
        const entries = [...result.value.entries, ...windows]
        windows = entries
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
  }, [session, leaf, cast, revision, shown])
  if (shown) return view.entries
  return tail?.leaf === leaf && tail.cast === cast && tail.revision === revision ? tail.entries : null
}
