import { textActions } from "../../textActions.tsx"
// Notes (DESIGN §4.1): a note's settings and fields, how its header says them, and the picker of
// shared named notes, used by the card editor, a note's own page and a chat's notes.
import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import { anyOf, conditionCards, type NoteCondition, type Placement, readNoteCondition } from "@rp/shared/docs/note.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { ChatNotePosition, SharedNote } from "@rp/shared/editorApi.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { MultiSelect } from "../../ui/MultiSelect.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { FieldTools, SwitchField, TextField } from "./controls.tsx"
import { type EditorStore, useEditorState, useValue } from "./store.ts"

/** A card a note's condition can name: the chat's cast, or in the card editor the card itself. */
export interface NoteCard {
  readonly entity: string
  readonly name: string
}

const ROLES = [
  {
    value: "system",
    label: "System",
    description: "Sent as a system message: an instruction, from no one in the story."
  },
  { value: "user", label: "User", description: "Sent as a user message, as if you had written it." },
  {
    value: "assistant",
    label: "Assistant",
    description: "Sent as an assistant message, as if the model had written it."
  }
] as const

type Role = (typeof ROLES)[number]["value"]

type Section = Extract<Placement, { mode: "section" }>["section"]

/**
 * Where a note goes: the five places relative to the preset's own sections (DESIGN §4.1),
 * then older and imported places, which show only on a note already there. The tail is what
 * the preset sends after the chat history.
 */
const PLACES = [
  {
    value: "section:context_start",
    label: "Start of context",
    description: "The very first thing sent, before everything in the preset."
  },
  {
    value: "section:after_main_prompt",
    label: "With the definitions",
    description: "Right after the preset's main prompt."
  },
  {
    value: "depth",
    label: "In the history",
    description: "Among the chat's messages, the depth you set back from the newest. At 0 it follows the newest."
  },
  {
    value: "section:tail_start",
    label: "Start of the tail",
    description: "Right after the chat history and the newest message, before the preset's prompts that follow."
  },
  {
    value: "section:tail_end",
    label: "End of the tail",
    description:
      "Last of the preset's prompts after the history: only the closing instruction, and the newest message if the preset puts it last, follow."
  },
  {
    value: "tail",
    label: "After the newest message",
    description: "An older place: in the history at depth 0. Pick another to move it."
  },
  {
    value: "section:card",
    label: "Beside the card",
    description: "An older place: at the top of its card's part of the definitions. A chat's note here isn't sent."
  },
  {
    value: "section:before_main_prompt",
    label: "Before the main prompt",
    description: "An older place: right before the preset's main prompt."
  },
  {
    value: "none",
    label: "Not placed",
    description: "Never sent by itself: only a macro that reads it sends its text."
  }
] as const

type Place = (typeof PLACES)[number]["value"]

const DECIDED: ReadonlyArray<Place> = [
  "section:context_start",
  "section:after_main_prompt",
  "depth",
  "section:tail_start",
  "section:tail_end"
]

/** Where a new note goes, and one without a placement. */
const END_OF_TAIL: Placement = { mode: "section", section: "tail_end", role: "system" }

const placeOf = (placement: Placement): Place =>
  placement.mode === "section" ? `section:${placement.section}` : placement.mode

/** A note's place in a few words, for its collapsed row. */
const shortPlace = (placement: Placement | undefined): string => {
  const place = placement ?? END_OF_TAIL
  switch (place.mode) {
    case "depth":
      return `Depth ${place.depth}`
    case "tail":
      return "After the newest message"
    case "none":
      return "Not placed"
    case "section":
      return {
        context_start: "Start of context",
        after_main_prompt: "With the definitions",
        tail_start: "Start of tail",
        tail_end: "End of tail",
        card: "Beside the card",
        before_main_prompt: "Before the main prompt"
      }[place.section]
  }
}

/** Places above the history: a note there that comes and goes rewrites the cached prefix. */
const aboveHistory = (placement: Placement | undefined) =>
  placement?.mode === "section" &&
  ["context_start", "card", "before_main_prompt", "after_main_prompt"].includes(placement.section)

/**
 * A condition as its chip says it: "Aria's turn", "Aria's or Bram's turn", "While Bram isn't
 * muted". A card not in this chat never counts, so only the others are named, unless none is.
 */
