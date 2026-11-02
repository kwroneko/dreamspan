// The card editor: every card field and the card's notes (DESIGN §4.1, §4.1a), in tabs (owner,
// 2026-11-01), the same component in the chat's character tab (`layout: "panel"`, a narrow
// column) and in the full editor (`layout: "page"`). Definition holds what goes into the prompt
// directly, Greetings the greetings, Metadata everything that isn't prompt text, Lorebook the
// card's own book, Notes the card's notes, Extra its regex scripts and the sections plugins
// add (`cardEditorSections`). Each tab is registered (`cardTabs.ts`). Card modules are card
// notes (§5.0).
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { valueField, type FieldPath } from "@rp/shared/editing.ts"
import type { NoteEntry, SharedNote } from "@rp/shared/editorApi.ts"
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Fieldset } from "../../ui/Field.tsx"
import { Slider } from "../../ui/Slider.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { CardSources } from "../cardSources/index.tsx"
import type { Caller } from "./caller.ts"
import { CardTextEditor } from "./CardTextEditor.tsx"
import { CARD_LOREBOOK_SECTION, cardEditorSections } from "./cardSections.ts"
import { CARD_TAB_DEFINITION, type CardTabProps, cardEditorTabs } from "./cardTabs.ts"
import { FieldTools, TextField } from "./controls.tsx"
import { LorebookForm } from "./LorebookForm.tsx"
import { LorebookPanelEditor } from "./LorebookPanelEditor.tsx"
import { addEntry } from "./lorebookTable.ts"
import { NoteList, NoteListControls, useNoteBlocks } from "./NoteList.tsx"
import { AddNoteButtons, SharedNotePicker } from "./notes.tsx"
import { EditorPortrait } from "./PortraitControls.tsx"
import { PromptUseNote } from "./PromptUseNote.tsx"
import { SearchNavigation } from "./searchNavigation.ts"
import { type EditorStore, useEditorState, useText, useValue, useWorkingDoc } from "./store.ts"
import { MACROS_COUNTED, useCountMacros } from "./countMacros.ts"
import { tokenizerText, tokensText, useTokenCounts } from "./tokenCounts.ts"

/** What each field is for, on hover over its label. */
const HINTS = {
  description: "Who they are: sent with every request. {{char}} and {{user}} become the names.",
  personality: "A short summary of their personality, sent with every request after the description.",
  scenario: "The situation the chat starts in, sent with every request.",
  mes_example: "Example dialogue showing how they talk, each example starting with <START>. Sent as the preset says.",
  system_prompt:
    "The card's own system prompt: used in place of the preset's Main Prompt where the preset allows it ({{original}} is the preset's).",
  post_history_instructions:
    "The card's own instructions after the chat history: used in place of the preset's where it allows it ({{original}} is the preset's).",
  first_mes: "The first message of a new chat with them, unless another greeting is picked.",
  creator_notes: "The creator's notes for users of the card: never sent to the model.",
  creator: "Who made the card, as the card file says.",
  tags: "Words to find and sort cards by in the library; never sent to the model."
} as const

/**
 * A field's tokens with the chat model's tokenizer, its macros expanded first as ST does
 * (`useCountMacros`), at the end of its label, counted as you type.
 */
function FieldTokens({ store, path }: { store: EditorStore; path: FieldPath }) {
  const text = useText(store, path) ?? ""
  const expand = useCountMacros(store)
  const texts = useMemo(() => [expand(text)], [expand, text])
  const { counts, tokenizer, pending } = useTokenCounts(texts)
  return (
    <Tooltip label={`${MACROS_COUNTED} ${tokenizerText(tokenizer)}`}>
      <span
        tabIndex={0}
        data-field-tokens
        aria-busy={pending || undefined}
        className="rounded text-xs font-normal text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {tokensText(counts[0] ?? null, tokenizer, pending)}
      </span>
    </Tooltip>
  )
}

/** A text field of the card with its hint, and its token count where it's prompt text. */
function CardField({
  store,
  field,
  label,
  rows,
  tokens = false
}: {
  store: EditorStore
  field: keyof typeof HINTS
  label: string
  rows?: number
  tokens?: boolean
}) {
  return (
    <TextField
      store={store}
      path={[field]}
      label={label}
      hint={HINTS[field]}
      aside={tokens ? <FieldTokens store={store} path={[field]} /> : undefined}
      {...(rows === undefined ? {} : { rows })}
    />
  )
}

