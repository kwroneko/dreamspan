// The card editor: every card field, the card's modules and its notes (DESIGN §4.1, §4.1a).
import type { CardModule } from "@rp/shared/docs/card.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { NoteEntry } from "@rp/shared/editorApi.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { FieldTools, RestoredNotice, SwitchField, TextField } from "./controls.tsx"
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

const placeOf = (placement: Placement): Place =>
  placement.mode === "section" ? `section:${placement.section}` : placement.mode

/**
 * Where a note or module goes, saved whole as one value; a module without one is with the
 * card's definition. Fields of the placement this editor doesn't show stay as they are.
 */
function PlacementField({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const placement = useValue<Placement | undefined>(store, path) ?? { mode: "section", section: "card" }
  const [depth, setDepth] = useState<string | null>(null)
  const role: Role = placement.mode === "depth" || placement.mode === "tail" ? placement.role : "system"
  const set = (place: Place, change: { depth?: number; role?: Role } = {}) => {
    const nextRole = change.role ?? role
    const nextDepth = change.depth ?? (placement.mode === "depth" ? placement.depth : 4)
    const next: Placement = place.startsWith("section:")
      ? { mode: "section", section: place.slice("section:".length) as Section }
      : place === "tail"
        ? { mode: "tail", role: nextRole }
        : place === "depth"
          ? { mode: "depth", depth: nextDepth, role: nextRole }
          : { mode: "none" }
    store.setValue(path, next)
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={label}>
          <Select items={PLACES} value={placeOf(placement)} onValueChange={(place) => set(place)} />
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
        {(placement.mode === "depth" || placement.mode === "tail") && (
          <Field label="Role">
            <Select items={ROLES} value={role} onValueChange={(next) => set(placement.mode as Place, { role: next })} />
          </Field>
        )}
      </div>
      <FieldTools store={store} field={valueField(path)} label={label} />
    </div>
  )
}

function Avatar({ store, onUpload }: { store: EditorStore; onUpload: (file: File) => void }) {
  const media = useValue<string | null>(store, ["avatar_media_id"])
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {media ? (
        <img
          src={`/library/media?id=${encodeURIComponent(media)}`}
          alt="The card's avatar"
          className="size-24 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <div className="flex size-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted">
          No avatar
        </div>
      )}
      <div className="min-w-0 flex-1">
        <FileDrop
          label="Choose an avatar, or drop it here"
          description="PNG, JPEG, GIF or WebP, up to 16 MB. It's saved as a revision of its own."
          accept="image/png,image/jpeg,image/gif,image/webp"
          onFiles={(files) => files[0] && onUpload(files[0])}
        />
      </div>
    </div>
  )
}