const conditionText = (stored: unknown, cards: ReadonlyArray<NoteCard>) => {
  const condition = readNoteCondition(stored)
  if (condition.when === "always") return null
  const named = condition.cards.flatMap((entity) => cards.find((card) => card.entity === entity)?.name ?? [])
  const names = named.length > 0 ? named : ["A card not in this chat"]
  // A long list names two, so the chip fits a phone's row.
  const shown = names.length > 3 ? names.slice(0, 2) : names
  const others = names.length - shown.length
  return condition.when === "turn"
    ? `${anyOf([...shown.map((name) => `${name}'s`), ...(others > 0 ? [`${others} others'`] : [])])} turn`
    : `While ${anyOf([...shown, ...(others > 0 ? [`${others} others`] : [])])} isn't muted`
}

/** "With the definitions" for a card's note: inside its card's part (DESIGN §4.1). */
const CARD_DEFINITIONS = "At the top of this card's own part of the definitions, inside its wrapper."

/** Where a note goes, saved whole as one value. Fields of the placement this editor doesn't show stay as they are. */
function PlacementField({
  store,
  path,
  label,
  card
}: {
  store: EditorStore
  path: FieldPath
  label: string
  /** A card's note: "with the definitions" is inside its card's part. */
  card: boolean
}) {
  const placement = useValue<Placement | undefined>(store, path) ?? END_OF_TAIL
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
  // An older or imported place still shows, when the note is there already.
  const items = PLACES.filter((p) => DECIDED.includes(p.value) || p.value === placeOf(placement)).map((p) =>
    card && p.value === "section:after_main_prompt" ? { ...p, description: CARD_DEFINITIONS } : p
  )
  return (
    // Side by side while they fit, each at its own width, wrapping only when the panel is narrow.
    <>
      <div className="min-w-40 flex-[3]">
        <Field label={label}>
          <Select items={items} value={placeOf(placement)} onValueChange={(place) => set(place)} />
        </Field>
      </div>
      {placement.mode === "depth" && (
        <div className="w-20">
          <Field label="Depth">
            <Tooltip label="Messages back from the newest: at 0 it follows the newest.">
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
            </Tooltip>
          </Field>
        </div>
      )}
      {(placement.mode === "depth" || placement.mode === "tail" || placement.mode === "section") && (
        <div className="w-28">
          <Field label="Role">
            <Select items={ROLES} value={role} onValueChange={(next) => set(placeOf(placement), { role: next })} />
          </Field>
        </div>
      )}
      <div className="basis-full empty:hidden">
        <FieldTools store={store} field={valueField(path)} label={label} />
      </div>
    </>
  )
}

type When = NoteCondition["when"]

const WHEN: ReadonlyArray<{ readonly value: When; readonly label: string; readonly description: string }> = [
  { value: "always", label: "Always", description: "Sent on every turn while it's on." },
  {
    value: "turn",
    label: "On a chosen character's turn",
    description:
      "Sent only when one of the chosen characters writes the message, a new version or continuation of theirs included."
  },
  {
    value: "not_muted",
    label: "While a chosen character isn't muted",
    description: "Sent while at least one of the chosen characters is in the chat and not muted."
  }
]

/** What choosing a card means for the condition, said on its option. */
const cardDescription = (when: Exclude<When, "always">, name: string, offered: boolean) =>
  !offered
    ? "Not in this chat, so it never counts here. Remove it, or add the card to the chat."
    : when === "turn"
      ? `Sent when ${name} writes the message.`
      : `Sent while ${name} isn't muted.`

/**
 * When a note applies (DESIGN §4.1): always, on the turn of any of the chosen cards, or while
 * any of them isn't muted. The cards are the chat's cast (the card itself in its editor); a
 * card the condition names that isn't offered here still shows, and can be removed.
 */
