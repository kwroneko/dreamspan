// Notes (DESIGN §4.1) and where notes and card modules go: a note's fields and its editor,
// used by the card editor, a note's own page and a chat's notes.
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { BinItem } from "@rp/shared/bin.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { browserEnv } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { FieldTools, NumberField, RecoveredNotice, RestoredNotice, SwitchField, TextField } from "./controls.tsx"
import { SaveDialog } from "./SaveDialog.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useValue } from "./store.ts"

const ROLES = [
  { value: "system", label: "System" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" }
] as const

type Role = (typeof ROLES)[number]["value"]

type Section = Extract<Placement, { mode: "section" }>["section"]

/** Where a note or module can go: the placement's mode, or a section by name. */
const PLACES = [
  { value: "depth", label: "In the chat, at a depth" },
  { value: "tail", label: "At the end of the chat" },
  { value: "section:card", label: "With the card's definition" },
  { value: "section:before_main_prompt", label: "Before the main prompt" },
  { value: "section:after_main_prompt", label: "After the main prompt" },
  { value: "section:author_note_top", label: "At the top of the author's note" },
  { value: "section:author_note_bottom", label: "At the bottom of the author's note" },
  { value: "none", label: "Not placed: only a macro reads it" }
] as const

type Place = (typeof PLACES)[number]["value"]

/** Where a chat's own note can go: the places ST puts its author's note, and nowhere. */
const CHAT_PLACES: ReadonlyArray<Place> = [
  "depth",
  "tail",
  "section:before_main_prompt",
  "section:after_main_prompt",
  "none"
]

const placeOf = (placement: Placement): Place =>
  placement.mode === "section" ? `section:${placement.section}` : placement.mode

/**
 * Where a note or module goes, saved whole as one value; a module without one is with the
 * card's definition. Fields of the placement this editor doesn't show stay as they are.
 */
export function PlacementField({
  store,
  path,
  label,
  places
}: {
  store: EditorStore
  path: FieldPath
  label: string
  places?: ReadonlyArray<Place>
}) {
  const placement = useValue<Placement | undefined>(store, path) ?? { mode: "section", section: "card" }
  const [depth, setDepth] = useState<string | null>(null)
  const role: Role = placement.mode === "none" ? "system" : (placement.role ?? "system")
  const set = (place: Place, change: { depth?: number; role?: Role } = {}) => {
    const nextRole = change.role ?? role
    const nextDepth = change.depth ?? (placement.mode === "depth" ? placement.depth : 4)
    const next: Placement = place.startsWith("section:")
      ? { mode: "section", section: place.slice("section:".length) as Section, role: nextRole }
      : place === "tail"
        ? { mode: "tail", role: nextRole }
        : place === "depth"
          ? { mode: "depth", depth: nextDepth, role: nextRole }
          : { mode: "none" }
    store.setValue(path, next)
  }
  // A place this list leaves out still shows, when the note is there already.
  const items = places ? PLACES.filter((p) => places.includes(p.value) || p.value === placeOf(placement)) : PLACES
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={label}>
          <Select items={items} value={placeOf(placement)} onValueChange={(place) => set(place)} />
        </Field>
        {placement.mode === "depth" && (
          <Field label="Depth" description="Messages from the end.">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              value={depth ?? String(placement.depth)}
              onChange={(event) => {
                const text = event.currentTarget.value
                setDepth(text)
                const number = Number(text)
                if (text !== "" && Number.isInteger(number) && number >= 0 && number <= 10000) {
                  set("depth", { depth: number })
                }
              }}
              onBlur={() => setDepth(null)}
            />
          </Field>
        )}
        {(placement.mode === "depth" || placement.mode === "tail" || placement.mode === "section") && (
          <Field label="Role">
            <Select items={ROLES} value={role} onValueChange={(next) => set(placeOf(placement), { role: next })} />
          </Field>
        )}
      </div>
      <FieldTools store={store} field={valueField(path)} label={label} />
    </div>
  )
}

/**
 * A note's fields, wherever it's edited. A chat's own note goes where ST's author's note can,
 * every so many of the user's messages; a card's travels with the card.
 */
export function NoteFields({ store }: { store: EditorStore }) {
  const owner = useValue<{ chat?: string } | undefined>(store, ["owner"])
  const chat = owner?.chat !== undefined
  return (
    <div className="flex flex-col gap-3">
      <TextField store={store} path={["title"]} label="Title" />
      <TextField store={store} path={["content"]} label="Content" rows={4} />
      <PlacementField store={store} path={["placement"]} label="Placement" {...(chat ? { places: CHAT_PLACES } : {})} />
      {chat ? (
        <NumberField
          store={store}
          path={["interval"]}
          label="Every how many of your messages (empty or 1: every time; 0: never)"
          integer
          optional
          min={0}
          step="1"
        />
      ) : (
        <SwitchField store={store} path={["exportable"]} label="Exported with the card" />
      )}
      <SwitchField
        store={store}
        path={["agent_editable"]}
        label="The agent may edit it"
        description="Kept for agents, which aren't built yet. A file never turns this on."
      />
    </div>
  )
}

/** A note: an entity of its own, saved on its own; deleting it is up to `onDeleted`'s owner. */
export function NoteEditor({
  noteRef,
  call,
  onDeleted,
  notice,
  chatNote
}: {
  noteRef: LibraryRef
  call: Caller
  /** Without it, the note can't be deleted from here. */
  onDeleted?: (item: BinItem) => void
  /** Said above the fields. */
  notice?: ReactNode
  chatNote?: ChatNotePosition
}) {
  const userId = useSession().user.id
  const [store] = useState(() => new EditorStore(noteRef.id, userId, call, browserEnv, chatNote))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const state = useEditorState(store)
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.snapshot === null) return <p className="text-sm text-muted">Loading the note…</p>
  const remove = async () => {
    // What's typed goes with the note to the bin, and comes back with it. A change that can't
    // reach the server stays in this browser until the note can be opened again.
    await store.flush()
    const result = await call((client) => client("DeleteNote", { noteRefId: noteRef.id }), ["library"])
    if (result.ok) onDeleted?.(result.value)
    else setError(result.error)
  }
  const dirty = state.dirty > 0
  return (
    <section aria-label={`Note ${noteRef.label}`} className="flex flex-col gap-3 rounded-md border border-border p-3">
      {notice}
      <RestoredNotice count={state.restored} />
      <RecoveredNotice count={state.recovered} />
      <NoteFields store={store} />
      <ErrorAlert error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!dirty} onClick={() => setSaving(true)}>
          Save the note
        </Button>
        {onDeleted && (
          <Button variant="ghost" onClick={() => void remove()}>
            Delete the note
          </Button>
        )}
        {dirty && <Badge tone="accent">unsaved changes</Badge>}
      </div>
      {saving && <SaveDialog store={store} onClose={() => setSaving(false)} onSaved={() => setSaving(false)} />}
    </section>
  )
}