function Greetings({ store }: { store: EditorStore }) {
  const path = ["alternate_greetings"]
  const greetings = useValue<ReadonlyArray<string>>(store, path) ?? []
  return (
    <div className="flex flex-col gap-3">
      {greetings.map((greeting, index) => (
        <div key={index} className="flex flex-col gap-1">
          <Field label={`Alternate greeting ${index + 1}`}>
            <Textarea
              rows={4}
              className="resize-y"
              value={greeting}
              onChange={(event) => store.setValue(path, greetings.with(index, event.currentTarget.value))}
            />
          </Field>
          <div>
            <Button
              variant="ghost"
              onClick={() => store.setValue(path, greetings.toSpliced(index, 1))}
              aria-label={`Remove alternate greeting ${index + 1}`}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => store.setValue(path, [...greetings, ""])}>Add a greeting</Button>
      </div>
      <FieldTools store={store} field={valueField(path)} label="Alternate greetings" />
    </div>
  )
}

function Tags({ store }: { store: EditorStore }) {
  const path = ["tags"]
  const tags = useValue<ReadonlyArray<string>>(store, path) ?? []
  const [tag, setTag] = useState("")
  const add = () => {
    const trimmed = tag.trim()
    if (trimmed !== "" && !tags.includes(trimmed)) store.setValue(path, [...tags, trimmed])
    setTag("")
  }
  return (
    <Fieldset legend="Tags">
      <ul aria-label="Tags" className="flex flex-wrap gap-2">
        {tags.map((name) => (
          <li key={name} className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-3 text-sm">
            {name}
            <button
              type="button"
              aria-label={`Remove the tag ${name}`}
              className="rounded-full px-1.5 text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() =>
                store.setValue(
                  path,
                  tags.filter((other) => other !== name)
                )
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Field label={<span className="sr-only">New tag</span>} className="flex-1">
          <Input
            value={tag}
            placeholder="A tag"
            onChange={(event) => setTag(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                add()
              }
            }}
          />
        </Field>
        <Button onClick={add}>Add the tag</Button>
      </div>
      <FieldTools store={store} field={valueField(path)} label="Tags" />
    </Fieldset>
  )
}

function Modules({ store }: { store: EditorStore }) {
  const modules = useValue<ReadonlyArray<CardModule>>(store, ["modules"]) ?? []
  const add = () => {
    const id = uuidv7()
    store.setValue(["modules", `id=${id}`], { id, title: "New module", content: "", exportable: true })
  }
  return (
    <div className="flex flex-col gap-4">
      {modules.length === 0 && (
        <EmptyState title="No modules">
          <p>Modules are extra prompts that travel with the card: outfits, situations, private notes.</p>
        </EmptyState>
      )}
      {modules.map((module) => {
        const at = ["modules", `id=${module.id}`]
        return (
          <section
            key={module.id}
            aria-label={`Module ${module.title}`}
            className="flex flex-col gap-3 rounded-md border border-border p-3"
          >
            <TextField store={store} path={[...at, "title"]} label="Title" />
            <TextField store={store} path={[...at, "content"]} label="Content" rows={5} />
            <PlacementField store={store} path={[...at, "placement"]} label="Placement" />
            <SwitchField
              store={store}
              path={[...at, "exportable"]}
              label="Exported with the card"
              description="A private module never leaves in an export."
            />
            <SwitchField
              store={store}
              path={[...at, "agent_editable"]}
              label="The agent may edit it"
              description="Kept for agents, which aren't built yet. A file never turns this on."
            />
            <div>
              <Button variant="ghost" onClick={() => void store.removeItem(at)}>
                Remove the module
              </Button>
            </div>
          </section>
        )
      })}
      <div>
        <Button onClick={add}>Add a module</Button>
      </div>
    </div>
  )
}

/** A note's fields, in the card editor or on the note's own page. */
export function NoteFields({ store }: { store: EditorStore }) {
  return (
    <div className="flex flex-col gap-3">
      <TextField store={store} path={["title"]} label="Title" />
      <TextField store={store} path={["content"]} label="Content" rows={4} />
      <PlacementField store={store} path={["placement"]} label="Placement" />
      <SwitchField store={store} path={["exportable"]} label="Exported with the card" />
      <SwitchField
        store={store}
        path={["agent_editable"]}
        label="The agent may edit it"
        description="Kept for agents, which aren't built yet. A file never turns this on."
      />
    </div>
  )
}

/** One of the card's notes: an entity of its own, saved on its own. */
function NoteEditor({ entry, call, onDeleted }: { entry: NoteEntry; call: Caller; onDeleted: () => void }) {
  const [store] = useState(() => new EditorStore(entry.ref.id, call))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const state = useEditorState(store)
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.snapshot === null) return <p className="text-sm text-muted">Loading the note…</p>
  const remove = async () => {
    const result = await call((client) => client("DeleteCardNote", { noteRefId: entry.ref.id }), ["library"])
    if (result.ok) onDeleted()
    else setError(result.error)
  }
  const dirty = state.dirty > 0
  return (
    <section aria-label={`Note ${entry.ref.label}`} className="flex flex-col gap-3 rounded-md border border-border p-3">
      <RestoredNotice count={state.restored} />
      <NoteFields store={store} />
      <ErrorAlert error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!dirty} onClick={() => setSaving(true)}>
          Save the note
        </Button>
        <Button variant="ghost" onClick={() => void remove()}>
          Delete the note
        </Button>
        {dirty && <Badge tone="accent">unsaved changes</Badge>}
      </div>
      {saving && <SaveDialog store={store} onClose={() => setSaving(false)} onSaved={() => setSaving(false)} />}
    </section>
  )
}

function Notes({ store, call }: { store: EditorStore; call: Caller }) {
  const [notes, setNotes] = useState<ReadonlyArray<NoteEntry> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    void call((client) => client("ListCardNotes", { cardRefId: store.refId })).then((result) =>
      result.ok ? setNotes(result.value) : setError(result.error)
    )
  }, [call, store, version])
  const add = async () => {
    const result = await call(
      (client) => client("CreateCardNote", { cardRefId: store.refId, title: "Note" }),
      ["library"]
    )
    if (result.ok) setVersion(version + 1)
    else setError(result.error)
  }
  return (
    <div className="flex flex-col gap-4">
      <ErrorAlert error={error} />
      {notes?.length === 0 && (
        <EmptyState title="No notes">
          <p>Notes go into the chat where you place them, like ST's Character's Note, and you can have several.</p>
        </EmptyState>
      )}
      {notes?.map((entry) => (
        <NoteEditor key={entry.ref.id} entry={entry} call={call} onDeleted={() => setVersion(version + 1)} />
      ))}
      <div>
        <Button onClick={() => void add()}>Add a note</Button>
      </div>
    </div>
  )
}

export function CardEditor({
  store,
  call,
  onUpload
}: {
  store: EditorStore
  call: Caller
  onUpload: (file: File) => void
}) {
  return (
    <>
      <Card>
        <CardHeader title="Identity" />
        <div className="flex flex-col gap-4">
          <Avatar store={store} onUpload={onUpload} />
          <TextField store={store} path={["name"]} label="Name" description="What {{char}} becomes in chats." />
        </div>
      </Card>
      <Card>
        <CardHeader title="Definition" />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["description"]} label="Description" rows={12} />
          <TextField store={store} path={["personality"]} label="Personality" rows={4} />
          <TextField store={store} path={["scenario"]} label="Scenario" rows={4} />
          <TextField store={store} path={["mes_example"]} label="Example messages" rows={6} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Greetings" />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["first_mes"]} label="First message" rows={6} />
          <Greetings store={store} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Prompts" description="The card's own prompts, used where the preset allows them." />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["system_prompt"]} label="System prompt" rows={4} />
          <TextField store={store} path={["post_history_instructions"]} label="Post-history instructions" rows={4} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Modules" description="Extra prompts that travel with the card (saved with the card)." />
        <Modules store={store} />
      </Card>
      <Card>
        <CardHeader
          title="Notes"
          description="Each note is saved on its own, and can be placed anywhere in the chat."
        />
        <Notes store={store} call={call} />
      </Card>
      <Card>
        <CardHeader title="About" />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["creator_notes"]} label="Creator's notes" rows={4} />
          <Tags store={store} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField store={store} path={["creator"]} label="Creator" />
            <TextField store={store} path={["character_version"]} label="Character version" />
          </div>
        </div>
      </Card>
    </>
  )
}