function ConditionField({ store, cards }: { store: EditorStore; cards: ReadonlyArray<NoteCard> }) {
  const condition = readNoteCondition(useValue<unknown>(store, ["condition"]))
  const placement = useValue<Placement | undefined>(store, ["placement"])
  const owner = useValue<unknown>(store, ["owner"])
  const when = condition.when
  const named = conditionCards(condition)
  const missing = named.filter((entity) => !cards.some((card) => card.entity === entity))
  const choices = (on: Exclude<When, "always">) => [
    ...cards.map((card) => ({
      value: card.entity,
      label: card.name,
      description: cardDescription(on, card.name, true)
    })),
    ...missing.map((entity, i) => ({
      value: entity,
      label: missing.length === 1 ? "A card not in this chat" : `A card not in this chat (${i + 1})`,
      description: cardDescription(on, "", false),
      unavailable: true
    }))
  ]
  // A new condition names the note's own card when it's offered, else the first one.
  const ownCard = Predicate.isObject(owner) && Predicate.isString(owner["card"]) ? owner["card"] : null
  const first = cards.find((card) => card.entity === ownCard)?.entity ?? cards[0]?.entity
  const set = (next: When, chosen: ReadonlyArray<string>) =>
    store.setValue(["condition"], next === "always" || chosen.length === 0 ? undefined : { when: next, cards: chosen })
  return (
    <>
      <div className="min-w-52 flex-[3]">
        <Field label="When it applies">
          <Select
            items={WHEN.filter((w) => w.value === "always" || named.length > 0 || cards.length > 0)}
            value={when}
            onValueChange={(next) => set(next, named.length > 0 ? named : first === undefined ? [] : [first])}
          />
        </Field>
      </div>
      {when !== "always" && (
        <div className="min-w-48 flex-[4]">
          <Field label="Characters">
            <MultiSelect
              items={choices(when)}
              value={named}
              minimum={1}
              addLabel="Add"
              chosenLabel="Chosen characters"
              listLabel="Choose characters"
              explanation={WHEN.find((w) => w.value === when)?.description}
              onValueChange={(next) => set(when, next)}
            />
          </Field>
        </div>
      )}
      {when !== "always" && aboveHistory(placement) && (
        <p role="status" className="basis-full text-sm text-warning">
          Placed above the history, it rewrites the cached part of the context whenever its condition changes.
        </p>
      )}
      <div className="basis-full empty:hidden">
        <FieldTools store={store} field={valueField(["condition"])} label="When it applies" />
      </div>
    </>
  )
}

/** The shared note `link` names, while it's out of the bin (null in it). */
const useSharedNote = (link: EntityId, chatNote: ChatNotePosition | undefined) => {
  const atom = useMemo(
    () =>
      AppClient.query(
        "ListSharedNotes",
        { entityId: link, ...(chatNote ? { chatNote } : {}) },
        { reactivityKeys: ["library"] }
      ),
    [link, chatNote]
  )
  const result = useAtomValue(atom)
  if (!AsyncResult.isSuccess(result)) return { loading: true, note: null }
  return { loading: false, note: result.value[0] ?? null }
}

/** Where a shared note can be edited, and how many slots it changes. */
export function SharedBanner({
  link,
  onUnlink,
  onRestore,
  chatNote
}: {
  link: EntityId
  onUnlink: () => void
  onRestore: () => void
  chatNote?: ChatNotePosition | undefined
}) {
  const { loading, note } = useSharedNote(link, chatNote)
  const actions = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  const openSnippet = actions.entries.find((action) => action.id === "snippets.open")
  if (loading) return <p className="text-sm text-muted">Loading the shared note…</p>
  if (note === null)
    return (
      <Alert
        tone="warning"
        title="Its shared note is in the bin"
        actions={
          <>
            <Button onClick={onRestore}>Restore</Button>
            <Button onClick={onUnlink}>Unlink</Button>
          </>
        }
      >
        <p>Nothing of it is sent until the shared note is restored, or this note is unlinked into a copy of it.</p>
      </Alert>
    )
  return (
    <Alert
      title={
        <>
          Shared note “{note.title || "Untitled"}”: edits change it in {note.usedBy}{" "}
          {note.usedBy === 1 ? "place" : "places"}
        </>
      }
      actions={
        <>
          {chatNote && openSnippet ? (
            <Button onClick={() => openSnippet.run({ text: "", source: "note", refId: note.ref.id })}>
              {openSnippet.label}
            </Button>
          ) : (
            <Link to="/library/$refId" params={{ refId: note.ref.id }} className={buttonClass()}>
              Open shared note
            </Link>
          )}
          <Button onClick={onUnlink}>Unlink</Button>
        </>
      }
    >
      <p className="text-muted">{note.excerpt || "It's empty."}</p>
    </Alert>
  )
}

