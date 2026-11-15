import { useCardGrouping } from "./cardGrouping.tsx"
// What lists characters, in one set of parts: the filter (All, With chats, Never used,
// Favourites, Personas, Groups, each with its count), Include personas, the sort with its direction, the date a date sort
// orders by, the favourite star and the grid of tiles. The home grid and the left panel's
// grid use them; each place keeps its own sort and direction (`useCardBrowse(place)`),
// remembered on the account, since a narrow panel and the home page are used
// differently. Home overlays this memory with its URL state (`useHomeBrowse`); elsewhere
// the filter starts at All on each visit.
import { useState } from "react"
import { useAction } from "../../actions.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuCheckboxItem } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { type CardSort, shortAgo, sortCards, sortDate } from "./cardRecency.ts"
import { CARD_FILTERS } from "./homeSearch.ts"
import type { ShellLibrary } from "./shellData.tsx"

type ShellCard = ShellLibrary["cards"][number]
type CardFilter = "all" | "used" | "unused" | "favourites" | "personas" | "groups" | "archived"
export interface CardBrowse {
  readonly filter: CardFilter
  readonly sort: CardSort
  /** The sort the other way round from its own (dates newest first, names A to Z). */
  readonly reversed: boolean
  /**
   * The persona folder's cards among the other filters' characters, marked (owner, 2026-11-02:
   * off by default). Personas alone are the `personas` filter, whatever this says.
   */
  readonly withPersonas: boolean
}
const FILTERS = CARD_FILTERS
const SORTS = ["recent", "created", "added", "name"] as const

/**
 * A place's filter, and its sort and Include personas remembered on the account.
 * A new sort starts its own way round.
 */
export function useCardBrowse(place: "sidebar" | "home" | "cast") {
  const { prefs, change: savePrefs, ready } = useViewPrefs()
  const key = ({ sidebar: "sidebarCards", home: "homeCards", cast: "castCards" } as const)[place]
  const [filter, setFilter] = useState<CardFilter>("all")
  const state: CardBrowse = { ...prefs[key], filter }
  const update = (change: Partial<CardBrowse>) => {
    const next = {
      ...state,
      ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
      ...change
    }
    setFilter(next.filter)
    if (next.sort !== state.sort || next.reversed !== state.reversed || next.withPersonas !== state.withPersonas)
      void savePrefs({ [key]: { sort: next.sort, reversed: next.reversed, withPersonas: next.withPersonas } })
  }
  return [state, update, ready] as const
}

/** By name, in-chat name or version, ignoring case; `needle` already lowercased and trimmed. */
const matchesName = (c: ShellCard, needle: string) =>
  [c.card.label, c.card.name, c.card.subtitle].some((n) => n.toLowerCase().includes(needle))

const inFilter = (c: ShellCard, filter: CardFilter) =>
  filter === "archived"
    ? c.archivedAt != null
    : c.archivedAt != null
      ? false
      : filter === "personas"
        ? c.persona
        : filter === "used"
          ? c.card.chats > 0
          : filter === "unused"
            ? c.card.chats === 0
            : filter === "favourites"
              ? c.favourite
              : true

/** Whether a filter's list mixes the persona folder's cards in with the characters (and so marks them). */
export const mixesPersonas = (browse: CardBrowse) =>
  browse.filter !== "personas" && (browse.filter === "archived" || browse.withPersonas)
/** The cards a filter considers: personas only under Personas or with Include personas. */
const considered = (cards: ReadonlyArray<ShellCard>, browse: Pick<CardBrowse, "filter" | "withPersonas">) =>
  browse.filter === "archived" || browse.filter === "personas" || browse.withPersonas
    ? cards
    : cards.filter((c) => !c.persona)

/** The characters a place shows: its filter and the search, in its order. */
export const browseCards = (cards: ReadonlyArray<ShellCard>, browse: CardBrowse, search: string) => {
  const needle = search.trim().toLowerCase()
  return sortCards(
    considered(cards, browse).filter((c) => inFilter(c, browse.filter) && matchesName(c, needle)),
    browse.sort,
    browse.reversed
  )
}

/** Each filter's count over all the characters, whatever the search: what choosing it would show without one. */
const filterCounts = (all: ReadonlyArray<ShellCard>, withPersonas: boolean) => {
  const live = all.filter((c) => c.archivedAt == null)
  const cards = withPersonas ? live : live.filter((c) => !c.persona)
  return {
    all: cards.length,
    used: cards.filter((c) => c.card.chats > 0).length,
    unused: cards.filter((c) => c.card.chats === 0).length,
    favourites: cards.filter((c) => c.favourite).length,
    personas: live.filter((c) => c.persona).length,
    archived: all.filter((c) => c.archivedAt != null).length
  }
}

