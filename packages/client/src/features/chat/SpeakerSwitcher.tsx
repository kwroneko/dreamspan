// The composer's speaker, always visible; it opens the chat's cast, the persona and the cards
// in the chat (DESIGN §2.2: to speak as another card, add it to the chat first), with a search
// field on top, focused as it opens: typing filters by name, the arrow keys move through
// what's left, Enter picks, Escape closes. With nothing typed, the speakers used last come
// first, then the cast. The same switcher picks the persona (who `{{user}}` is) from
// Members / Personas / All cards, opening on Personas: a library of hundreds of cards is
// filtered in memory and only the first rows are drawn.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { type KeyboardEvent, memo, useEffect, useId, useMemo, useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Input } from "../../ui/Field.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { nameOf, useCast } from "./cast.ts"
import { ChevronIcon } from "./icons.tsx"
import type { Outcome } from "./session.ts"

type SwitcherTab = "members" | "personas" | "all"

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()

/**
 * The cards matching `query` by name or library label, those whose name starts with it
 * first; with no query, the recent speakers, then the members, then the rest, as given.
 */
const ranked = (
  cards: ReadonlyArray<CastCard>,
  query: string,
  recent: ReadonlyArray<EntityId>,
  members: ReadonlyArray<EntityId>
): Array<CastCard> => {
  const rank = (card: CastCard) => {
    const r = recent.indexOf(card.entityId)
    if (r >= 0) return r
    const m = members.indexOf(card.entityId)
    return m >= 0 ? recent.length + m : Number.MAX_SAFE_INTEGER
  }
  const q = fold(query.trim())
  const scored: Array<{ card: CastCard; first: number; rank: number; index: number }> = []
  cards.forEach((card, index) => {
    const name = fold(card.name)
    let first = 0
    if (q !== "") {
      if (name.startsWith(q)) first = 0
      else if (name.includes(q) || fold(card.subtitle ?? "").includes(q)) first = 1
      else return
    }
    scored.push({ card, first, rank: rank(card), index })
  })
  scored.sort((a, b) => a.first - b.first || a.rank - b.rank || a.index - b.index)
  return scored.map((s) => s.card)
}

