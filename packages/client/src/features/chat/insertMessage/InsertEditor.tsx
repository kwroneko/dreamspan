// The insertion editor (spec/MESSAGE-INSERT.md §4.2): inline under the message it goes below, in
// the stream, so the messages around it stay in view; a sheet on phones. Who speaks, the text (a
// direction for Generate), what inserting there changes, and the actions, all visible. What the
// next reply re-reads shows in the strip's cache chip while it's open.
import type { EntityId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { InsertBody } from "@rp/shared/messagesApi.ts"
import { useEffect, useId, useState, useSyncExternalStore } from "react"
import { AutoGrowTextarea } from "../../../ui/AutoGrowTextarea.tsx"
import { Button } from "../../../ui/Button.tsx"
import { Icon } from "../../../ui/Icon.tsx"
import { Sheet } from "../../../ui/Sheet.tsx"
import { showToast } from "../../../ui/Toast.tsx"
import { insertedToast } from "./toast.ts"
import type { AppError } from "../../../errors.ts"
import { defaultSpeaker, nameOf, recentSpeakers, useCast } from "../cast.ts"
import type { MessageDraft } from "../messageDraft.ts"
import { positionOf } from "../position.ts"
import type { ChatSession, Outcome } from "../session.ts"
import { useComposerChoice } from "../speaker.ts"
import { SpeakerSwitcher } from "../SpeakerSwitcher.tsx"
import { cacheNotes } from "../CacheIndicator.tsx"
import { editorKey } from "../messageDraft.ts"
import { cacheLine, insertEstimates, insertPosition, rereadCount } from "./estimates.ts"
import { openEditors, type InsertTarget } from "./openEditors.ts"
import { pickInsertSpeaker } from "./speakerDefault.ts"

/** A phone's width, where the editor is a sheet instead (as the version picker is). */
const PHONE = "(max-width: 639px)"
const subscribePhone = (listener: () => void) => {
  const query = matchMedia(PHONE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const usePhone = () => useSyncExternalStore(subscribePhone, () => matchMedia(PHONE).matches)

export function InsertEditor({
  session,
  anchor,
  target,
  editor
}: {
  session: ChatSession
  /** The message it goes below; null above the first message. */
  anchor: PathEntry | null
  target: InsertTarget
  editor: MessageDraft
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const { text, error: draftError } = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const castView = useCast()
  const choice = useComposerChoice(session)
  const phone = usePhone()
  const fieldId = useId()
  const [picked, setPicked] = useState<EntityId | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // When it opened: whether the cache is still warm is read as of then.
  const [now] = useState(() => Date.now())
  const [error, setError] = useState<AppError | null>(null)
  const estimates = useSyncExternalStore(insertEstimates.subscribe, insertEstimates.snapshot)

  const speaker =
    picked !== undefined
      ? picked
      : pickInsertSpeaker({
          anchor,
          entries: view.entries,
          cast: view.cast,
          composerSpeaker: choice.speaker ?? defaultSpeaker(view.cast)
        })
  const name = nameOf(castView, speaker) ?? "You"
  const position = insertPosition(anchor)
  const lines = [...estimates.entries]
    .sort((a, b) => a.order - b.order)
    .flatMap((estimate) => estimate.line({ view, anchor, position, now }) ?? [])
  // What the next reply re-reads goes to the strip's cache chip, while this is open.
  const reread = cacheLine({ view, anchor, position, now })
  const rereads = rereadCount({ view, anchor, position, now })
  const noteKey = editorKey(target)
  useEffect(() => {
    cacheNotes(session).set(
      noteKey,
      reread === null
        ? null
        : {
            short:
              rereads === null ? "re-reads the rest" : `re-reads ${rereads} ${rereads === 1 ? "message" : "messages"}`,
            text: reread
          }
    )
  }, [session, noteKey, reread, rereads])
  useEffect(() => () => cacheNotes(session).set(noteKey, null), [session, noteKey])
  // Below the last message, at the fork's tip: the composer's append, queued behind a reply
  // still being written as a send is (§4.2).
  const atEnd =
    anchor !== null &&
    view.newer === null &&
    view.entries.at(-1)?.slotId === anchor.slotId &&
    anchor.slotId === view.leafSlotId

  const close = (cancelled: boolean) => {
    openEditors(session).hide(target, cancelled)
    if (!cancelled) session.closeEditor(editor)
  }

  const submit = async (kind: "Write" | "Generate") => {
    setBusy(true)
    setError(null)
    try {
      const submitted = await editor.ready()
      const draft = submitted.draft ?? undefined
      let outcome: Outcome<unknown>
      let inserted: SlotId | null = null
      if (atEnd) {
        const source =
          draft === undefined
            ? undefined
            : { fork: target.forkId, draftId: draft.draftId, session: draft.session, text }
        const result =
          kind === "Write"
            ? (await session.send(submitted.text, speaker, null, source, false)).outcome
            : await session.generate(view.leafSlotId, speaker, submitted.text, source)
        outcome = result
        if (result.ok) {
          const value = result.value as { readonly _tag: string; readonly entry?: PathEntry }
          if (value._tag === "Posted" && value.entry) inserted = value.entry.slotId
        }
      } else {
        const body: InsertBody =
          kind === "Write"
            ? { _tag: "Write", speaker, content: submitted.text, ...(draft ? { draft } : {}) }
            : {
                _tag: "Generate",
                speaker,
                ...(submitted.text.trim() ? { direction: submitted.text } : {}),
                ...(draft ? { draft } : {})
              }
        const result = await session.insertMessage(anchor, body)
        outcome = result
        if (result.ok) inserted = result.value.entry.slotId
      }
      if (!outcome.ok) return setError(outcome.error)
      // Text typed while it was being inserted stays in the editor, which stays open.
      if (!editor.committed(submitted)) return
      // Inserted without naming its draft (it didn't hold exactly this text): it's ended unsaved.
      if (submitted.draft === null && submitted.text !== "") await editor.discard()
      close(false)
      if (inserted !== null) insertedToast(session, inserted, "Message inserted", target.forkId)
      else showToast({ title: "Queued: it posts when the reply being written ends" })
    } finally {
      setBusy(false)
    }
  }

  /** Closes it; text typed goes to the bin's recovered texts, as every message editor's Cancel does. */
  const cancel = async () => {
    if (text === "") return close(true)
    const outcome = await editor.discard()
    if (!outcome.ok) return setError(outcome.error)
    close(false)
  }

  const title =
    anchor === null
      ? "Insert above the first message"
      : `Insert below message #${(positionOf(anchor) + 1).toLocaleString()}`
  const shown = error ?? draftError
  const body = (
    <form
      aria-label={title}
      data-testid="insert-editor"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit("Write")
      }}
    >
      {!phone && <h3 className="text-sm font-semibold">{title}</h3>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Speaker</span>
        <SpeakerSwitcher
          speaker={speaker}
          recent={recentSpeakers(view.entries, 4).filter((id) => id !== speaker)}
          onPick={(card) => setPicked(card.entityId)}
        />
      </div>
      <label htmlFor={fieldId} className="sr-only">
        Message to insert, or a direction for Generate
      </label>
      {/* Framed as the composer's box is: the text box itself has no border. */}
      <div className="flex rounded-md border border-border bg-surface focus-within:ring-2 focus-within:ring-focus">
        <AutoGrowTextarea
          id={fieldId}
          data-testid="insert-text"
          autoFocus
          value={text}
          placeholder={`What ${name} says, or guidance for Generate…`}
          onChange={(event) => editor.setText(event.currentTarget.value)}
        />
      </div>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted" aria-label="What inserting here changes">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {shown && (
        <p role="alert" className="text-sm text-danger">
          {shown.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          hint={`The model writes ${name}'s message here; text you typed is its direction.`}
          onClick={() => void submit("Generate")}
        >
          <Icon name="regenerate" />
          Generate as {name}
        </Button>
        <Button type="submit" disabled={busy || text.trim() === ""} hint={`Adds your text here as ${name}'s message.`}>
          <Icon name="check" />
          Insert
        </Button>
        <Button
          type="button"
          disabled={busy}
          hint="Closes this without inserting; text you typed goes to the bin's recovered texts."
          onClick={() => void cancel()}
        >
          <Icon name="close" />
          Cancel
        </Button>
      </div>
    </form>
  )
  if (phone)
    return (
      <Sheet open onOpenChange={(open) => !open && void cancel()} title={title} closeLabel="Cancel">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
      </Sheet>
    )
  return <div className="mx-1 my-2 rounded-lg border border-accent/60 bg-surface-raised p-3">{body}</div>
}