/** A list of greetings at `path`: alternate greetings, or the ones used only in group chats. */
function Greetings({
  store,
  path,
  title,
  one,
  about,
  add
}: {
  store: EditorStore
  path: FieldPath
  title: string
  /** "Alternate greeting": each one's label, numbered. */
  one: string
  /** Only where the heading doesn't say it all (DESIGN §10.1). */
  about?: string
  add: { label: string; hint: string }
}) {
  const greetings = useValue<ReadonlyArray<string> | undefined>(store, path) ?? []
  return (
    <Fieldset legend={title} {...(about ? { about } : {})}>
      {greetings.map((greeting, index) => (
        <div key={index} className="flex flex-col gap-1">
          <Field label={`${one} ${index + 1}`}>
            <CardTextEditor
              store={store}
              field={valueField(path)}
              path={[...path, index]}
              label={`${one} ${index + 1}`}
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
              aria-label={`Remove ${one.toLowerCase()} ${index + 1}`}
              hint="Removes this greeting from the card; History keeps every revision."
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button hint={add.hint} onClick={() => store.setValue(path, [...greetings, ""])}>
          {add.label}
        </Button>
      </div>
      <FieldTools store={store} field={valueField(path)} label={title} />
    </Fieldset>
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
    <Fieldset legend="Tags" about={HINTS.tags}>
      {/* The chips, then a short field the width of what's typed with a + at their end (owner,
          2026-11-02): Enter or + adds. */}
      <ul aria-label="Tags" className="flex flex-wrap items-center gap-2">
        {tags.map((name) => (
          <li
            key={name}
            className="flex items-center gap-0.5 rounded-full border border-border py-0.5 pr-0.5 pl-3 text-sm"
          >
            {name}
            <IconButton
              data-layout-audit-ignore="inset: Remove action is part of its compact tag chip"
              label={`Remove the tag ${name}`}
              hint={`Removes the tag “${name}” from this card.`}
              icon="close"
              className="size-6! rounded-full"
              onClick={() =>
                store.setValue(
                  path,
                  tags.filter((other) => other !== name)
                )
              }
            />
          </li>
        ))}
        <li
          data-new-tag
          data-layout-audit-ignore="inset: The new tag's field and + are part of their compact chip"
          className="flex items-center gap-0.5 rounded-full border border-dashed border-border py-0.5 pr-0.5 pl-3 text-sm focus-within:border-focus"
        >
          <input
            aria-label="New tag"
            value={tag}
            placeholder="New tag"
            size={Math.max(7, [...tag].length + 1)}
            className="max-w-48 min-w-0 bg-transparent outline-none placeholder:text-muted"
            onChange={(event) => setTag(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                add()
              }
            }}
          />
          <IconButton
            label="Add the tag"
            hint="Add what's typed as a tag of this card (or press Enter)."
            icon="plus"
            className="size-6! rounded-full"
            onClick={add}
          />
        </li>
      </ul>
      <FieldTools store={store} field={valueField(path)} label="Tags" />
    </Fieldset>
  )
}

/** ST's default talkativeness, for a card that doesn't set it (public/script.js `talkativeness_default`). */
export const TALKATIVENESS_DEFAULT = 0.5
const TALKATIVENESS = ["extensions", "talkativeness"]

/**
 * How often they speak up in group chats (ST's "Talkativeness" slider, `extensions.talkativeness`,
 * 0 to 1): their chance to reply when no one is named and it's no one's turn. A setting: it
 * applies as it's changed.
 */
function Talkativeness({ store }: { store: EditorStore }) {
  const stored = useValue<unknown>(store, TALKATIVENESS)
  const value = typeof stored === "number" && Number.isFinite(stored) ? stored : TALKATIVENESS_DEFAULT
  const [dragged, setDragged] = useState<number | null>(null)
  return (
    <Slider
      label="Talkativeness in group chats"
      about="Choose how often they reply in a group. A character named in the message answers first; otherwise this chance applies. Default: 50%."
      value={dragged ?? value}
      min={0}
      max={1}
      step={0.05}
      valueText={(next) => `${Math.round(next * 100)}%`}
      onValueChange={setDragged}
      onValueCommitted={(next) => {
        setDragged(null)
        store.setValue(TALKATIVENESS, Math.round(next * 100) / 100)
      }}
    />
  )
}

/** The card file's dates (CCv3 `creation_date`, `modification_date`, Unix seconds), read-only. */
function CardDates({ store }: { store: EditorStore }) {
  const created = useValue<number | undefined>(store, ["creation_date"])
  const modified = useValue<number | undefined>(store, ["modification_date"])
  if (typeof created !== "number" && typeof modified !== "number") return null
  const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString()
  return (
    <p className="text-sm text-muted">
      {typeof created === "number" && <>Created {day(created)} by its file. </>}
      {typeof modified === "number" && <>Last changed {day(modified)} by its file.</>}
    </p>
  )
}

/** The card's notes (DESIGN §4.1), each a block: they travel with the card to every chat. */
function CardNotes({ store, call }: { store: EditorStore; call: Caller }) {
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
      {notes === null && !error && <p role="status">Loading the notes…</p>}
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
        <AddNoteButtons onNew={() => void add()} onPick={() => setPicking(true)} />
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

/** Two columns on a wide page for fields that fit side by side; one in the panel. */
const columns = (layout: CardTabProps["layout"]) =>
  layout === "page" ? "grid gap-4 lg:grid-cols-2" : "flex flex-col gap-4"

function DefinitionTab({ store, call, layout }: CardTabProps) {
  const panel = layout === "panel"
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <CardField store={store} field="description" label="Description" rows={panel ? 8 : 12} tokens />
      <div className={columns(layout)}>
        <CardField store={store} field="personality" label="Personality" rows={panel ? 3 : 4} tokens />
        <CardField store={store} field="scenario" label="Scenario" rows={panel ? 3 : 4} tokens />
      </div>
      <CardField store={store} field="mes_example" label="Example messages" rows={panel ? 5 : 6} tokens />
      <div className={columns(layout)}>
        <div className="flex min-w-0 flex-col gap-1">
          <CardField store={store} field="system_prompt" label="System prompt" rows={panel ? 3 : 4} tokens />
          <PromptUseNote store={store} call={call} field="system_prompt" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <CardField
            store={store}
            field="post_history_instructions"
            label="Post-history instructions"
            rows={panel ? 3 : 4}
            tokens
          />
          <PromptUseNote store={store} call={call} field="post_history_instructions" />
        </div>
      </div>
    </div>
  )
}

function GreetingsTab({ store, layout }: CardTabProps) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <CardField store={store} field="first_mes" label="First message" rows={layout === "panel" ? 5 : 6} tokens />
      <Greetings
        store={store}
        path={["alternate_greetings"]}
        title="Alternate greetings"
        one="Alternate greeting"
        add={{ label: "Add a greeting", hint: "A new, empty alternate greeting at the end of the list." }}
      />
      <Greetings
        store={store}
        path={["group_only_greetings"]}
        title="Group greetings"
        one="Group greeting"
        about="Offered only when a new chat has more than one character."
        add={{ label: "Add a group greeting", hint: "A new, empty greeting used only in group chats." }}
      />
    </div>
  )
}

