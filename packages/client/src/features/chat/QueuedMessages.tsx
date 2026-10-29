import { SlotOutlet } from "../../slots.tsx"
import { queuedPreviews } from "./presentation.tsx"
import type { QueuedMessage, MessageImages } from "@rp/shared/chat.ts"
import type { DraftState } from "@rp/shared/drafts.ts"
import { useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Textarea } from "../../ui/Field.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { nameOf, useCast } from "./cast.ts"
import type { MessageDraft } from "./messageDraft.ts"
import type { ChatSession } from "./session.ts"

function QueueEditor({
  editor,
  queued,
  session,
  onRecovered
}: {
  editor: MessageDraft
  queued: QueuedMessage | undefined
  session: ChatSession
  onRecovered: (text: string, images?: MessageImages) => void
}) {
  const view = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const [states, setStates] = useState<ReadonlyArray<DraftState> | null>(null)
  const [replace, setReplace] = useState<number | null>(null)
  const target = editor.target
  if (target._tag !== "Queue") return null
  const cancel = async () => {
    const result = await editor.discard()
    if (result.ok) session.closeEditor(editor)
    else setError(result.error)
  }
  return (
    <div className="flex flex-col gap-2">
      {!queued && (
        <p role="status" className="text-sm text-warning">
          This queued item posted or was withdrawn. Your unsent edit is kept here.
        </p>
      )}
      {replace !== null && (
        <p role="alert" className="text-sm text-warning">
          Changed in another tab. It now reads: {queued?.kind === "message" ? queued.content : queued?.direction}. Save
          again to replace it, or cancel to keep theirs.
        </p>
      )}
      {view.conflict && <ReplayNotice conflict={view.conflict} acknowledge={() => editor.acknowledgeConflict()} />}
      <Textarea
        aria-label="Queued message"
        value={view.text}
        onChange={(event) => editor.setText(event.currentTarget.value)}
      />
      <div className="flex flex-wrap gap-2">
        {queued ? (
          <Button
            variant="primary"
            onClick={async () => {
              const submitted = await editor.ready()
              if (submitted.draft === null) return
              const result = await session.editQueued(
                queued,
                submitted.text,
                {
                  rowVersion: replace ?? target.rowVersion,
                  speakerEntityId: queued.speakerEntityId
                },
                submitted.draft
              )
              if (result.ok) {
                if (editor.committed(submitted)) session.closeEditor(editor)
              } else if (result.error.tag === "StaleWrite") setReplace(queued.rowVersion)
              else setError(result.error)
            }}
          >
            Save
          </Button>
        ) : (
          <Button
            onClick={async () => {
              const submitted = await editor.ready()
              if (submitted.draft === null) return
              onRecovered(submitted.text)
              // The edit also remains in recovered texts, including its destructive-change history.
              await cancel()
            }}
          >
            Copy to composer
          </Button>
        )}
        <Button onClick={() => void cancel()}>Cancel</Button>
        <Button
          variant="ghost"
          onClick={async () => {
            const result = await editor.history()
            if (result.ok) setStates(result.value)
            else setError(result.error)
          }}
        >
          Earlier text of queued edit
        </Button>
      </div>
      {states && (
        <div className="flex max-h-40 flex-col overflow-y-auto" aria-label="Earlier queued text">
          {states.length <= 1 && <p className="text-sm text-muted">Nothing earlier yet.</p>}
          {states.slice(1).map((state) => (
            <Button
              key={state.seq}
              variant="ghost"
              onClick={async () => {
                await editor.restoreState(state.seq)
                setStates(null)
              }}
            >
              {state.length} characters · {state.removed || state.inserted || "Initial text"}
            </Button>
          ))}
        </div>
      )}
      {(error ?? view.error) && (
        <p role="alert" className="text-sm text-danger">
          {(error ?? view.error)?.message}
        </p>
      )}
    </div>
  )
}

export function QueuedMessages({
  queue,
  session,
  onRecovered
}: {
  queue: ReadonlyArray<QueuedMessage>
  session: ChatSession
  onRecovered: (text: string, images?: MessageImages) => void
}) {
  const editors = useSyncExternalStore(session.subscribeEditors, session.queueEditors)
  const cast = useCast()
  const ids = [
    ...new Set([
      ...queue.map((item) => item.id),
      ...editors.flatMap((editor) => (editor.target._tag === "Queue" ? [editor.target.queuedId] : []))
    ])
  ]
  if (ids.length === 0) return null
  return (
    <ul className="flex flex-col gap-2" aria-label="Queued messages">
      {ids.map((id) => {
        const queued = queue.find((item) => item.id === id)
        const editor = editors.find((item) => item.target._tag === "Queue" && item.target.queuedId === id)
        return (
          <li
            key={id}
            aria-label="Queued"
            className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-2"
          >
            {queued && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="warning">queued</Badge>
                <span className="text-muted">
                  {queued.kind === "message" ? "Posts as" : "Generates"} {nameOf(cast, queued.speakerEntityId) ?? "you"}{" "}
                  when the reply finishes
                </span>
              </div>
            )}
            {editor ? (
              <QueueEditor editor={editor} queued={queued} session={session} onRecovered={onRecovered} />
            ) : (
              queued && (
                <>
                  <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {queued.kind === "message" ? queued.content : queued.direction}
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const opened = session.openEditor(
                        { _tag: "Queue", chatId: session.id, queuedId: queued.id, rowVersion: queued.rowVersion },
                        queued.kind === "message" ? queued.content : (queued.direction ?? "")
                      )
                      opened.setText(opened.snapshot().text)
                    }}
                  >
                    Edit
                  </Button>
                </>
              )
            )}
            {queued && <SlotOutlet slot={queuedPreviews} props={{ queued }} />}
            {queued && <Withdraw queued={queued} session={session} onRecovered={onRecovered} />}
          </li>
        )
      })}
    </ul>
  )
}

function Withdraw({
  queued,
  session,
  onRecovered
}: {
  queued: QueuedMessage
  session: ChatSession
  onRecovered: (text: string, images?: MessageImages) => void
}) {
  const [error, setError] = useState<AppError | null>(null)
  return (
    <>
      <Button
        variant="ghost"
        onClick={async () => {
          const result = await session.withdrawQueued(queued)
          if (result.ok)
            onRecovered(
              result.value.kind === "message" ? result.value.content : (result.value.direction ?? ""),
              result.value.images
            )
          else setError(result.error)
        }}
      >
        Withdraw
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </>
  )
}