/** How many slots use a shared note, said on its own page. */
function SharedUse({ refId }: { refId: string }) {
  const atom = useMemo(
    () => AppClient.query("ListSharedNotes", { refId: refId as never }, { reactivityKeys: ["library"] }),
    [refId]
  )
  const result = useAtomValue(atom)
  const used = AsyncResult.isSuccess(result) ? (result.value[0]?.usedBy ?? 0) : null
  return (
    <Alert title="A shared note">
      <p>
        {used === null
          ? "Notes in cards and chats can show it."
          : used === 0
            ? "No note shows it yet. Pick it when adding a note to a card or a chat."
            : `${used} ${used === 1 ? "note shows" : "notes show"} it: what you change is used in every one.`}
      </p>
    </Alert>
  )
}

/**
 * A note's settings (owner, 2026-11-01: plain values, applied as they change, folded away under
 * the text): where it goes and its role, when it applies, and its switches, side by side while
 * they fit.
 */
export function NoteSettings({ store, cards = [] }: { store: EditorStore; cards?: ReadonlyArray<NoteCard> }) {
  const owner = useValue<{ card?: string; chat?: string; shared?: string } | undefined>(store, ["owner"])
  const exportable = useValue<boolean | undefined>(store, ["exportable"]) !== false
  const card = owner?.card !== undefined
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <PlacementField store={store} path={["placement"]} label="Position" card={card} />
        <ConditionField store={store} cards={cards} />
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-2">
        <SwitchField
          store={store}
          path={["scan_lore"]}
          label="Lorebook entries can trigger on it"
          hint="Its text is scanned with the chat for lorebook keys."
        />
        {card && (
          <>
            <SwitchField
              store={store}
              path={["on_by_default"]}
              label="On in every chat"
              hint="On in every chat with the card, unless a chat switches it off."
            />
            <Switch
              checked={!exportable}
              onCheckedChange={(hidden) => store.setValue(["exportable"], !hidden)}
              hint="A private note never leaves in an export of the card."
            >
              Private
            </Switch>
          </>
        )}
        <SwitchField
          store={store}
          path={["agent_editable"]}
          label="The agent may edit it"
          hint="Kept for agents, which aren't built yet. A file never turns this on."
        />
      </div>
    </div>
  )
}

/**
 * A note's fields on its own library page. A slot linked to a shared note shows the shared note
 * in place of its text, and keeps its own place, condition and switches.
 */
export function NoteFields({
  store,
  cards = [],
  chatNote,
  onUnlink,
  onRestore
}: {
  store: EditorStore
  chatNote?: ChatNotePosition | undefined
  /** The cards its condition can name. */
  cards?: ReadonlyArray<NoteCard>
  onUnlink?: () => void
  onRestore?: () => void
}) {
  const owner = useValue<{ card?: string; chat?: string; shared?: string } | undefined>(store, ["owner"])
  const link = useValue<EntityId | undefined>(store, ["link"])
  const refId = useEditorState(store).snapshot?.ref.id
  if (owner?.shared !== undefined)
    return (
      <div className="flex flex-col gap-3">
        {refId && <SharedUse refId={refId} />}
        {owner.shared !== "global" && (
          <p className="text-sm text-muted">
            A snippet of one chat, in every branch of it.{" "}
            <Link
              to="/chats/$chatId"
              params={{ chatId: owner.shared }}
              search={{ panel: "snippets" }}
              className="text-accent underline-offset-4 hover:underline"
            >
              Open it in that chat's Snippets
            </Link>
          </p>
        )}
        <TextField store={store} path={["title"]} label="Name" />
        <TextField store={store} path={["content"]} label="Content" rows={6} />
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      <TextField store={store} path={["title"]} label="Name" />
      {link === undefined ? (
        <TextField store={store} path={["content"]} label="Content" rows={4} />
      ) : (
        <SharedBanner chatNote={chatNote} link={link} onUnlink={() => onUnlink?.()} onRestore={() => onRestore?.()} />
      )}
      <NoteSettings store={store} cards={cards} />
    </div>
  )
}

/** A note's name for its header: its own, else its library label, else "Untitled" (and its first line). */
export const noteTitle = (title: unknown, content: unknown, label: string) => {
  const own = typeof title === "string" ? title.trim() : ""
  if (own !== "") return { title: own, derived: false }
  const first = String(content ?? "")
    .split("\n")
    .find((line) => line.trim() !== "")
  if (label && label !== "Note") return { title: label, derived: true }
  return { title: first?.trim().slice(0, 80) || "Untitled", derived: true }
}

