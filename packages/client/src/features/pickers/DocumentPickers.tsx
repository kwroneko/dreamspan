// The editors' header switchers (owner, 2026-11-06: "we have an entire UI to switch prompt
// presets, it isn't being used, this is unusable with any large number of them"). Each kind
// switches with its complete picker, on the preset picker's pattern: a filter, the sorts, a
// muted line under each name, keyboard and pointer alike, only the rows in view mounted.
// Presets use the side panel's own picker (`preset.picker`), so the two can't drift apart;
// cards and personas the card lists' filter, sort and Include personas, each row with its
// portrait; lorebooks, notes and snippets a Name / Modified list. Each sort is an account choice
// on the server, as the preset lists' is. A kind with a way to make one ends its list with
// "New …". The bodies are registered slot entries (`card.picker`, `document.picker`), so a
// plugin can replace them.
import { useAtomValue } from "@effect/atom-react"
import type { CardSwitcherView, DocumentSort } from "@dreamspan/shared/chatApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useId, useRef, useState } from "react"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { browseCards, mixesPersonas, type CardBrowse } from "../characters/cardBrowse.tsx"
import { CardBrowseBar } from "../characters/CardBrowseBar.tsx"
import { shortAgo } from "../characters/cardRecency.ts"
import { formatAgo } from "../characters/data.ts"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import {
  type PickerBodyProps,
  PickerFooterButton,
  type PickerItem,
  PickerList,
  PickerPopover,
  PickerSearch
} from "./PickerParts.tsx"
import { PresetPickerPopover } from "./PresetPicker.tsx"
import { exactTime, fold } from "./presetList.ts"
import { useEditedPresetSelection } from "./presetSelection.ts"

/** A header switcher's trigger: the document's name with a chevron, the header's own look. */
const headerSwitcherClass =
  "flex min-h-9 w-full max-w-controls min-w-0 items-center justify-between gap-2 rounded-md border border-transparent px-1 text-left text-base text-text outline-none select-none hover:bg-surface-raised focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 data-popup-open:bg-surface-raised sm:text-sm"

function HeaderTrigger({ text }: { text: string }) {
  return (
    <>
      {/* On a phone the name takes a second line before it is cut: a short one always shows whole. */}
      <span className="min-w-0 max-sm:line-clamp-2 max-sm:leading-tight max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere] sm:truncate">
        {text}
      </span>
      <Icon name="down" size={14} className="shrink-0 text-muted" />
    </>
  )
}

const lines = (items: ReadonlyArray<string>): ReactNode => (
  <span className="flex flex-col">
    {items.map((line) => (
      <span key={line}>{line}</span>
    ))}
  </span>
)

/**
 * Several ticked at once (attaching items to a workshop's message): choosing a row toggles it and
 * the list stays open; `rowHint` says what choosing it does there.
 */
export interface PickerTicks {
  readonly ticked: (value: RefId) => boolean
  readonly toggle: (value: RefId) => void
  readonly rowHint: (value: RefId) => string
}

/** A document a header switcher offers: a library entry, or a chat's note or snippet. */
export interface DocumentChoice {
  readonly value: RefId
  readonly label: string
  readonly subtitle?: string | undefined
  /** When it was last edited; without it the list only sorts by name. */
  readonly updatedAt?: number | undefined
}

export interface DocumentPickerProps extends PickerBodyProps {
  /** "lorebook", "note", "snippet": what the rows are. */
  readonly subject: string
  readonly choices: ReadonlyArray<DocumentChoice>
  readonly value: RefId
  readonly onChoose: (value: RefId) => void
  /** The row at the end of the list making a new one, where the kind has a way to make one. */
  readonly create?: NewDocument | undefined
  readonly ticks?: PickerTicks | undefined
}

/** "New card…", "New snippet": what the row says, what it makes, and making it. */
export interface NewDocument {
  readonly label: string
  readonly hint: string
  /** Called once the popover has closed; a dialog it opens outlives the popover. */
  readonly start: () => void
}

