// The editors' header switchers (owner, 2026-11-06: "we have an entire UI to switch prompt
// presets, it isn't being used, this is unusable with any large number of them"). Each kind
// switches with its complete picker, on the preset picker's pattern: a filter, the sorts, a
// muted line under each name, keyboard and pointer alike, only the rows in view mounted.
// Presets use the side panel's own picker (`preset.picker`), so the two can't drift apart;
// cards and personas the card lists' filter, sort and Include personas; lorebooks, notes and
// snippets a Name / Modified list. The bodies are registered slot entries (`card.picker`,
// `document.picker`), so a plugin can replace them.
import { useAtomValue } from "@effect/atom-react"
import type { RefId } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useId, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { browseCards, mixesPersonas, useCardBrowse, type CardBrowse } from "../characters/cardBrowse.tsx"
import { CardBrowseBar } from "../characters/CardBrowseBar.tsx"
import { shortAgo } from "../characters/cardRecency.ts"
import { formatAgo } from "../characters/data.ts"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import { type PickerBodyProps, type PickerItem, PickerList, PickerPopover, PickerSearch } from "./PickerParts.tsx"
import { PresetPickerPopover } from "./PresetPicker.tsx"
import { exactTime, fold } from "./presetList.ts"
import { useEditedPresetSelection } from "./presetSelection.ts"

/** A header switcher's trigger: the document's name with a chevron, the header's own look. */
const headerSwitcherClass =
  "flex h-9 w-full max-w-controls min-w-0 items-center justify-between gap-2 rounded-md border border-transparent px-1 text-left text-base text-text outline-none select-none hover:bg-surface-raised focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 data-popup-open:bg-surface-raised sm:text-sm"

function HeaderTrigger({ text }: { text: string }) {
  return (
    <>
      <span className="min-w-0 truncate">{text}</span>
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
}

/** The registered lorebook, note and snippet switcher body (`document.picker`). */
export const documentPickers = defineSlot<DocumentPickerProps>("document.picker")

type DocumentView = "name" | "modified"
const DOCUMENT_VIEWS: ReadonlyArray<{ value: DocumentView; label: string; description: string }> = [
  { value: "name", label: "Name", description: "Sort by name, A to Z" },
  { value: "modified", label: "Modified", description: "Sort by when each was last edited, latest first" }
]

/** A list's sort, remembered per account in this browser for each kind. */
function useRememberedView(subject: string) {
  const key = `rp.picker.${subject}.${useSession().user.id}`
  const [view, setView] = useState<DocumentView>(() => {
    try {
      return localStorage.getItem(key) === "modified" ? "modified" : "name"
    } catch {
      return "name"
    }
  })
  const change = (next: DocumentView) => {
    setView(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      /* Not remembered, still applied. */
    }
  }
  return [view, change] as const
}

const byName = (a: DocumentChoice, b: DocumentChoice) =>
  a.label.localeCompare(b.label) || (a.subtitle ?? "").localeCompare(b.subtitle ?? "") || a.value.localeCompare(b.value)

export function DocumentPicker({ subject, choices, value, onChoose, onChosen, focus, focusRef }: DocumentPickerProps) {
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
      choice.value === value ? "Shown in this editor" : `Opens this ${subject} in this editor`,
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
        <Segmented<DocumentView>
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
        onChoose={(next) => {
          onChosen()
          if (next !== value) onChoose(next as RefId)
        }}
        focusRef={focus === "current" ? focusRef : undefined}
        fallbackFocus={focus === "search" ? focusRef : search}
        empty={`Nothing is called “${query.trim()}”.`}
      />
    </>
  )
}

export interface CardPickerProps extends PickerBodyProps {
  readonly value: RefId
  /** The card edited is in the persona folder: the list opens on Personas. */
  readonly persona: boolean
  readonly onChoose: (value: RefId) => void
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

export function CardPicker({ value, persona, onChoose, onChosen, focus, focusRef }: CardPickerProps) {
  const shell = useAtomValue(shellAtom)
  const [remembered, update] = useCardBrowse("switcher")
  const [filter, setFilter] = useState<CardBrowse["filter"]>(persona ? "personas" : "all")
  const browse: CardBrowse = { ...remembered, filter }
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const data = AsyncResult.isSuccess(shell) ? shell.value : null
  const marked = mixesPersonas(browse)
  const items = (data ? browseCards(browsable(data), browse, query) : []).map((card): PickerItem => ({
    value: card.card.refId,
    label: card.card.label,
    detail: cardLine(card, browse.sort),
    ...(marked && card.persona ? { badge: <PersonaBadge /> } : {}),
    tooltip: lines([
      card.card.refId === value
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
      {data && (
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
        value={value}
        onChoose={(next) => {
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
          <SlotOutlet slot={cardPickers} props={{ ...body, value, persona, onChoose: open }} />
        ) : (
          <SlotOutlet
            slot={documentPickers}
            props={{ ...body, subject, choices: choices ?? [], value, onChoose: open }}
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
      selection={selection}
      side="bottom"
      triggerClassName={headerSwitcherClass}
      triggerLabel="Switch preset"
      hint={hint}
      trigger={<HeaderTrigger text={selection.current?.archivedAt != null ? `${label} (archived)` : label} />}
    />
  )
}
