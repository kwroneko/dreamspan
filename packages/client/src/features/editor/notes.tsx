import { textActions } from "../../textActions.tsx"
// Notes (DESIGN §4.1): a note's fields and its editor, its collapsed row, and the picker of
// shared named notes, used by the card editor, a note's own page and a chat's notes.
import { useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { anyOf, conditionCards, type NoteCondition, type Placement, readNoteCondition } from "@rp/shared/docs/note.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { ChatNotePosition, SharedNote } from "@rp/shared/editorApi.ts"
import type { Doc, LibraryRef } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { MultiSelect } from "../../ui/MultiSelect.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { browserEnv } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { FieldTools, RecoveredNotice, RestoredNotice, SwitchField, TextField } from "./controls.tsx"
import { SaveRevision } from "./SaveRevision.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useValue } from "./store.ts"

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
    description: "An older place: in the history at depth 0, as ST puts it. Pick another to move it."
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
    // Three across when its container is wide enough, not the window: it's in the chat's side panel too.
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="grid gap-3 @md:grid-cols-3">
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
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="grid gap-3 @md:grid-cols-2">
        <Field label="When it applies">
          <Select
            items={WHEN.filter((w) => w.value === "always" || named.length > 0 || cards.length > 0)}
            value={when}
            onValueChange={(next) => set(next, named.length > 0 ? named : first === undefined ? [] : [first])}
          />
        </Field>
        {when !== "always" && (
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
        )}
      </div>
      {when !== "always" && aboveHistory(placement) && (
        <p role="status" className="text-sm text-warning">
          Placed above the history, it rewrites the cached part of the context whenever its condition changes.
        </p>
      )}
      <FieldTools store={store} field={valueField(["condition"])} label="When it applies" />
    </div>
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
function SharedBanner({
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
 * A note's fields, wherever it's edited. A slot linked to a shared note shows the shared note
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
  const exportable = useValue<boolean | undefined>(store, ["exportable"]) !== false
  const refId = useEditorState(store).snapshot?.ref.id
  if (owner?.shared !== undefined && owner.shared !== "global")
    return (
      <Alert title="A chat snippet">
        <p>Open this snippet beside its chat to edit the text for that branch.</p>
        <Link
          to="/chats/$chatId"
          params={{ chatId: owner.shared }}
          search={{ panel: "snippets" }}
          className={buttonClass()}
        >
          Open in Snippets
        </Link>
      </Alert>
    )
  if (owner?.shared !== undefined)
    return (
      <div className="flex flex-col gap-3">
        {refId && <SharedUse refId={refId} />}
        <TextField store={store} path={["title"]} label="Name" />
        <TextField store={store} path={["content"]} label="Content" rows={6} />
      </div>
    )
  const card = owner?.card !== undefined
  return (
    <div className="flex flex-col gap-3">
      <TextField store={store} path={["title"]} label="Name" />
      {link === undefined ? (
        <TextField store={store} path={["content"]} label="Content" rows={4} />
      ) : (
        <SharedBanner chatNote={chatNote} link={link} onUnlink={() => onUnlink?.()} onRestore={() => onRestore?.()} />
      )}
      <PlacementField store={store} path={["placement"]} label="Position" card={card} />
      <ConditionField store={store} cards={cards} />
      <SwitchField
        store={store}
        path={["scan_lore"]}
        label="Lorebook entries can trigger on this note"
        description="Its text is scanned with the chat, as ST's “Include in World Info Scanning”."
      />
      {card && (
        <>
          <SwitchField
            store={store}
            path={["on_by_default"]}
            label="On in every chat"
            description="On in every chat with the card, unless a chat switches it off."
          />
          <Switch
            checked={!exportable}
            onCheckedChange={(hidden) => store.setValue(["exportable"], !hidden)}
            description="A private note never leaves in an export."
          >
            Private (not exported)
          </Switch>
        </>
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
  chatNote,
  cards,
  onRelinked
}: {
  noteRef: LibraryRef
  call: Caller
  /** Without it, the note can't be deleted from here. */
  onDeleted?: (item: BinItem) => void
  /** Said above the fields. */
  notice?: ReactNode
  chatNote?: ChatNotePosition
  cards?: ReadonlyArray<NoteCard>
  /** Told after it was saved as a shared note or unlinked from one, which changes what it is. */
  onRelinked?: () => void
}) {
  const userId = useSession().user.id
  const [store] = useState(() => new EditorStore(noteRef.id, userId, call, browserEnv, chatNote))
  const [error, setError] = useState<AppError | null>(null)
  const state = useEditorState(store)
  const link = useValue<EntityId | undefined>(store, ["link"])
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.snapshot === null) return <p className="text-sm text-muted">Loading the note…</p>
  const position = chatNote ? { chatNote } : {}
  const remove = async () => {
    // What's typed goes with the note to the bin, and comes back with it. A change that can't
    // reach the server stays in this browser until the note can be opened again.
    await store.flush()
    const result = await call((client) => client("DeleteNote", { noteRefId: noteRef.id }), ["library"])
    if (result.ok) onDeleted?.(result.value)
    else setError(result.error)
  }
  /** Saving as or unlinking from a shared note takes the saved note: its changes are saved first. */
  const relink = async (action: "share" | "unlink") => {
    await store.flush()
    if (store.state().dirty > 0) {
      const saved = await store.commit(null)
      if (!saved.ok) return setError(saved.error)
    }
    const result = await call(
      (client) =>
        action === "share"
          ? client("CreateSharedNote", { title: "", content: "", fromNoteRefId: noteRef.id, ...position })
          : client("UnlinkNote", { noteRefId: noteRef.id, ...position }),
      ["library"]
    )
    if (!result.ok) return setError(result.error)
    setError(null)
    onRelinked?.()
  }
  const restore = async () => {
    const bin = await call((client) => client("ListBin", { limit: 500, before: null }))
    if (!bin.ok) return setError(bin.error)
    const item = bin.value.find((entry) => entry.kind === "entity" && entry.targetId === link)
    if (!item)
      return setError({
        tag: "NotFound",
        message: "The shared note isn't in the bin any more.",
        problems: [],
        reason: null
      })
    const restored = await call((client) => client("RestoreBinItem", { itemId: item.id }), ["library"])
    if (!restored.ok) return setError(restored.error)
    setError(null)
    onRelinked?.()
  }
  const shareable = link === undefined
  return (
    <section aria-label={`Note ${noteRef.label}`} className="flex flex-col gap-3 rounded-md border border-border p-3">
      {notice}
      <RestoredNotice count={state.restored} />
      <RecoveredNotice store={store} />
      <NoteFields
        chatNote={chatNote}
        store={store}
        {...(cards ? { cards } : {})}
        onUnlink={() => void relink("unlink")}
        onRestore={() => void restore()}
      />
      <ErrorAlert error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <SaveRevision store={store} />
        <Menu
          label="Note actions"
          align="start"
          trigger={
            <Button variant="ghost" aria-label={`More actions for ${noteRef.label}`}>
              <Icon name="more" />
            </Button>
          }
        >
          {shareable && (
            <MenuItem
              icon="link"
              description="Makes its text a shared note this one shows, so other cards and chats can use it too."
              onClick={() => void relink("share")}
            >
              Save as shared note
            </MenuItem>
          )}
          {onDeleted && (
            <MenuItem
              icon="trash"
              tone="danger"
              description="Moves it to the bin, where it can be restored."
              onClick={() => void remove()}
            >
              Delete the note
            </MenuItem>
          )}
        </Menu>
      </div>
    </section>
  )
}

/** A note's name for its row: its own, else "Untitled" and its first line. */
const rowTitle = (doc: Doc, label: string) => {
  const title = typeof doc["title"] === "string" ? doc["title"].trim() : ""
  if (title !== "") return { title, muted: null }
  const first = String(doc["content"] ?? "")
    .split("\n")
    .find((line) => line.trim() !== "")
  return { title: label && label !== "Note" ? label : "Untitled", muted: first?.trim().slice(0, 80) ?? null }
}

/**
 * A note collapsed to one row (DESIGN §4.1): its switch when it has one, its name, where it
 * goes and when, and whether it's shared or private. Opening it shows `children`, its editor.
 */
export function NoteRow({
  doc,
  label,
  cards,
  open,
  onOpenChange,
  control,
  shared,
  detail,
  keepMounted = false,
  children
}: {
  doc: Doc
  label: string
  cards: ReadonlyArray<NoteCard>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Its on/off switch in a chat. */
  control?: ReactNode
  /** The shared note it shows: its name, or that it's in the bin. */
  shared?: { readonly title: string; readonly binned: boolean } | null
  /** A line under the row, shown collapsed too. */
  detail?: ReactNode
  /**
   * Keep the editor mounted while collapsed, so a note's unsaved text is still guarded on
   * leaving and a copy kept in this browser comes back as the page opens.
   */
  keepMounted?: boolean
  children: ReactNode
}) {
  const { title, muted } = rowTitle(doc, label)
  const condition = conditionText(doc["condition"], cards)
  const kind = doc["kind"]
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex min-w-0 items-start gap-2">
        {control && <div className="pt-1.5">{control}</div>}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-1 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {doc["link"] !== undefined && (
              <span className="shrink-0 text-muted" title="Shows a shared note">
                <Icon name="link" />
                <span className="sr-only">Shared note</span>
              </span>
            )}
            <span className="truncate text-sm font-medium">{title}</span>
            {muted && <span className="min-w-0 truncate text-sm text-muted">{muted}</span>}
          </span>
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>{shortPlace(doc["placement"] as Placement | undefined)}</span>
            {condition && <Badge tone="accent">{condition}</Badge>}
            {/* Without a switch (the card editor), whether a card's note is on in every chat. */}
            {!control && doc["on_by_default"] === true && <Badge>On in every chat</Badge>}
            {shared?.binned && <Badge tone="warning">linked note is in the bin</Badge>}
            {doc["exportable"] === false && "card" in Object(doc["owner"]) && <Badge>Private</Badge>}
            {kind === "imported_summary" && <Badge>summary</Badge>}
          </span>
        </button>
        <span aria-hidden="true" className={`pt-2 text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <Icon name="down" />
        </span>
      </div>
      {detail}
      {keepMounted ? <div hidden={!open}>{children}</div> : open && children}
    </li>
  )
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

/** "Add note": a new one, or one showing a shared note. */
export function AddNoteMenu({
  label = "Add note",
  onNew,
  onPick
}: {
  label?: string
  onNew: () => void
  onPick: () => void
}) {
  return (
    <Menu
      align="start"
      label={label}
      trigger={
        <Button>
          {label} <Icon name="down" />
        </Button>
      }
    >
      <MenuItem icon="write" description="An empty note of its own here." onClick={onNew}>
        New note
      </MenuItem>
      <MenuItem
        icon="link"
        description="A note that shows a shared note's text: editing it changes it everywhere it's used."
        onClick={onPick}
      >
        Pick a shared note…
      </MenuItem>
    </Menu>
  )
}
