// The card editor: every card field and the card's notes (DESIGN §4.1, §4.1a). Card modules
// are card notes (§5.0).
import { SlotOutlet } from "../../slots.tsx"
import { cardEditorSections } from "./cardSections.ts"
import { valueField } from "@rp/shared/editing.ts"
import type { NoteEntry, SharedNote } from "@rp/shared/editorApi.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import { Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { FieldTools, TextField } from "./controls.tsx"
import { AddNoteMenu, SharedNotePicker } from "./notes.tsx"
import { NoteList, NoteListControls, useNoteBlocks } from "./NoteList.tsx"
import { type EditorStore, useEditorState, useValue } from "./store.ts"
import { CardTextEditor } from "./CardTextEditor.tsx"
import { PromptUseNote } from "./PromptUseNote.tsx"
import { EditorPortrait } from "./PortraitControls.tsx"

function Greetings({ store }: { store: EditorStore }) {
  const path = ["alternate_greetings"]
  const greetings = useValue<ReadonlyArray<string>>(store, path) ?? []
  return (
    <div className="flex flex-col gap-3">
      {greetings.map((greeting, index) => (
        <div key={index} className="flex flex-col gap-1">
          <Field label={`Alternate greeting ${index + 1}`}>
            <CardTextEditor
              store={store}
              field={valueField(path)}
              path={[...path, index]}
              label={`Alternate greeting ${index + 1}`}
              rows={4}
              value={greeting}
              onChange={(value) => store.setValue(path, greetings.with(index, value))}
              onBlur={() => void store.save(valueField(path))}
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

/** The card's notes (DESIGN §4.1), each collapsed to a row: they travel with the card to every chat. */
function Notes({ store, call }: { store: EditorStore; call: Caller }) {
  const [notes, setNotes] = useState<ReadonlyArray<NoteEntry> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [version, setVersion] = useState(0)
  const [picking, setPicking] = useState(false)
  const { blocks, settings } = useNoteBlocks(notes?.length ?? 0)
  const name = useValue<string>(store, ["name"]) || "This card"
  const entity = useEditorState(store).snapshot?.ref.entityId
  useEffect(() => {
    void call((client) => client("ListCardNotes", { cardRefId: store.refId })).then((result) =>
      result.ok ? setNotes(result.value) : setError(result.error)
    )
  }, [call, store, version])
  const add = async (shared?: SharedNote) => {
    const link = shared ? { link: shared.ref.entityId } : {}
    const result = await call(
      (client) => client("CreateCardNote", { cardRefId: store.refId, title: "Note", ...link }),
      ["library"]
    )
    if (!result.ok) return setError(result.error)
    blocks.setOpen(result.value.id, true)
    setVersion(version + 1)
  }
  // A card's notes can only be conditioned on the card itself here; a chat offers its cast.
  const cards = entity ? [{ entity, name }] : []
  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />
      {notes?.length === 0 && (
        <EmptyState title="No notes">
          <p>
            Notes travel with the card: outfits, situations, private notes. Each is switched on in the chats that use
            it, or on in every chat.
          </p>
        </EmptyState>
      )}
      {notes && notes.length > 0 && (
        <>
          <NoteListControls ids={notes.map((entry) => entry.ref.id)} blocks={blocks} />
          <NoteList
            label="The card's notes"
            entries={notes.map((entry) => ({
              ref: entry.ref,
              doc: entry.doc,
              generation: version,
              onDeleted: () => setVersion(version + 1)
            }))}
            cards={cards}
            call={call}
            blocks={blocks}
            settings={settings}
            onRelinked={() => setVersion(version + 1)}
          />
        </>
      )}
      <div>
        <AddNoteMenu onNew={() => void add()} onPick={() => setPicking(true)} />
      </div>
      <SharedNotePicker
        open={picking}
        onOpenChange={setPicking}
        call={call}
        onPick={(note) => {
          setPicking(false)
          void add(note)
        }}
      />
    </div>
  )
}

export function CardEditor({ store, call }: { store: EditorStore; call: Caller }) {
  return (
    <>
      <Card>
        <CardHeader title="Identity" />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["name"]} label="Display name" />
          <TextField
            store={store}
            path={["nickname"]}
            label="Name the model sees (leave empty to use the display name)"
          />
          <TextField store={store} path={["character_version"]} label="Version (shown as subtitle)" />
          <EditorPortrait store={store} call={call} />
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
          <div className="flex flex-col gap-1">
            <TextField store={store} path={["system_prompt"]} label="System prompt" rows={4} />
            <PromptUseNote store={store} call={call} field="system_prompt" />
          </div>
          <div className="flex flex-col gap-1">
            <TextField store={store} path={["post_history_instructions"]} label="Post-history instructions" rows={4} />
            <PromptUseNote store={store} call={call} field="post_history_instructions" />
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Notes"
          description="Each note is saved on its own, and goes where it says in the chats it's on in."
        />
        <Notes store={store} call={call} />
      </Card>
      <SlotOutlet slot={cardEditorSections} props={{ store, call }} />
      <Card>
        <CardHeader title="About" />
        <div className="flex flex-col gap-4">
          <TextField store={store} path={["creator_notes"]} label="Creator's notes" rows={4} />
          <Tags store={store} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField store={store} path={["creator"]} label="Creator" />
          </div>
        </div>
      </Card>
    </>
  )
}
