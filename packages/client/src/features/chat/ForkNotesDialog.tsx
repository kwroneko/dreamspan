import { canonicalJson } from "@rp/shared/editing.ts"
import type { ForkNote, ForkNoteSelection } from "@rp/shared/chatApi.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { AppError } from "../../errors.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { RevisionDiff } from "../../ui/RevisionDiff.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { flushOpenEditors, refreshOpenEditors } from "../editor/openEditors.ts"
import { forksChanged } from "./forks.ts"
import type { MessageActionProps } from "./messageActions.tsx"

const options = [
  { value: "then", label: "As it was then", description: "Its text and switch as they were at this message." },
  { value: "now", label: "As it is now", description: "Its text and switch as they are now, on the branch you're on." }
] as const
type Choice = "then" | "now"

/**
 * A note's choices. Unsaved text is the latest state (owner, 2026-11-02): "now" takes it to the
 * new branch, still unsaved, and "then" leaves it on the branch it was typed on.
 */
const noteOptions = (note: ForkNote) =>
  note.unsaved === undefined
    ? options
    : ([
        {
          value: "then",
          label: "As it was then",
          description: "Its text and switch as they were at this message. Your unsaved changes stay on this branch."
        },
        {
          value: "now",
          label: "As it is now",
          description: "Its text and switch as they are now, with your unsaved changes, which move to the new branch."
        }
      ] as const)

function NoteDiff({ note }: { note: ForkNote }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 text-sm text-muted">
        <span>Then · {note.then.enabled ? "On" : "Off"}</span>
        <span>
          Now · {note.now.enabled ? "On" : "Off"}
          {note.unsaved === undefined ? "" : " · unsaved changes"}
        </span>
      </div>
      <RevisionDiff
        before={note.then.content}
        after={note.unsaved ?? note.now.content}
        sideBySide
        beforeLabel="As it was then"
        afterLabel="As it is now"
      />
    </div>
  )
}