const FILTER_HINTS: Record<CardFilter, string> = {
  all: "Shows cards outside the archive",
  used: "Shows cards with chats",
  unused: "Shows cards without chats",
  favourites: "Shows starred cards outside the archive",
  personas: "Shows the cards you play as",
  groups: "Shows chats with several characters",
  archived: "Shows archived cards, including personas"
}
const FILTER_LABELS: Record<CardFilter, string> = {
  all: "All",
  used: "With chats",
  unused: "Never used",
  favourites: "Favourites",
  personas: "Personas",
  groups: "Groups",
  archived: "Archived"
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
  withPersonas = false,
  compact = false,
  wrap = true,
  archived = false,
  sources = [],
  source = null,
  onSource
}: {
  value: CardFilter
  onChange: (filter: CardFilter) => void
  cards: ReadonlyArray<ShellCard>
  groups?: number | null
  /** Personas are included: the characters' counts count them too. */
  withPersonas?: boolean
  compact?: boolean
  /** Wraps onto more lines when narrow; off, the choices scroll sideways instead. */
  wrap?: boolean
  archived?: boolean
  /**
   * Card sources, after the filters and a divider (spec/CARD-SOURCES.md §3.2): a different
   * place, not a filter of the user's cards. `count` only once one is open (null: none to show).
   */
  sources?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly count: string | null }>
  /** The source shown instead of the filter's cards, or null. */
  source?: string | null
  onSource?: (id: string) => void
}) {
  const counts = filterCounts(cards, withPersonas)
  const options = FILTERS.filter((f) => (f !== "groups" || groups !== undefined) && (f !== "archived" || archived))
  const count = (f: CardFilter) => (f === "groups" ? (groups ?? null) : counts[f])
  type Choice = CardFilter | `src.${string}`
  const shown: Choice =
    source !== null && sources.some((s) => s.id === source) ? `src.${source}` : options.includes(value) ? value : "all"
  const choose = (choice: Choice) =>
    choice.startsWith("src.") ? onSource?.(choice.slice(4)) : onChange(choice as CardFilter)
  const sourceHint = (name: string) => `Shows cards on ${name}, a public card archive. Nothing is added to your cards.`
  if (compact)
    return (
      <Select<Choice>
        ariaLabel="Show"
        className="h-8! gap-1! px-2!"
        value={shown}
        onValueChange={choose}
        items={[
          ...options.map((f) => ({
            value: f as Choice,
            label: `${FILTER_LABELS[f]} · ${count(f)?.toLocaleString() ?? "…"}`,
            description: FILTER_HINTS[f]
          })),
          ...sources.map((s, index) => ({
            value: `src.${s.id}` as Choice,
            label: s.count === null ? s.name : `${s.name} · ${s.count}`,
            description: sourceHint(s.name),
            separatorBefore: index === 0
          }))
        ]}
      />
    )
  return (
    <Segmented<Choice>
      wrap={wrap}
      label="Show"
      inlineDescription={false}
      value={shown}
      onValueChange={choose}
      options={[
        ...options.map((f) => ({
          value: f as Choice,
          description: FILTER_HINTS[f],
          label: (
            <>
              {FILTER_LABELS[f]}
              {/* Seen, not part of the choice's name: "Favourites", not "Favourites 2". */}
              <span aria-hidden="true" className="font-normal text-muted tabular-nums">
                {count(f)?.toLocaleString() ?? "…"}
              </span>
            </>
          )
        })),
        ...sources.map((s, index) => ({
          value: `src.${s.id}` as Choice,
          description: sourceHint(s.name),
          separatorBefore: index === 0,
          label: (
            <>
              {s.name}
              {s.count !== null && (
                <span aria-hidden="true" className="font-normal text-muted tabular-nums">
                  {s.count}
                </span>
              )}
            </>
          )
        }))
      ]}
    />
  )
}

/**
 * Include personas: the persona folder's cards among the characters, marked. Only where a
 * filter lists characters (not Personas, not Groups). Under those two it stays in place but
 * invisible (visibility: hidden also drops it from the tab order and the accessibility tree), so
 * the controls around it don't shift.
 */
