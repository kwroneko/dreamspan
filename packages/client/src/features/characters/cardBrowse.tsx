// What lists characters, in one set of parts: the filter (All, With chats, Never used,
// Favourites, Groups, each with its count), the sort with its direction, the date a date sort
// orders by, the favourite star and the grid of tiles. The home grid, the left panel's grid and
// Start a chat use them; each place keeps its own sort and direction (`useCardBrowse(place)`),
// remembered per account in this browser, since a narrow panel and the home page are used
// differently. The filter starts at All on each visit, as it did, so coming back never hides
// the characters behind a filter chosen last time.
import { useState } from "react"
import { useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuCheckboxItem } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { type CardSort, shortAgo, sortCards, sortDate } from "./cardRecency.ts"
import type { ShellLibrary } from "./shellData.tsx"

type ShellCard = ShellLibrary["cards"][number]
type CardFilter = "all" | "used" | "unused" | "favourites" | "groups"
export interface CardBrowse {
  readonly filter: CardFilter
  readonly sort: CardSort
  /** The sort the other way round from its own (dates newest first, names A to Z). */
  readonly reversed: boolean
}
const DEFAULT: CardBrowse = { filter: "all", sort: "recent", reversed: false }
const FILTERS = ["all", "used", "unused", "favourites", "groups"] as const
const SORTS = ["recent", "created", "added", "name"] as const

const read = (key: string): CardBrowse => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Record<keyof CardBrowse, unknown>>
    return {
      filter: DEFAULT.filter,
      sort: SORTS.find((s) => s === stored.sort) ?? DEFAULT.sort,
      reversed: stored.reversed === true
    }
  } catch {
    return DEFAULT
  }
}

/** A place's filter, and its sort remembered per account in this browser. A new sort starts its own way round. */
export function useCardBrowse(place: string) {
  const key = `rp.cards.${place}.${useSession().user.id}`
  const [state, setState] = useState<CardBrowse>(() => read(key))
  const update = (change: Partial<CardBrowse>) => {
    const next = {
      ...state,
      ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
      ...change
    }
    setState(next)
    try {
      localStorage.setItem(key, JSON.stringify({ sort: next.sort, reversed: next.reversed }))
    } catch {
      /* Not remembered, still applied. */
    }
  }
  return [state, update] as const
}

/** By name, in-chat name or version, ignoring case; `needle` already lowercased and trimmed. */
const matchesName = (c: ShellCard, needle: string) =>
  [c.card.label, c.card.name, c.card.subtitle].some((n) => n.toLowerCase().includes(needle))

const inFilter = (c: ShellCard, filter: CardFilter) =>
  filter === "used"
    ? c.card.chats > 0
    : filter === "unused"
      ? c.card.chats === 0
      : filter === "favourites"
        ? c.favourite
        : true

/** The characters a place shows: its filter and the search, in its order. */
export const browseCards = (cards: ReadonlyArray<ShellCard>, browse: CardBrowse, search: string) => {
  const needle = search.trim().toLowerCase()
  return sortCards(
    cards.filter((c) => inFilter(c, browse.filter) && matchesName(c, needle)),
    browse.sort,
    browse.reversed
  )
}

/** Each filter's count over all the characters, whatever the search: what choosing it would show without one. */
const filterCounts = (cards: ReadonlyArray<ShellCard>) => ({
  all: cards.length,
  used: cards.filter((c) => c.card.chats > 0).length,
  unused: cards.filter((c) => c.card.chats === 0).length,
  favourites: cards.filter((c) => c.favourite).length
})

const FILTER_LABELS: Record<CardFilter, string> = {
  all: "All",
  used: "With chats",
  unused: "Never used",
  favourites: "Favourites",
  groups: "Groups"
}

/**
 * The filter, each choice with its count, muted. `groups`: the Groups count (null while it's
 * read); left out, there's no Groups choice. `compact` is a picker, for a narrow panel.
 */
export function CardFilterControl({
  value,
  onChange,
  cards,
  groups,
  compact = false
}: {
  value: CardFilter
  onChange: (filter: CardFilter) => void
  cards: ReadonlyArray<ShellCard>
  groups?: number | null
  compact?: boolean
}) {
  const counts = filterCounts(cards)
  const options = FILTERS.filter((f) => f !== "groups" || groups !== undefined)
  const count = (f: CardFilter) => (f === "groups" ? (groups ?? null) : counts[f])
  const shown = options.includes(value) ? value : "all"
  if (compact)
    return (
      <Select<CardFilter>
        ariaLabel="Show"
        className="h-8!"
        value={shown}
        onValueChange={onChange}
        items={options.map((f) => ({
          value: f,
          label: `${FILTER_LABELS[f]} · ${count(f)?.toLocaleString() ?? "…"}`
        }))}
      />
    )
  return (
    <Segmented
      wrap
      label="Show"
      value={shown}
      onValueChange={onChange}
      options={options.map((f) => ({
        value: f,
        label: (
          <>
            {FILTER_LABELS[f]}
            {/* Seen, not part of the choice's name: "Favourites", not "Favourites 2". */}
            <span aria-hidden="true" className="font-normal text-muted tabular-nums">
              {count(f)?.toLocaleString() ?? "…"}
            </span>
          </>
        )
      }))}
    />
  )
}