/** Registered by message.branch, replaceable together with its menu offer. */
export function ForkNotesDialog({ session, entry, report, closeDialog }: MessageActionProps) {
  const action = useAction()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { panel?: string }
  const [source] = useState(() => session.snapshot().forkId)
  const [notes, setNotes] = useState<ReadonlyArray<ForkNote> | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [buttons, setButtons] = useState(false)
  const [diff, setDiff] = useState<ForkNote | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const chooseAll = (choice: Choice) => setChoices(Object.fromEntries((notes ?? []).map((note) => [note.note, choice])))
  const all = notes?.every((note) => (choices[note.note] ?? "then") === "then")
    ? "then"
    : notes?.every((note) => choices[note.note] === "now")
      ? "now"
      : "mixed"
  const branch = async (reviewed = notes) => {
    if (reviewed === null || pending) return
    setPending(true)
    const selection: ForkNoteSelection = {
      comparison: canonicalJson(reviewed),
      choices: reviewed.map((note) => ({ note: note.note, choice: choices[note.note] ?? "then" }))
    }
    // Unnamed: a branch is named by where it splits off until the user names it (`forkLabel`).
    const made = await session.branchFrom(entry.slotId, selection, source)
    report(made)
    setPending(false)
    if (!made.ok) {
      setError(made.error)
      return
    }
    closeDialog()
    // The notes' unsaved text moved to the new branch: open editors read again.
    void refreshOpenEditors()
    // Back returns to the fork it came from, which is no longer the current one: the entry
    // left behind names it. (Rewritten in place: a navigation there would open it first.)
    // `source` is the fork the server resolved, so this holds when the URL named none too.
    if (source !== null) {
      const back = new URL(window.location.href)
      back.searchParams.set("fork", source)
      window.history.replaceState(window.history.state, "", back)
    }
    // The new one, now current, opens at the message it was made at, with the panel as it was.
    const panel = (search.panel === undefined ? {} : { panel: search.panel }) as { panel?: string }
    forksChanged(session.id, made.value.fork)
    void navigate({ to: ".", search: { ...panel, slot: entry.slotId } })
  }
  useEffect(() => {
    let live = true
    // What's typed in the notes reaches the server first: the branch takes it (carryDrafts.ts).
    void flushOpenEditors()
      .catch(() => undefined)
      .then(() =>
        action.run((client) =>
          client("PreviewForkNotes", {
            chatId: session.id,
            fromForkId: source,
            atSlotId: entry.slotId
          })
        )
      )
      .then((result) => {
        if (live && result.ok) {
          setNotes(result.value)
          if (result.value.length === 0) void branch(result.value)
        }
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the comparison belongs to this mounted dialog
  }, [session, source, entry.slotId])
  return (
    <>
      <Dialog
        open
        wide
        onOpenChange={(open) => !open && !pending && closeDialog()}
        title="Branch from here"
        description="Choose which notes this branch starts with: each as it was then, or as it is now."
      >
        <ErrorAlert error={error ?? action.error} />
        {notes === null ? (
          <p role="status" className="text-sm text-muted">
            Loading notes…
          </p>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted">No notes changed after this message.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">Set all notes{all === "mixed" ? " · Mixed choices" : ""}</span>
              <Segmented
                label="Set all notes"
                options={options}
                value={all}
                onValueChange={(choice) => {
                  if (choice !== "mixed") chooseAll(choice)
                }}
                wrap
              />
            </div>
            {import.meta.env.DEV && (
              <Switch checked={buttons} onCheckedChange={setButtons}>
                Development: open diffs with buttons
              </Switch>
            )}
            <div className="flex flex-col gap-3">
              {notes.map((note) => (
                <div key={note.note} className="min-w-0 rounded-md border border-border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">{note.title}</p>
                      <p className="text-xs text-muted">
                        {note.owner}
                        {note.unsaved === undefined ? "" : " · Unsaved changes"}
                      </p>
                    </div>
                    <Segmented
                      label={`Inherit ${note.title}`}
                      options={noteOptions(note)}
                      value={choices[note.note] ?? "then"}
                      onValueChange={(choice) => setChoices((current) => ({ ...current, [note.note]: choice }))}
                      wrap
                    />
                  </div>
                  <p className="mb-2 text-xs text-muted">
                    Then: {note.then.enabled ? "on" : "off"} · Now: {note.now.enabled ? "on" : "off"}
                  </p>
                  {buttons ? (
                    <Button onClick={() => setDiff(note)} hint="Compare the two versions side by side.">
                      Compare {note.title}
                    </Button>
                  ) : (
                    <details>
                      <Tooltip label="Compare the note then and now, side by side.">
                        <summary className="cursor-pointer text-sm text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">
                          Compare text and switches
                        </summary>
                      </Tooltip>
                      <div className="mt-3">
                        <NoteDiff note={note} />
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <DialogActions>
          <Button disabled={pending} onClick={closeDialog} hint="Closes this without making a branch.">
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={notes === null || action.pending}
            pending={pending}
            onClick={() => void branch()}
            hint="Make the branch with these notes and open it at this message."
          >
            Create branch
          </Button>
        </DialogActions>
      </Dialog>
      {diff && (
        <Dialog
          open
          wide
          onOpenChange={(open) => !open && setDiff(null)}
          title={diff.title}
          description="Compare the two versions before choosing what this branch inherits."
        >
          <NoteDiff note={diff} />
          <Segmented
            label={`Inherit ${diff.title}`}
            options={noteOptions(diff)}
            value={choices[diff.note] ?? "then"}
            onValueChange={(choice) => setChoices((current) => ({ ...current, [diff.note]: choice }))}
            wrap
          />
          <DialogActions>
            <Button onClick={() => setDiff(null)} hint="Back to the list of notes, keeping this choice.">
              Back to notes
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  )
}