export function IncludePersonas({
  browse,
  onChange,
  disabledReason
}: {
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  /** Shown but unavailable (a card source lists no personas): why, on hover. */
  disabledReason?: string | undefined
}) {
  const hidden =
    disabledReason === undefined &&
    (browse.filter === "personas" || browse.filter === "groups" || browse.filter === "archived")
  const disabled = disabledReason !== undefined
  return (
    <IconButton
      label="Include personas"
      hint={disabledReason ?? (browse.withPersonas ? "Click to hide personas" : "Click to show personas")}
      icon={browse.withPersonas && !disabled ? "user" : "user-x"}
      aria-pressed={browse.withPersonas && !disabled}
      disabled={disabled}
      focusableWhenDisabled
      className={`${hidden ? "invisible" : ""} ${browse.withPersonas || disabled ? "" : "text-text!"} data-disabled:pointer-events-auto! data-disabled:opacity-50 aria-pressed:bg-surface-raised aria-pressed:text-accent`}
      onClick={() => onChange({ withPersonas: !browse.withPersonas })}
    />
  )
}

/**
 * Group forks: a card and the cards forked from it as one tile, which expands to them
 * (cardFamilies.ts). One choice for the account, off until chosen. Kept in place but invisible
 * where no cards are grouped (Groups), so the controls around it don't shift.
 */
export function GroupFamiliesToggle({ browse }: { browse: CardBrowse }) {
  const { prefs, change } = useViewPrefs()
  const on = prefs.cardFamilies
  return (
    <IconButton
      label="Group forks"
      hint={
        on
          ? "Click to list every card on its own"
          : "Click to show a card and its forks as one tile, which opens to list them"
      }
      icon="family"
      aria-pressed={on}
      data-group-families
      className={`${browse.filter === "groups" ? "invisible" : ""} ${on ? "" : "text-text!"} aria-pressed:bg-surface-raised aria-pressed:text-accent`}
      onClick={() => void change({ cardFamilies: !on })}
    />
  )
}

/** Whether a place's list groups families now: the account's choice, and no search (a search lists each card it finds). */
export const useGroupedFamilies = (search: string) => {
  const part = useCardGrouping()
  return useViewPrefs().prefs.cardFamilies && part !== undefined && search.trim() === ""
}

const SORT_LABELS: Record<CardSort, { label: string; hint: string }> = {
  recent: { label: "Recent", hint: "By the latest message in any of its chats; characters never used come last" },
  created: {
    label: "Created",
    hint: "By when the card was created"
  },
  added: {
    label: "Added",
    hint: "By when it was added; a folder import keeps the date it was added there"
  },
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
  onToggle,
  disabledReason
}: {
  order: SortOrder
  reversed: boolean
  onToggle: () => void
  /** The sort has one direction only: the button stays, disabled, saying so. */
  disabledReason?: string | undefined
}) {
  const order = orderName(kind, reversed)
  return (
    <IconButton
      label={`Order: ${order}`}
      hint={disabledReason ?? `Click to sort ${orderName(kind, !reversed).toLowerCase()}`}
      icon={reversed ? "sortUp" : "sortDown"}
      onClick={onToggle}
      {...(disabledReason === undefined
        ? {}
        : {
            disabled: true,
            focusableWhenDisabled: true,
            className: "data-disabled:pointer-events-auto! data-disabled:opacity-50"
          })}
    />
  )
}

/** The sort choice and its direction. `compact`: a small menu button, for a narrow panel. */
export function CardSortControl({
  sort,
  reversed,
  onChange,
  compact = false,
  label = "Sort by",
  className = ""
}: {
  sort: CardSort
  reversed: boolean
  onChange: (change: Partial<CardBrowse>) => void
  compact?: boolean
  label?: string
  className?: string
}) {
  const direction = (
    <SortDirection
      order={sort === "name" ? "name" : "date"}
      reversed={reversed}
      onToggle={() => onChange({ reversed: !reversed })}
    />
  )
  return (
    <div className={`flex shrink-0 items-center gap-1 ${className}`}>
      {compact ? (
        <Menu
          hint="Chooses how cards are sorted."
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
            <MenuCheckboxItem
              description={SORT_LABELS[s].hint}
              key={s}
              checked={s === sort}
              onCheckedChange={() => onChange({ sort: s })}
            >
              {SORT_LABELS[s].label}
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
  added: "Added"
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
      hint={on ? "Click to remove from favourites" : "Click to add to favourites"}
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