function MetadataTab({ store, call, layout }: CardTabProps) {
  const doc = useWorkingDoc(store)
  const about = (
    <>
      <CardField store={store} field="creator_notes" label="Creator's notes" rows={4} />
      <Tags store={store} />
      <div className={columns(layout)}>
        <TextField store={store} path={["creator"]} label="Creator" hint={HINTS.creator} />
      </div>
    </>
  )
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {layout === "page" ? (
        // On a wide page the picture stands beside the notes, tags and creator, tops aligned.
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <section aria-labelledby="card-picture" className="flex shrink-0 flex-col gap-2">
            <h3 id="card-picture" className="text-sm font-medium">
              Picture
            </h3>
            <EditorPortrait store={store} call={call} />
          </section>
          <div className="flex min-w-0 flex-1 flex-col gap-6">{about}</div>
        </div>
      ) : (
        about
      )}
      <CardDates store={store} />
      <section aria-labelledby="card-group-settings" className="flex flex-col gap-2">
        <h3 id="card-group-settings" className="text-sm font-medium">
          In group chats
        </h3>
        <Talkativeness store={store} />
      </section>
      <CardSources doc={doc as Parameters<typeof CardSources>[0]["doc"]} />
    </div>
  )
}

const BOOK: FieldPath = ["character_book"]

/**
 * The card's own book: in the side panel, the panel's book editor (entry headers opening to
 * their text, settings a level down; Large editor opens the table); in the full editor, the
 * table editor its width suits (`LorebookForm`, as the book's own view and a library lorebook).
 */
function LorebookTab({ store, layout, onOpenBook }: CardTabProps) {
  const book = useValue<LorebookDoc | undefined>(store, BOOK)
  const name = useText(store, ["name"]) || "This card"
  if (layout === "page")
    return (
      <div data-card-lorebook className="flex min-w-0 flex-col gap-4">
        <LorebookForm store={store} root={BOOK} absent={`${name} has no lorebook of its own.`} />
        <FieldTools store={store} field={valueField(BOOK)} label="Lorebook" />
      </div>
    )
  if (!book)
    return (
      <div className="flex min-w-0 flex-col items-start gap-3">
        <p className="text-sm text-muted">{name} has no lorebook of its own.</p>
        <Button
          hint="Starts the card's own lorebook with one empty entry."
          onClick={() => {
            addEntry(store, BOOK, undefined)
          }}
        >
          Add a lorebook
        </Button>
      </div>
    )
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <LorebookPanelEditor
        store={store}
        root={BOOK}
        fallbackName={`${name}'s lorebook`}
        saveControls={false}
        {...(onOpenBook ? { onOpenLarge: onOpenBook } : {})}
      />
    </div>
  )
}