function CardOptions({
  id,
  cards,
  active,
  current,
  currentLabel,
  members,
  empty,
  onActive,
  onPick
}: {
  id: string
  cards: ReadonlyArray<CastCard>
  active: number
  current: EntityId | null
  currentLabel: string
  /** The chat's members, when picking a card that isn't one makes it join; null when none can join. */
  members: ReadonlySet<EntityId> | null
  empty: string
  onActive: (index: number) => void
  onPick: (card: CastCard) => void
}) {
  "use no memo"
  const list = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => list.current,
    estimateSize: () => 44,
    overscan: 4,
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range)
      return active < 0 || active >= cards.length || visible.includes(active)
        ? visible
        : [...visible, active].sort((a, b) => a - b)
    }
  })
  useEffect(() => {
    if (cards.length > 0) virtualizer.scrollToIndex(active, { align: "auto" })
  }, [active, cards, virtualizer])
  if (cards.length === 0) return <p className="px-1 py-2 text-sm text-muted">{empty}</p>
  return (
    <div ref={list} id={id} role="listbox" aria-label="Cards" className="max-h-64 overflow-y-auto">
      <div className="relative" style={{ height: cards.length * 44 }}>
        {virtualizer.getVirtualItems().map((item) => {
          const index = item.index
          const card = cards[index]!
          return (
            <div
              key={card.entityId}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-label={card.name}
              aria-selected={index === active}
              aria-current={card.entityId === current || undefined}
              aria-posinset={index + 1}
              aria-setsize={cards.length}
              // The pointer picks without taking focus from the search field.
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => index !== active && onActive(index)}
              onClick={() => onPick(card)}
              className="absolute top-0 left-0 flex h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-[current]:font-medium aria-selected:bg-surface-raised aria-selected:ring-1 aria-selected:ring-border"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <Avatar id={card.entityId} name={card.name} mediaId={card.avatarMediaId} size="md" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{card.name}</span>
                {card.subtitle && <span className="truncate text-xs text-muted">{card.subtitle}</span>}
              </span>
              {members !== null && !members.has(card.entityId) && (
                <span className="shrink-0 text-xs text-muted">joins the chat</span>
              )}
              {card.entityId === current && <Badge>{currentLabel}</Badge>}
              {card.persona && <Badge>persona</Badge>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const SpeakerSwitcher = memo(function SpeakerSwitcher({
  listCards,
  speaker,
  recent,
  onPick,
  persona = false,
  pending = false,
  onNone
}: {
  /** The library's cards, which the persona is picked from. */
  listCards?: () => Promise<Outcome<ReadonlyArray<CastCard>>>
  /** The card speaking, or with `persona`, the one the user plays. */
  speaker: EntityId | null
  /** The speakers of the latest messages, most recent first: listed first. */
  recent: ReadonlyArray<EntityId>
  onPick: (card: CastCard) => void
  /**
   * Picks the persona instead (DESIGN §2.2: who `{{user}}` is), from the library: it opens on
   * Personas every time.
   */
  persona?: boolean
  /** A chat not made yet: there are no members to join. */
  pending?: boolean
  /** Offered as "No persona". */
  onNone?: () => void
}) {
  const view = useCast()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SwitcherTab>("personas")
  const [all, setAll] = useState<ReadonlyArray<CastCard> | null>(null)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [names, setNames] = useState<ReadonlyMap<EntityId, CastCard>>(new Map())
  const name =
    nameOf(view, speaker) ?? (speaker ? names.get(speaker)?.name : undefined) ?? (persona ? "No persona" : "You")
  const participants = view.cast?.participants
  const played = view.cast?.playedByMe
  const memberIds = useMemo(() => participants ?? [], [participants])
  // Who can speak: the persona and the cards in the chat.
  const castIds = useMemo(() => [...new Set([...(played ?? []), ...(participants ?? [])])], [played, participants])
  const members = useMemo(
    () =>
      memberIds.flatMap((id) => {
        const card = view.cards.get(id)
        return card ? [card] : []
      }),
    [memberIds, view.cards]
  )
  // A card in the chat by the name the chat uses for it (its own version's, say).
  const cards = useMemo(() => (all ?? []).map((card) => view.cards.get(card.entityId) ?? card), [all, view.cards])
  const shown = useMemo(() => {
    const source = !persona
      ? castIds.flatMap((id) => view.cards.get(id) ?? [])
      : tab === "members"
        ? members
        : tab === "personas"
          ? cards.filter((card) => card.persona)
          : cards
    return ranked(source, query, recent, persona ? memberIds : castIds)
  }, [persona, castIds, view.cards, tab, members, cards, query, recent, memberIds])

  const openChange = (next: boolean) => {
    setOpen(next)
    setQuery("")
    setActive(0)
    if (!next || !persona) return
    setTab("personas")
    if (all === null && listCards)
      void listCards().then((result) => {
        setAll(result.ok ? result.value : [])
        if (result.ok) setNames(new Map(result.value.map((card) => [card.entityId, card])))
      })
  }
  const pick = (card: CastCard) => {
    openChange(false)
    onPick(card)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const last = Math.max(0, shown.length - 1)
      setActive((at) => (event.key === "ArrowDown" ? Math.min(at + 1, last) : Math.max(at - 1, 0)))
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      setActive(event.key === "Home" ? 0 : Math.max(0, shown.length - 1))
    } else if (event.key === "Escape") {
      // Closes at once, typed text or not (a search field would clear itself first).
      event.preventDefault()
      openChange(false)
    } else if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      const card = shown[active]
      if (card !== undefined) pick(card)
    }
  }
  const memberSet = useMemo(() => new Set(memberIds), [memberIds])
  const loading = persona && all === null && tab !== "members"
  const empty =
    query.trim() !== ""
      ? `No card's name has “${query.trim()}”.`
      : !persona
        ? "No one is in the chat yet. Add cards in the Cast tab."
        : tab === "members"
          ? "No one has joined yet."
          : loading
            ? "Loading…"
            : tab === "personas"
              ? "No cards in the persona folder."
              : "No cards yet."
  const options = (
    <CardOptions
      id={listId}
      cards={loading ? [] : shown}
      active={active}
      current={speaker}
      currentLabel={persona ? "your persona" : "speaking"}
      members={pending || !persona ? null : memberSet}
      empty={empty}
      onActive={setActive}
      onPick={pick}
    />
  )
  return (
    <Popover
      open={open}
      onOpenChange={openChange}
      initialFocus={search}
      triggerLabel={persona ? `Playing as ${name}. Change your persona` : `Speaking as ${name}. Change the speaker`}
      hint={persona ? `You play ${name} ({{user}}). Change who you play` : `Speaking as ${name}. Change who's speaking`}
      triggerClassName="inline-flex h-9 max-w-44 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised py-1 pr-2.5 pl-1 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus"
      title={persona ? "Your persona" : "Speak as"}
      trigger={
        <>
          {speaker !== null ? (
            <Avatar
              id={speaker}
              name={name}
              mediaId={(view.cards.get(speaker) ?? names.get(speaker))?.avatarMediaId ?? null}
              size="chip"
            />
          ) : (
            <span aria-hidden="true" className="size-1" />
          )}
          <span className="min-w-0 truncate">{name}</span>
          <ChevronIcon up />
        </>
      }
    >
      <Input
        ref={search}
        type="search"
        role="combobox"
        aria-label={persona ? "Find a card to play as" : "Find a card to speak as"}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown.length > 0 ? `${listId}-${active}` : undefined}
        placeholder="Find a card by name"
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        className="shrink-0"
      />
      {persona ? (
        <Tabs
          label="Cards to play as"
          value={tab}
          onValueChange={(next) => {
            setTab(next)
            setActive(0)
          }}
          onPointerActivate={() => search.current?.focus()}
          tabs={[
            ...(pending
              ? []
              : [{ value: "members" as const, label: "Members", panel: tab === "members" ? options : null }]),
            { value: "personas", label: "Personas", panel: tab === "personas" ? options : null },
            { value: "all", label: "All cards", panel: tab === "all" ? options : null }
          ]}
        />
      ) : (
        options
      )}
      {onNone && (
        <button
          type="button"
          onClick={() => {
            openChange(false)
            onNone()
          }}
          className="shrink-0 rounded-md px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
        >
          No persona
        </button>
      )}
    </Popover>
  )
})