/** The kind's "New …" row under its list, as the preset picker's "New preset…". */
function NewRow({ create, onChosen }: { create: NewDocument | undefined; onChosen: () => void }) {
  if (!create) return null
  return (
    <PickerFooterButton
      hint={create.hint}
      icon="plus"
      onClick={() => {
        onChosen()
        create.start()
      }}
    >
      {create.label}
    </PickerFooterButton>
  )
}

/** The registered lorebook, note and snippet switcher body (`document.picker`). */
export const documentPickers = defineSlot<DocumentPickerProps>("document.picker")

const DOCUMENT_VIEWS: ReadonlyArray<{ value: DocumentSort; label: string; description: string }> = [
  { value: "name", label: "Name", description: "Sort by name, A to Z" },
  { value: "modified", label: "Modified", description: "Sort by when each was last edited, latest first" }
]

/** Which account choice holds each kind's sort (`settings`, as the preset lists' does). */
const SORT_KEYS = { lorebook: "lorebookSort", note: "noteSort", snippet: "snippetSort" } as const

/** A list's sort, remembered per account for each kind, on every device. */
function useRememberedView(subject: string) {
  const { prefs, change } = useViewPrefs()
  const key = (SORT_KEYS as Record<string, (typeof SORT_KEYS)[keyof typeof SORT_KEYS] | undefined>)[subject]
  const [unsaved, setUnsaved] = useState<DocumentSort>("name")
  const view = key ? prefs[key] : unsaved
  const set = (next: DocumentSort) => {
    if (next === view) return
    if (key) void change({ [key]: next })
    else setUnsaved(next)
  }
  return [view, set] as const
}

const byName = (a: DocumentChoice, b: DocumentChoice) =>
  a.label.localeCompare(b.label) || (a.subtitle ?? "").localeCompare(b.subtitle ?? "") || a.value.localeCompare(b.value)