const SORT_LABELS: Record<CardSort, { label: string; hint: string }> = {
  recent: { label: "Recent", hint: "By the latest message in any of its chats; characters never used come last" },
  created: {
    label: "Created",
    hint: "By when the card was made: for a SillyTavern import, the date ST gives it (its create_date); otherwise when it was added here"
  },
  added: { label: "Added", hint: "By when it came into this app, imported or written here" },
  name: { label: "Name", hint: "By name" }
}

/** What a sort orders by: dates, names or counts. */
export type SortOrder = "date" | "name" | "count"
const ORDER_NAMES: Record<SortOrder, readonly [string, string]> = {
  date: ["Newest first", "Oldest first"],
  name: ["A to Z", "Z to A"],
  count: ["Most first", "Fewest first"]
}
/** "Newest first", "A to Z" or "Most first"; `reversed`, the other way round. */
const orderName = (order: SortOrder, reversed: boolean) => ORDER_NAMES[order][reversed ? 1 : 0]

/**
 * A sort's direction: newest first or oldest, A to Z or Z to A. Every character surface's sort
 * has it beside its choice (the library's list too).
 */
export function SortDirection({
  order: kind,
  reversed,
  onToggle
}: {
  order: SortOrder
  reversed: boolean
  onToggle: () => void
}) {
  const order = orderName(kind, reversed)
  return (
    <IconButton
      label={`Order: ${order}`}
      hint={`${order}. Click for ${orderName(kind, !reversed).toLowerCase()}`}
      icon={reversed ? "sortUp" : "sortDown"}
      onClick={onToggle}
    />
  )
}

/** The sort choice and its direction. `compact`: a small menu button, for a narrow panel. */
export function CardSortControl({
  sort,
  reversed,
  onChange,
  compact = false,
  label = "Sort by"
}: {
  sort: CardSort
  reversed: boolean
  onChange: (change: Partial<CardBrowse>) => void
  compact?: boolean
  label?: string
}) {
  const direction = (
    <SortDirection
      order={sort === "name" ? "name" : "date"}
      reversed={reversed}
      onToggle={() => onChange({ reversed: !reversed })}
    />
  )
  return (
    <div className="flex shrink-0 items-center gap-1">
      {compact ? (
        <Menu
          label={label}
          align="start"
          trigger={
            <Button variant="ghost" className="h-8 gap-1 px-2" aria-label={`${label}: ${SORT_LABELS[sort].label}`}>
              {SORT_LABELS[sort].label}
              <Icon name="down" />
            </Button>
          }
        >
          {SORTS.map((s) => (
            <MenuCheckboxItem key={s} checked={s === sort} onCheckedChange={() => onChange({ sort: s })}>
              <span className="flex flex-col">
                <span>{SORT_LABELS[s].label}</span>
                <span className="text-xs text-muted">{SORT_LABELS[s].hint}</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </Menu>
      ) : (
        <Segmented
          label={label}
          value={sort}
          onValueChange={(s) => onChange({ sort: s })}
          options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s].label, description: SORT_LABELS[s].hint }))}
        />
      )}
      {direction}
    </div>
  )
}

const DATE_KINDS: Record<Exclude<CardSort, "name">, string> = {
  recent: "Last message",
  created: "Created",
  added: "Added to this app"
}

/**
 * The date a date sort orders by, short, at the end of a tile's or row's last line; the full
 * date and what it is in its tooltip. Nothing for Name, or a Recent with no chat.
 */
export function SortDate({ card, sort }: { card: ShellCard; sort: CardSort }) {
  const at = sortDate(card, sort)
  if (at === null || sort === "name") return null
  const full = `${DATE_KINDS[sort]}: ${new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
  return (
    <Tooltip label={full}>
      <span data-sort-date className="min-w-0 truncate text-right tabular-nums" aria-label={full}>
        {shortAgo(at)}
      </span>
    </Tooltip>
  )
}

/** The favourite star: a toggle beside the card's name or on its tile; it never opens the card. */
export function FavouriteStar({ card, className = "" }: { card: ShellCard; className?: string }) {
  const action = useAction()
  // Shown at once, until the shell's read says the same.
  const [shown, setShown] = useState<boolean | null>(null)
  if (shown !== null && shown === card.favourite && !action.pending) setShown(null)
  const on = shown ?? card.favourite
  const name = card.card.label
  return (
    <IconButton
      label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      hint={on ? "A favourite: click to remove" : "Add to favourites"}
      icon="star"
      filled={on}
      aria-pressed={on}
      className={`${on ? "text-accent!" : ""} ${className}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setShown(!on)
        void action
          .run((client) => client("SetCardFavourite", { entityId: card.card.entityId, favourite: !on }), ["favourites"])
          .then((outcome) => {
            if (!outcome.ok) setShown(null)
          })
      }}
    />
  )
}
