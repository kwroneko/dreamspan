// Which of the chat's own notes is its author's note (DESIGN §4.1): notes and lore placed
// before or after "the author's note" go around it. A registered chat note action; the choice
// is the `author_note.set` state event, from the displayed message on, on this branch.
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import type { ChatSession } from "./session.ts"

export function AuthorNoteAction({
  note,
  session,
  onChanged
}: {
  note: ChatNote
  session: ChatSession
  onChanged: () => void
}) {
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  // A card's note is the card's, in every chat: only the chat's own notes can be its author's note.
  if (note.card !== null) return null
  const choose = async (entityId: ChatNote["ref"]["entityId"] | null) => {
    setPending(true)
    const outcome = await session.changeCast({ _tag: "AuthorNote", entityId })
    setPending(false)
    setError(outcome.ok ? null : outcome.error)
    onChanged()
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {note.authorNote ? (
          <Button pending={pending} onClick={() => void choose(null)}>
            Stop using as author's note
          </Button>
        ) : (
          <Button pending={pending} onClick={() => void choose(note.ref.entityId)}>
            Use as author's note
          </Button>
        )}
        <span className="text-sm text-muted">
          {note.authorNote
            ? "This is the chat's author's note: what's placed before or after the author's note goes around it."
            : "What's placed before or after the author's note would go around this note."}
        </span>
      </div>
      <ErrorAlert error={error} />
    </div>
  )
}
