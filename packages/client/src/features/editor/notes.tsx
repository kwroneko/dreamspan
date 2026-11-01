import { textActions } from "../../textActions.tsx"
// Notes (DESIGN §4.1): a note's fields and its editor, its collapsed row, and the picker of
// shared named notes, used by the card editor, a note's own page and a chat's notes.
import { useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { concretePlacement, type NoteCondition, type Placement } from "@rp/shared/docs/note.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { ChatNotePosition, SharedNote } from "@rp/shared/editorApi.ts"
import type { Doc, LibraryRef } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
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
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { browserEnv } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { FieldTools, RecoveredNotice, RestoredNotice, SwitchField, TextField } from "./controls.tsx"
import { SaveDialog } from "./SaveDialog.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useValue } from "./store.ts"

/** A card a note's condition can name: the chat's cast, or in the card editor the card itself. */
export interface NoteCard {
  readonly entity: string
  readonly name: string
}

const ROLES = [
  { value: "system", label: "System" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" }
] as const

type Role = (typeof ROLES)[number]["value"]

type Section = Extract<Placement, { mode: "section" }>["section"]

/**
 * Where a note goes: the five places relative to the preset's own sections (DESIGN §4.1),
 * then older and imported places, which show only on a note already there.
 */
const PLACES = [
  { value: "section:context_start", label: "Start of context" },
  { value: "section:after_main_prompt", label: "With the definitions (after the main prompt)" },
  { value: "depth", label: "In the history, at a depth" },
  { value: "section:tail_start", label: "Start of the tail" },
  { value: "section:tail_end", label: "End of the tail" },
  { value: "tail", label: "After the newest message (older notes)" },
  { value: "section:card", label: "Beside the card's definition (older notes)" },
  { value: "section:before_main_prompt", label: "Before the main prompt (older notes)" },
  { value: "none", label: "Not placed: only a macro reads it" }
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

const placeOf = (placement: Placement): Place => {
  const place = concretePlacement(placement)
  return place.mode === "section" ? (`section:${place.section}` as Place) : place.mode
}

/** A note's place in a few words, for its collapsed row. */
const shortPlace = (placement: Placement | undefined): string => {
  const place = concretePlacement(placement ?? END_OF_TAIL)
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
        before_main_prompt: "Before the main prompt",
        // An old revision's: read as `LEGACY_PLACEMENT`, above.
        author_note_top: "",
        author_note_bottom: ""
      }[place.section]
  }
}

/** Places above the history: a note there that comes and goes rewrites the cached prefix. */
const aboveHistory = (placement: Placement | undefined) =>
  placement?.mode === "section" &&
  ["context_start", "card", "before_main_prompt", "after_main_prompt"].includes(placement.section)

/** A condition as its chip says it: "Aria's turn", "While Bram isn't muted". */
const conditionText = (condition: NoteCondition | undefined, cards: ReadonlyArray<NoteCard>) => {
  if (condition === undefined || condition.when === "always") return null
  const name = cards.find((card) => card.entity === condition.card)?.name ?? "A card not in this chat"
  return condition.when === "turn" ? `${name}'s turn` : `While ${name} isn't muted`
}

/** "With the definitions" for a card's note: inside its card's part (DESIGN §4.1). */
const CARD_DEFINITIONS = "With the definitions (in the card's part)"

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
  // An old revision's place at the author's note shows, and saves, as the place it's read as.
  const placement = concretePlacement(useValue<Placement | undefined>(store, path) ?? END_OF_TAIL)
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
    card && p.value === "section:after_main_prompt" ? { ...p, label: CARD_DEFINITIONS } : p
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

const WHEN: ReadonlyArray<{ readonly value: When; readonly label: string }> = [
  { value: "always", label: "Always" },
  { value: "turn", label: "On a character's turn" },
  { value: "not_muted", label: "While a character isn't muted" }
]

/** When a note applies (DESIGN §4.1): always, on a card's turn, or while a card isn't muted. */
function ConditionField({ store, cards }: { store: EditorStore; cards: ReadonlyArray<NoteCard> }) {
  const condition = useValue<NoteCondition | undefined>(store, ["condition"])
  const placement = useValue<Placement | undefined>(store, ["placement"])
  const when = condition?.when ?? "always"
  const named = condition && condition.when !== "always" ? condition.card : null
  // A card the condition names that isn't one offered here still shows.
  const choices = [
    ...cards.map((card) => ({ value: card.entity, label: card.name })),
    ...(named !== null && !cards.some((card) => card.entity === named)
      ? [{ value: named, label: "A card not in this chat" }]
      : [])
  ]
  const set = (next: When, card: string | null) =>
    store.setValue(["condition"], next === "always" || card === null ? undefined : { when: next, card })
  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="grid gap-3 @md:grid-cols-2">
        <Field label="When it applies">
          <Select
            items={WHEN.filter((w) => w.value === "always" || choices.length > 0)}
            value={when}
            onValueChange={(next) => set(next, named ?? choices[0]?.value ?? null)}
          />
        </Field>
        {when !== "always" && (
          <Field label="Character">
            <Select items={choices} value={named} onValueChange={(card) => set(when, card)} />
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
            : `${used} ${used === 1 ? "note shows" : "notes show"} it: saving changes it in every one.`}
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
        <p>Open this snippet beside its chat to edit the text for that fork.</p>
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
  const [saving, setSaving] = useState(false)
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
  /** Saving as or unlinking from a shared note takes the saved note: unsaved changes first. */
  const relink = async (action: "share" | "unlink") => {
    await store.flush()
    if (store.state().dirty > 0) {
      setError({
        tag: "Unsaved",
        message: "Save or discard the note's changes first.",
        problems: [],
        reason: null
      })
      return
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
  const dirty = state.dirty > 0
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
        <Button variant="primary" disabled={!dirty} onClick={() => setSaving(true)}>
          Save the note
        </Button>
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
            <MenuItem icon="link" onClick={() => void relink("share")}>
              Save as shared note
            </MenuItem>
          )}
          {onDeleted && (
            <MenuItem icon="trash" tone="danger" onClick={() => void remove()}>
              Delete the note
            </MenuItem>
          )}
        </Menu>
        {dirty && <Badge tone="accent">unsaved changes</Badge>}
      </div>
      {saving && <SaveDialog store={store} onClose={() => setSaving(false)} onSaved={() => setSaving(false)} />}
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
  const condition = conditionText(doc["condition"] as NoteCondition | undefined, cards)
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
      <MenuItem icon="write" onClick={onNew}>
        New note
      </MenuItem>
      <MenuItem icon="link" onClick={onPick}>
        Pick a shared note…
      </MenuItem>
    </Menu>
  )
}
