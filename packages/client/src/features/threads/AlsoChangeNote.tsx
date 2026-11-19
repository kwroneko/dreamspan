// "Also change it in “Wren”" on the chat's own notes in a thread (spec/THREADS.md §5.2): a note
// changed in one thread doesn't change the others (DESIGN §4 [D] 2026-11-01), so this offers it
// as the user's explicit act. It copies the note as this thread has it saved, to the other
// thread's newest message on (`CopyNoteToBranch`). Registered in `chatNoteActions`.
import type { ForkId } from "@dreamspan/shared/chat.ts"
import type { ChatNote } from "@dreamspan/shared/chatSetupApi.ts"
import { useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useCast } from "../chat/cast.ts"
import type { ChatSession } from "../chat/session.ts"
import { threadName } from "./model.ts"
import { shownForkOf, useThreadSets } from "./threadSets.ts"

export function AlsoChangeNote({ note, session }: { note: ChatNote; session: ChatSession; onChanged: () => void }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const sets = useThreadSets(session, view) ?? []
  const cast = useCast()
  const [pending, setPending] = useState<ForkId | null>(null)
  const from = shownForkOf(view)
  // A card's note is the card's, the same in every chat: only the chat's own is per branch.
  if (note.card !== null || from === null) return null
  const others = sets.flatMap((set) =>
    set.threads.flatMap((thread) =>
      thread.ordinal === set.self || thread.openForkId === null
        ? []
        : [{ fork: thread.openForkId, name: threadName(thread, (id) => cast.cards.get(id)?.name ?? null) }]
    )
  )
  if (others.length === 0) return null
  const copy = async (to: ForkId, name: string) => {
    setPending(to)
    const result = await session.call((client) =>
      client("CopyNoteToBranch", { chatId: session.id, noteRefId: note.ref.id, fromForkId: from, toForkId: to })
    )
    setPending(null)
    showToast(
      result.ok
        ? { title: result.value ? `Changed in “${name}” too` : `“${name}” has this note as it is already` }
        : { title: `Couldn't change it in “${name}”`, description: result.error.message }
    )
  }
  return (
    <div data-note-also className="flex min-w-0 flex-wrap gap-1">
      {others.map((other) => (
        <Button
          key={other.fork}
          variant="ghost"
          pending={pending === other.fork}
          hint={`Puts this note, as it's saved here now, in the thread “${other.name}” too, from its newest message on. Save first to include what you've just typed.`}
          className="h-7! max-w-full px-2! text-xs!"
          onClick={() => void copy(other.fork, other.name)}
        >
          <span className="truncate">Also change it in “{other.name}”</span>
        </Button>
      ))}
    </div>
  )
}