export function DocumentPicker({
  subject,
  choices,
  value,
  onChoose,
  create,
  onChosen,
  focus,
  focusRef,
  ticks
}: DocumentPickerProps) {
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const [stored, setView] = useRememberedView(subject)
  const dated = choices.some((choice) => choice.updatedAt !== undefined)
  const view = dated ? stored : "name"
  const listId = useId()
  const q = fold(query.trim())
  const shown = choices
    .filter((choice) => q === "" || fold(`${choice.label} ${choice.subtitle ?? ""}`).includes(q))
    .sort(
      view === "modified" ? (a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || byName(a, b) : byName
    )
  const items = shown.map((choice): PickerItem => ({
    value: choice.value,
    label: choice.label,
    ...(choice.subtitle || choice.updatedAt !== undefined
      ? {
          detail: [choice.subtitle, choice.updatedAt === undefined ? "" : `edited ${formatAgo(choice.updatedAt)}`]
            .filter(Boolean)
            .join(" · ")
        }
      : {}),
    tooltip: lines([
      ticks
        ? ticks.rowHint(choice.value)
        : choice.value === value
          ? "Shown in this editor"
          : `Opens this ${subject} in this editor`,
      ...(choice.updatedAt === undefined ? [] : [`Edited ${exactTime(choice.updatedAt)}`])
    ])
  }))
  return (
    <>
      <PickerSearch
        label={`Find a ${subject}`}
        placeholder="Find by name"
        value={query}
        onChange={setQuery}
        inputRef={focus === "search" ? focusRef : search}
        controls={listId}
      />
      {dated && (
        <Segmented<DocumentSort>
          label={`Sort ${subject}s`}
          value={view}
          onValueChange={setView}
          options={DOCUMENT_VIEWS}
        />
      )}
      <PickerList
        id={listId}
        title={`${subject[0]!.toUpperCase()}${subject.slice(1)}s`}
        items={items}
        value={value}
        ticked={ticks ? (next) => ticks.ticked(next as RefId) : undefined}
        onChoose={(next) => {
          if (ticks) return ticks.toggle(next as RefId)
          onChosen()
          if (next !== value) onChoose(next as RefId)
        }}
        focusRef={focus === "current" ? focusRef : undefined}
        fallbackFocus={focus === "search" ? focusRef : search}
        empty={choices.length === 0 ? `No ${subject}s yet.` : `Nothing is called “${query.trim()}”.`}
      />
      <NewRow create={create} onChosen={onChosen} />
    </>
  )
}

export interface CardPickerProps extends PickerBodyProps {
  readonly value: RefId
  /** The card edited is in the persona folder: the list opens on Personas. */
  readonly persona: boolean
  readonly onChoose: (value: RefId) => void
  /** "New card…" at the end of the list. */
  readonly create?: NewDocument | undefined
  readonly createPersona?: NewDocument | undefined
  /** Lists personas alone, with no filter to change it: for choosing who the user is. */
  readonly personasOnly?: boolean | undefined
  /** A row's first tooltip line where choosing does something else than opening it in an editor. */
  readonly rowHint?: ((card: { readonly persona: boolean; readonly current: boolean }) => string) | undefined
  readonly ticks?: PickerTicks | undefined
}

/** The registered card and persona switcher body (`card.picker`). */
export const cardPickers = defineSlot<CardPickerProps>("card.picker")

/** The muted line under a card: its version, and the date its sort orders by. */
const cardLine = (
  card: {
    readonly card: { readonly subtitle: string; readonly chats: number }
    readonly createdAt: number
    readonly addedAt: number
    readonly recentAt: number | null
  },
  sort: CardBrowse["sort"]
) =>
  [
    card.card.subtitle,
    sort === "recent"
      ? card.recentAt === null
        ? "no chats yet"
        : `last chat ${shortAgo(card.recentAt)}`
      : sort === "created"
        ? `created ${shortAgo(card.createdAt)}`
        : sort === "added"
          ? `added ${shortAgo(card.addedAt)}`
          : card.card.chats === 1
            ? "1 chat"
            : `${card.card.chats.toLocaleString()} chats`
  ]
    .filter(Boolean)
    .join(" · ")

/**
 * The switcher's sort, direction and Include personas, per account on every device, as the
 * preset lists' sort is. A new sort starts its own way round, as the card lists' does.
 */
function useCardSwitcherView() {
  const { prefs, change } = useViewPrefs()
  const view = prefs.cardSwitcher
  const update = (next: Partial<CardSwitcherView>) => {
    const merged: CardSwitcherView = {
      ...view,
      ...(next.sort !== undefined && next.sort !== view.sort ? { reversed: false } : {}),
      ...next
    }
    if (merged.sort !== view.sort || merged.reversed !== view.reversed || merged.withPersonas !== view.withPersonas)
      void change({ cardSwitcher: merged })
  }
  return [view, update] as const
}

/** A card row's portrait, as the speaker switcher's rows show theirs. */
const CARD_ROW_SIZE = 64

export function CardPicker({
  value,
  persona,
  onChoose,
  create,
  createPersona,
  onChosen,
  focus,
  focusRef,
  personasOnly = false,
  rowHint,
  ticks
}: CardPickerProps) {
  const shell = useAtomValue(shellAtom)
  const [remembered, update] = useCardSwitcherView()
  const [filter, setFilter] = useState<CardBrowse["filter"]>(persona || personasOnly ? "personas" : "all")
  const browse: CardBrowse = { ...remembered, filter, grouped: false }
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const data = AsyncResult.isSuccess(shell) ? shell.value : null
  const marked = mixesPersonas(browse)
  const items = (data ? browseCards(browsable(data), browse, query) : []).map((card): PickerItem => ({
    value: card.card.refId,
    label: card.card.label,
    detail: cardLine(card, browse.sort),
    leading: (
      <Avatar
        id={card.card.entityId}
        name={card.card.name}
        mediaId={card.card.avatarMediaId}
        crop={card.card.avatarCrop}
        size="md"
      />
    ),
    ...(marked && card.persona ? { badge: <PersonaBadge /> } : {}),
    tooltip: lines([
      ticks
        ? ticks.rowHint(card.card.refId)
        : rowHint
          ? rowHint({ persona: card.persona, current: card.card.refId === value })
          : card.card.refId === value
            ? "Shown in this editor"
            : `Opens this ${card.persona ? "persona" : "card"} in this editor`,
      `Created ${exactTime(card.createdAt)}`,
      card.recentAt === null ? "In no chat yet" : `Last chat ${exactTime(card.recentAt)}`
    ])
  }))
  return (
    <>
      <PickerSearch
        label="Find a card"
        placeholder="Find by name or version"
        value={query}
        onChange={setQuery}
        inputRef={focus === "search" ? focusRef : search}
        controls={listId}
      />
      {data && !personasOnly && (
        <CardBrowseBar
          data={data}
          browse={browse}
          includePersonas
          onChange={({ filter: next, ...rest }) => {
            if (next !== undefined) setFilter(next)
            if (Object.keys(rest).length > 0) update(rest)
          }}
        />
      )}
      <PickerList
        id={listId}
        title={filter === "personas" ? "Personas" : "Cards"}
        items={items}
        rowSize={CARD_ROW_SIZE}
        value={value}
        ticked={ticks ? (next) => ticks.ticked(next as RefId) : undefined}
        onChoose={(next) => {
          if (ticks) return ticks.toggle(next as RefId)
          onChosen()
          if (next !== value) onChoose(next as RefId)
        }}
        focusRef={focus === "current" ? focusRef : undefined}
        fallbackFocus={focus === "search" ? focusRef : search}
        empty={
          data === null
            ? "Loading the cards…"
            : query.trim()
              ? `Nothing is called “${query.trim()}”.`
              : "No cards here."
        }
      />
      <NewRow create={filter === "personas" ? (createPersona ?? create) : create} onChosen={onChosen} />
    </>
  )
}

/**
 * The header switcher of an editor: the document's name, opening its kind's picker. Choosing
 * calls `open` with the other document; the host navigates as leaving through the library would.
 */
export function HeaderSwitcher({
  kind,
  subject,
  value,
  label,
  choices,
  persona = false,
  create,
  createPersona,
  open
}: {
  kind: "preset" | "card" | "document"
  /** "preset", "card", "persona", "lorebook", "note", "snippet". */
  subject: string
  value: RefId
  label: string
  /** The documents a `document` switcher offers. */
  choices?: ReadonlyArray<DocumentChoice>
  persona?: boolean
  /** "New …" at the end of a card or document list (presets have their own). */
  create?: NewDocument | undefined
  createPersona?: NewDocument | undefined
  open: (refId: RefId) => void
}) {
  const hint = `Switches to another ${subject} in this editor.`
  const triggerLabel = `Switch ${subject}`
  if (kind === "preset") return <PresetHeaderSwitcher value={value} label={label} open={open} hint={hint} />
  return (
    <PickerPopover
      title={`${subject[0]!.toUpperCase()}${subject.slice(1)}`}
      trigger={<HeaderTrigger text={label} />}
      triggerLabel={triggerLabel}
      triggerClassName={headerSwitcherClass}
      hint={hint}
      side="bottom"
    >
      {(body) =>
        kind === "card" ? (
          <SlotOutlet slot={cardPickers} props={{ ...body, value, persona, onChoose: open, create, createPersona }} />
        ) : (
          <SlotOutlet
            slot={documentPickers}
            props={{ ...body, subject, choices: choices ?? [], value, onChoose: open, create }}
          />
        )
      }
    </PickerPopover>
  )
}

function PresetHeaderSwitcher({
  value,
  label,
  open,
  hint
}: {
  value: RefId
  label: string
  open: (refId: RefId) => void
  hint: string
}) {
  const selection = useEditedPresetSelection(value, label, open)
  return (
    <PresetPickerPopover
      place="header"
      selection={selection}
      side="bottom"
      triggerClassName={headerSwitcherClass}
      triggerLabel="Switch preset"
      hint={hint}
      trigger={<HeaderTrigger text={selection.current?.archivedAt != null ? `${label} (archived)` : label} />}
    />
  )
}
