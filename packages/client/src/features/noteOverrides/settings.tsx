// A note's Replaces control and its position switch (DESIGN §4.2; spec/NOTE-OVERRIDES.md §2.3),
// first in its settings, and "Copy its current text" in its ⋯ menu.
import { REPLACEABLE_CARD_FIELDS, type Placement, readNoteCondition } from "@dreamspan/shared/docs/note.ts"
import { valueField } from "@dreamspan/shared/editing.ts"
import { Predicate } from "effect"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { MenuItem } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { FieldTools } from "../editor/controls.tsx"
import {
  CARD_FIELD_LABELS,
  type FieldTarget,
  noteTarget,
  storedTarget,
  targetKey,
  targetLabel,
  useNoteTargetNames
} from "../editor/noteTargets.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { type EditorStore, useEditorState, useValue } from "../editor/store.ts"
import {
  otherReplacing,
  type ReplaceChat,
  useCardRef,
  useChatNotes,
  usePresetPrompts,
  useReplaceChat
} from "./chat.tsx"
import { unlinkNote } from "./unlink.ts"

const NOTHING = "none"

/** The note's owning card, for a card's note. */
const useOwnerCard = (store: EditorStore) => {
  const owner = useValue<unknown>(store, ["owner"])
  return Predicate.isObject(owner) && Predicate.isString(owner["card"]) ? owner["card"] : null
}

/** The note's target as it's set now (typed, not saved, included). */
const useTarget = (store: EditorStore) => {
  const replaces = useValue<unknown>(store, ["replaces"])
  const owner = useValue<unknown>(store, ["owner"])
  return noteTarget({ replaces, owner })
}

export function ReplacesSetting({
  store,
  cards
}: {
  store: EditorStore
  cards: ReadonlyArray<{ readonly entity: string; readonly name: string }>
}) {
  const chat = useReplaceChat()
  // A shared note's text has no place of its own; only a chat's or a card's note replaces.
  const owner = useValue<unknown>(store, ["owner"])
  if (Predicate.isObject(owner) && owner["shared"] !== undefined) return null
  return <Replaces store={store} cards={cards} chat={chat} />
}