/** Where a note goes and when, in a few words, for the line under its name: "End of tail · Aria's turn". */
export const noteState = (doc: Doc, cards: ReadonlyArray<NoteCard>) =>
  [shortPlace(doc["placement"] as Placement | undefined), conditionText(doc["condition"], cards) ?? "always"].join(
    " · "
  )

/** A note's settings in a few words, for its settings section while folded. */
export const settingsSummary = (doc: Doc) => {
  const placement = (doc["placement"] as Placement | undefined) ?? END_OF_TAIL
  const role = placement.mode === "none" ? null : (placement.role ?? "system")
  return [
    role === null ? null : `as ${role}`,
    doc["scan_lore"] === true ? "lorebook scan" : null,
    doc["on_by_default"] === true ? "on in every chat" : null,
    doc["exportable"] === false && Predicate.isObject(doc["owner"]) && "card" in doc["owner"] ? "private" : null,
    doc["agent_editable"] === true ? "agent may edit" : null
  ]
    .filter((part) => part !== null)
    .join(" · ")
}

/**
 * A note's settings as History reads them (owner, 2026-11-01: words, never JSON): "Position:
 * in the history, depth 1, as system", "When: Aria's turn".
 */
export const noteSettingLines =
  (cards: ReadonlyArray<NoteCard>) =>
  (path: ReadonlyArray<string | number>): ((value: unknown) => ReadonlyArray<string>) | undefined => {
    if (path.length !== 1) return undefined
    if (path[0] === "placement")
      return (value) => {
        const placement = (value as Placement | undefined) ?? END_OF_TAIL
        const role = placement.mode === "none" ? "" : `, as ${placement.role ?? "system"}`
        const place =
          placement.mode === "depth"
            ? `in the history, depth ${placement.depth}`
            : shortPlace(placement)
                .toLowerCase()
                .replace(/^start of tail$/, "start of the tail")
                .replace(/^end of tail$/, "end of the tail")
        return [`Position: ${place}${role}`]
      }
    if (path[0] === "condition") return (value) => [`When: ${conditionText(value, cards) ?? "always"}`]
    return undefined
  }

/** The shared named notes, filtered by name, to fill a note slot with one (DESIGN §4.1). */
export function SharedNotePicker({
  open,
  onOpenChange,
  call,
  onPick,
  chatNote
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  call: Caller
  chatNote?: ChatNotePosition | undefined
  onPick: (note: SharedNote) => void
}) {
  const [query, setQuery] = useState("")
  const [notes, setNotes] = useState<ReadonlyArray<SharedNote> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  useEffect(() => {
    if (!open) return
    let current = true
    void call((client) => client("ListSharedNotes", { query, ...(chatNote ? { chatNote } : {}) })).then((result) => {
      if (!current) return
      if (result.ok) {
        setNotes(result.value)
        setError(null)
      } else setError(result.error)
    })
    return () => {
      current = false
    }
  }, [call, open, query, chatNote])
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pick a shared note"
      description="The note shows the shared note's text, and edits to it change it everywhere it's used."
    >
      <Field label="Filter by name">
        <Input value={query} autoFocus placeholder="Name" onChange={(event) => setQuery(event.currentTarget.value)} />
      </Field>
      <ErrorAlert error={error} />
      {notes === null ? (
        <p className="text-sm text-muted">Loading the shared notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted">
          {query.trim() === ""
            ? "No shared notes yet. Save a note as a shared note from its menu."
            : "No shared note has that in its name."}
        </p>
      ) : (
        <ul aria-label="Shared notes" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {notes.map((note) => (
            <li key={note.ref.id}>
              <button
                type="button"
                onClick={() => onPick(note)}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{note.title || "Untitled"}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {note.usedBy === 0 ? "unused" : `used in ${note.usedBy}`}
                  </span>
                </span>
                <span className="line-clamp-2 text-sm text-muted">{note.excerpt || "Empty."}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <DialogActions>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
      </DialogActions>
    </Dialog>
  )
}

/** A new note, or one showing a shared note. */
export function AddNoteButtons({ onNew, onPick }: { onNew: () => void; onPick: () => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <IconButton label="New note" hint="An empty note of its own here." icon="write" onClick={onNew} />
      <IconButton
        label="Pick a shared note"
        hint="A note that shows a shared note's text: editing it changes it everywhere it's used."
        icon="link"
        onClick={onPick}
      />
    </div>
  )
}