function NotesTab({ store, call }: CardTabProps) {
  return <CardNotes store={store} call={call} />
}

/** Regex scripts and every section a plugin adds; the card's book has its own tab. */
function ExtraTab({ store, call }: CardTabProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SlotOutlet slot={cardEditorSections} props={{ store, call }} except={[CARD_LOREBOOK_SECTION]} />
    </div>
  )
}

/** The built-in tabs' panels, registered lazily (`cardTabsRegister.tsx`). */
export const CARD_TAB_PANELS = {
  definition: DefinitionTab,
  greetings: GreetingsTab,
  metadata: MetadataTab,
  lorebook: LorebookTab,
  notes: NotesTab,
  extra: ExtraTab
}

/** The card's tabs, as registered, in order. `initial`: the tab id to open first. */
export function CardEditor({
  store,
  call,
  layout = "page",
  initial = CARD_TAB_DEFINITION,
  onOpenBook,
  header,
  saveControls,
  reveal = false
}: {
  store: EditorStore
  call: Caller
  layout?: CardTabProps["layout"]
  initial?: string
  onOpenBook?: (() => void) | undefined
  /** Brought into view as it opens: opened on a tab from elsewhere (Show the whole card). */
  reveal?: boolean
  /** Above the tabs' panels, under the tab row: nothing by default. */
  header?: ReactNode
  /**
   * The save cluster, at the end of the tab row, which then stays in sight while a field
   * further down is edited (the chat's character tab; DESIGN §10.1).
   */
  saveControls?: ReactNode
}) {
  const snapshot = useSyncExternalStore(cardEditorTabs.subscribe, cardEditorTabs.snapshot, cardEditorTabs.snapshot)
  const tabs = [...snapshot.entries].sort((a, b) => a.order - b.order)
  const [tab, setTab] = useState(initial)
  // Opened again on another tab (the panel's Lorebooks list opening this card's book): it decides.
  const [lastInitial, setLastInitial] = useState(initial)
  if (initial !== lastInitial) {
    setLastInitial(initial)
    setTab(initial)
  }
  // Opened again on a tab from elsewhere (Show the whole card): the tabs come into view.
  const root = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    const element = root.current
    const show = mounted.current || reveal
    mounted.current = true
    if (!show || !element) return
    // The tab's panel loads after this and the page grows: it's kept in view while it does,
    // until the user scrolls or a moment has passed.
    const scroll = () => element.scrollIntoView({ block: "start" })
    scroll()
    const observer = new ResizeObserver(scroll)
    observer.observe(element)
    const stop = () => observer.disconnect()
    const timer = setTimeout(stop, 1500)
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const
    for (const event of events) window.addEventListener(event, stop, { once: true, capture: true })
    return () => {
      clearTimeout(timer)
      stop()
      for (const event of events) window.removeEventListener(event, stop, { capture: true })
    }
  }, [lastInitial, reveal])
  // Search's Go to opens the tab that holds the field it goes to.
  const match = useContext(SearchNavigation)
  const [lastMatch, setLastMatch] = useState(match)
  if (match !== lastMatch) {
    setLastMatch(match)
    const holder = match && tabs.find((entry) => entry.holds?.(match.path))
    if (holder) setTab(holder.id)
  }
  const shown = tabs.some((entry) => entry.id === tab) ? tab : (tabs[0]?.id ?? "")
  if (tabs.length === 0) return null
  return (
    <div
      ref={root}
      data-card-tabs={layout}
      className="flex min-w-0 scroll-mt-[var(--preset-toolbar-height,1rem)] flex-col gap-4"
    >
      {header}
      <Tabs
        label="Card fields"
        value={shown}
        onValueChange={setTab}
        wrap={layout === "panel"}
        end={saveControls}
        rowClassName={saveControls ? "sticky -top-4 z-10 -mx-4 -mt-2 items-start! bg-surface px-4 pt-2" : ""}
        rowOverlay={saveControls ? "Sticky tabs and save row cover the fields scrolling under them" : undefined}
        tabs={tabs.map((entry) => ({
          value: entry.id,
          label: entry.label,
          description: entry.description,
          panel: (
            <div className="pt-3">
              <entry.component store={store} call={call} layout={layout} onOpenBook={onOpenBook} />
            </div>
          )
        }))}
      />
    </div>
  )
}