function Replaces({
  store,
  cards,
  chat
}: {
  store: EditorStore
  cards: ReadonlyArray<{ readonly entity: string; readonly name: string }>
  chat: ReplaceChat | null
}) {
  const workspace = usePresetWorkspace()
  const names = useNoteTargetNames()
  const ownerCard = useOwnerCard(store)
  const target = useTarget(store)
  const ownPosition = useValue<unknown>(store, ["own_position"]) === true
  const condition = readNoteCondition(useValue<unknown>(store, ["condition"]))
  const prompts = usePresetPrompts(chat, true)
  const notes = useChatNotes(chat)
  const cardRef = useCardRef()
  const self = useEditorState(store).snapshot?.ref.id
  const [conflict, setConflict] = useState<{ target: FieldTarget; others: ReturnType<typeof otherReplacing> } | null>(
    null
  )
  const nameOf = (entity: string) => names?.card(entity) ?? cards.find((c) => c.entity === entity)?.name
  // A card's note replaces the preset's prompts or its own card's fields; a chat's, any cast card's.
  const fieldCards = ownerCard !== null ? [ownerCard] : cards.map((c) => c.entity)
  const choices: Array<{ target: FieldTarget; label: string; description: string }> = [
    ...(prompts ?? []).map((p) => ({
      target: { kind: "preset_prompt", identifier: p.identifier } as const,
      label: p.name,
      description:
        p.forbidden && ownerCard !== null
          ? "A prompt of the preset that a card can't replace."
          : "A prompt of the chat's preset."
    })),
    ...fieldCards.flatMap((entity) =>
      (chat?.cast.cards.get(entity)?.persona ? (["description"] as const) : REPLACEABLE_CARD_FIELDS).map((field) => ({
        target: { kind: "card_field", card: entity, field } as const,
        label: `${nameOf(entity) ?? "This card"}'s ${CARD_FIELD_LABELS[field]}`,
        description: "A field of the card, in this chat."
      }))
    )
  ]
  const current = target === null ? null : choices.find((c) => targetKey(c.target) === targetKey(target))
  const prompt = target?.kind === "preset_prompt" ? prompts?.find((p) => p.identifier === target.identifier) : undefined
  const missing = target?.kind === "preset_prompt" && prompts !== null && prompt === undefined
  const items = [
    { value: NOTHING, label: "Nothing", description: "It's sent at its own position, as any note." },
    ...choices.map((c) => ({ value: targetKey(c.target), label: c.label, description: c.description })),
    ...(target !== null && !current
      ? [
          {
            value: targetKey(target),
            label: missing ? "A prompt not in this preset" : targetLabel(target, names, nameOf),
            description: "What it replaces now."
          }
        ]
      : [])
  ]
  const set = (next: FieldTarget | null) => {
    setConflict(null)
    if (next === null) {
      store.setValue(["replaces"], undefined)
      store.setValue(["own_position"], undefined)
      return
    }
    store.setValue(["replaces"], storedTarget(next, ownerCard))
  }
  const choose = (key: string) => {
    if (key === NOTHING) return set(null)
    const next = choices.find((c) => targetKey(c.target) === key)?.target
    if (!next) return
    const others = otherReplacing(notes, next, self)
    if (others.length > 0) setConflict({ target: next, others })
    else set(next)
  }
  /** Its own position, prefilled with the prompt's where that applies (a depth and role). */
  const placeOwn = (own: boolean) => {
    store.setValue(["own_position"], own || undefined)
    if (!own || !prompt) return
    const now = store.value(["placement"]) as Placement | undefined
    const placement: Placement | null =
      prompt.depth !== null
        ? { mode: "depth", depth: prompt.depth, role: prompt.role }
        : now && now.mode !== "none"
          ? { ...now, role: prompt.role }
          : null
    if (placement) store.setValue(["placement"], placement)
  }
  const open = () => {
    if (!workspace || !target) return
    if (target.kind === "preset_prompt") {
      if (chat?.presetRef) workspace.open(chat.presetRef, target.identifier)
    } else {
      const ref = cardRef(target.card)
      if (ref) workspace.open(ref)
    }
  }
  const what = target === null ? null : targetLabel(target, names, nameOf)
  const prefixed = target !== null && (target.kind === "card_field" || prompt?.aboveHistory === true)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-52 flex-[3]">
          <Field
            label="Replaces"
            about="A prompt of the preset or a field of a card. While this note is on, it's sent in that one's place; empty, that one is left out."
          >
            <Select items={items} value={target === null ? NOTHING : targetKey(target)} onValueChange={choose} />
          </Field>
        </div>
        <IconButton
          label={what ? `Open ${what}` : "Open what it replaces"}
          hint={
            !target
              ? "This note doesn't replace anything."
              : !workspace || !chat
                ? "Open it from a chat to see what it replaces."
                : `Opens ${what} in its editor.`
          }
          icon="external"
          disabled={!target || !workspace || !chat}
          onClick={open}
        />
        <div className="flex min-h-9 items-center">
          <Switch
            checked={ownPosition}
            disabled={target === null}
            onCheckedChange={placeOwn}
            hint={
              target === null
                ? "Choose what it replaces first."
                : ownPosition
                  ? "Click to send it where the prompt it replaces goes."
                  : "Click to send it at its own position below; the prompt it replaces is left out."
            }
          >
            Its own position
          </Switch>
        </div>
      </div>
      {conflict && (
        <Alert
          tone="danger"
          title={`Only one note can replace ${targetLabel(conflict.target, names, nameOf)}`}
          actions={
            <Button
              hint="Stops the other note replacing it, and makes this one replace it."
              onClick={() => {
                const { target: next, others } = conflict
                if (!workspace || !chat) return
                void Promise.all(others.map((note) => unlinkNote(workspace, chat, note))).then(() => set(next))
              }}
            >
              Unlink {others(conflict.others)}
            </Button>
          }
        >
          {conflict.others.length > 1 ? "The notes " : "The note "}
          {others(conflict.others)} {conflict.others.length > 1 ? "replace" : "replaces"} it in this chat now.
        </Alert>
      )}
      {missing && (
        <p role="status" className="text-sm text-warning">
          Its prompt isn't in the selected preset. Pick another one to replace
          {ownPosition ? "; it's still sent at its own position." : ", or switch on Its own position."}
        </p>
      )}
      {prompt?.forbidden && ownerCard !== null && (
        <p role="status" className="text-sm text-warning">
          The preset doesn't let a card replace this prompt, so this note isn't sent in its place.
        </p>
      )}
      {prefixed && !ownPosition && condition.when !== "always" && (
        <p role="status" className="text-sm text-warning">
          In a place above the history, it rewrites the cached part of the context whenever its condition changes.
        </p>
      )}
      <div className="empty:hidden">
        <FieldTools store={store} field={valueField(["replaces"])} label="Replaces" />
      </div>
    </div>
  )
}

const others = (notes: ReturnType<typeof otherReplacing>) =>
  notes.map((note) => (note.doc["title"] as string | undefined) || note.ref.label).join(", ")

/** "Copy its current text": the text of what it replaces, as it is now, into the note. */
export function CopyCurrentText({ store }: { store: EditorStore; title: string }) {
  const chat = useReplaceChat()
  const workspace = usePresetWorkspace()
  const names = useNoteTargetNames()
  const target = useTarget(store)
  const cardRef = useCardRef()
  const self = useEditorState(store).snapshot?.ref.id
  if (!chat || !workspace) return null
  // The card that fills the place now, as assembly resolved it (a fork for this chat, say).
  const resolved = workspace.context?.replacements?.find((r) => r.note === self)?.target ?? target
  const what = target === null ? null : targetLabel(target, names)
  const copy = async () => {
    if (!resolved) return
    const source =
      resolved.kind === "preset_prompt"
        ? chat.presetStore()
        : (() => {
            const ref = cardRef(resolved.card)
            return ref ? workspace.store(ref) : null
          })()
    if (!source) return
    if (source.snapshot === null) await source.load()
    const text =
      resolved.kind === "preset_prompt"
        ? source.text(["prompts", `identifier=${resolved.identifier}`, "content"])
        : source.text([resolved.field])
    store.setText(["content"], text)
  }
  return (
    <MenuItem
      icon="copy"
      disabled={target === null}
      description={
        what === null
          ? "This note doesn't replace a prompt."
          : `Puts the current text of ${what} in this note, in place of the note's text.`
      }
      onClick={() => void copy()}
    >
      Copy its current text
    </MenuItem>
  )
}
