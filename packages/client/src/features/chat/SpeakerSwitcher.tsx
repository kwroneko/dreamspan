// The composer's speaker, always visible; it opens the chat's cast, the persona and the cards
// in the chat (DESIGN §2.2: to speak as another card, add it to the chat first), with a search
// field on top, focused as it opens: typing filters by name, the arrow keys move through
// what's left, Enter picks, Escape closes. With nothing typed, the speakers used last come
// first, then the cast. At the composer it has a second section, Your persona, the persona
// folder with the current persona ticked; the same search filters both. The same switcher picks the persona (who `{{user}}` is) from
// Members / Personas / All cards, opening on Personas: a library of hundreds of cards is
// filtered in memory and only the first rows are drawn.
import { CardSurface } from "../cardForks/surfaces.tsx"
import { useDefaultPersona } from "../characters/defaultPersona.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { type KeyboardEvent, memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Input } from "../../ui/Field.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { nameOf, useCast } from "./cast.ts"
import { ChevronIcon } from "./icons.tsx"
import type { Outcome } from "./session.ts"

type SwitcherTab = "members" | "personas" | "all"

// A 48 px portrait plus the row's 6 px top and bottom padding.
const CARD_ROW_HEIGHT = 60

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
  played,
  members,
  empty,
  onActive,
  onPick,
  personaOnly
}: {
  personaOnly: boolean
  id: string
  cards: ReadonlyArray<CastCard>
  active: number
  current: EntityId | null
  currentLabel: string
  played: EntityId | null
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
    estimateSize: () => CARD_ROW_HEIGHT,
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
    <div ref={list} id={id} role="listbox" aria-label="Cards" className="max-h-64 overflow-y-auto p-2">
      <div className="relative" style={{ height: cards.length * CARD_ROW_HEIGHT }}>
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
              className="absolute top-0 left-0 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-[current]:font-medium aria-selected:bg-surface-raised aria-selected:ring-1 aria-selected:ring-border"
              style={{ height: CARD_ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              <Avatar
                id={card.entityId}
                name={card.name}
                mediaId={card.avatarMediaId}
                crop={card.avatarCrop}
                size="md"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{card.name}</span>
                {card.subtitle && <span className="truncate text-xs text-muted">{card.subtitle}</span>}
              </span>
              {/* Played as the persona, a character card joins the chat; a persona takes the
                  place of the one played until now, so it isn't said to add anyone. */}
              {members !== null && !members.has(card.entityId) && !card.persona && (
                <span className="shrink-0 text-xs text-muted">adds to this chat</span>
              )}
              {card.entityId === current && card.entityId !== played && <Badge>{currentLabel}</Badge>}
              {(card.entityId === played || (card.persona && !personaOnly)) && (
                <PersonaBadge played={card.entityId === played} />
              )}
              <CardSurface placement="persona-badge" entityId={card.entityId} />
              {card.persona && (
                <span onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                  <CardSurface placement="persona-menu" entityId={card.entityId} label={card.name} />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One row of the composer's sectioned list: a card, ticked when it's the current one. */
function SectionRow({
  id,
  card,
  index,
  active,
  current,
  played,
  onActive,
  onPick
}: {
  id: string
  card: CastCard
  index: number
  active: boolean
  current: boolean
  played: boolean
  onActive: (index: number) => void
  onPick: (card: CastCard) => void
}) {
  return (
    <div
      id={`${id}-${index}`}
      role="option"
      aria-label={card.name}
      aria-selected={active}
      aria-current={current || undefined}
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={() => !active && onActive(index)}
      onClick={() => onPick(card)}
      className="flex min-h-11 w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm aria-[current]:font-medium aria-selected:bg-surface-raised aria-selected:ring-1 aria-selected:ring-border"
    >
      <Avatar id={card.entityId} name={card.name} mediaId={card.avatarMediaId} crop={card.avatarCrop} size="md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="[overflow-wrap:anywhere]">{card.name}</span>
        {card.subtitle && <span className="truncate text-xs text-muted">{card.subtitle}</span>}
      </span>
      {(played || card.persona) && <PersonaBadge played={played} />}
      <CardSurface placement="persona-badge" entityId={card.entityId} />
      {card.persona && (
        <span onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <CardSurface placement="persona-menu" entityId={card.entityId} label={card.name} />
        </span>
      )}
      {current && <Icon name="check" size={16} className="text-accent" />}
    </div>
  )
}

/** The composer's persona section: who `{{user}}` is, picked from the persona folder. */
export interface PersonaSection {
  readonly current: EntityId | null
  readonly listCards: () => Promise<Outcome<ReadonlyArray<CastCard>>>
  readonly onPick: (card: CastCard) => void
}

export const SpeakerSwitcher = memo(function SpeakerSwitcher({
  listCards,
  speaker,
  recent,
  onPick,
  persona = false,
  pending = false,
  onNone,
  trigger,
  personas,
  onAddToChat,
  compact = false
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
  /** Its button's text in place of the chip ("Switch persona" where the name is already shown). */
  trigger?: ReactNode
  /** The composer's second section, "Your persona", under "Speak as"; one search filters both. */
  personas?: PersonaSection
  /** Offered when no one in the chat has the name searched for: adding a card is the Cast tab's. */
  onAddToChat?: () => void
  /** The trigger shows the portrait alone (the name is its label and tooltip). */
  compact?: boolean
}) {
  const view = useCast()
  const defaultPersona = useDefaultPersona()
  const defaultLabel = pending && persona && speaker !== null && speaker === defaultPersona ? " (default)" : ""
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SwitcherTab>("personas")
  const [all, setAll] = useState<ReadonlyArray<CastCard> | null>(null)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [names, setNames] = useState<ReadonlyMap<EntityId, CastCard>>(new Map())
  // Before the cast is read, "…" rather than a "You" that flashes before the real speaker.
  const name =
    nameOf(view, speaker) ??
    (speaker ? names.get(speaker)?.name : undefined) ??
    (persona ? "No persona" : view.cast === null && !pending ? "…" : "You")
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
  // The composer's persona section: the persona folder, the current persona first.
  const personaShown = useMemo(
    () =>
      personas === undefined
        ? []
        : ranked(
            cards.filter((card) => card.persona),
            query,
            personas.current === null ? [] : [personas.current],
            []
          ),
    [personas, cards, query]
  )
  // Arrow keys and Enter move through both sections as one list.
  const options = personas === undefined ? shown : [...shown, ...personaShown]

  const openChange = (next: boolean) => {
    setOpen(next)
    setQuery("")
    setActive(0)
    if (!next || !(persona || personas)) return
    setTab("personas")
    const list = personas?.listCards ?? listCards
    if (all === null && list)
      void list().then((result) => {
        setAll(result.ok ? result.value : [])
        if (result.ok) setNames(new Map(result.value.map((card) => [card.entityId, card])))
      })
  }
  const pickAt = (index: number) => {
    const card = options[index]
    if (card === undefined) return
    openChange(false)
    if (personas !== undefined && index >= shown.length) personas.onPick(card)
    else onPick(card)
  }
  const pick = (card: CastCard) => pickAt(shown.indexOf(card))
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const last = Math.max(0, options.length - 1)
      setActive((at) => (event.key === "ArrowDown" ? Math.min(at + 1, last) : Math.max(at - 1, 0)))
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      setActive(event.key === "Home" ? 0 : Math.max(0, options.length - 1))
    } else if (event.key === "Escape") {
      // Closes at once, typed text or not (a search field would clear itself first).
      event.preventDefault()
      openChange(false)
    } else if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      pickAt(active)
    }
  }
  const memberSet = useMemo(() => new Set(memberIds), [memberIds])
  const loading = (persona || personas !== undefined) && all === null && tab !== "members"
  const typed = query.trim()
  const empty =
    typed !== ""
      ? persona
        ? `No card's name has “${typed}”.`
        : `No one in this chat is called “${typed}”.`
      : !persona
        ? "No one is in the chat yet. Add cards in the Cast tab."
        : tab === "members"
          ? "No one has joined yet."
          : loading
            ? "Loading…"
            : tab === "personas"
              ? "No cards in the persona folder."
              : "No cards yet."
  const addToChat = onAddToChat && !persona && (
    <button
      type="button"
      onClick={() => {
        openChange(false)
        onAddToChat()
      }}
      className="rounded-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      Add to chat
    </button>
  )
  const list =
    personas !== undefined ? (
      <div
        id={listId}
        role="listbox"
        aria-label="Speak as, or your persona"
        className="flex min-h-0 flex-col overflow-y-auto p-2"
      >
        <div role="group" aria-label="Speak as" aria-describedby={`${listId}-speak-as`} className="flex flex-col">
          <p id={`${listId}-speak-as`} className="px-2 pb-1 text-xs text-muted">
            Who your next message is from: anyone in this chat.
          </p>
          {shown.length === 0 ? (
            <p className="flex flex-wrap gap-x-1.5 px-2 py-1.5 text-sm text-muted">
              <span>{empty}</span>
              {typed !== "" && addToChat && <span aria-hidden="true">·</span>}
              {typed !== "" && addToChat}
            </p>
          ) : (
            shown.map((card, index) => (
              <SectionRow
                key={card.entityId}
                id={listId}
                card={card}
                index={index}
                active={index === active}
                current={card.entityId === speaker}
                played={card.entityId === personas.current}
                onActive={setActive}
                onPick={() => pickAt(index)}
              />
            ))
          )}
        </div>
        <div
          role="group"
          aria-labelledby={`${listId}-personas`}
          aria-describedby={`${listId}-personas-about`}
          className="mt-2 flex flex-col border-t border-border pt-2"
        >
          <p id={`${listId}-personas`} className="px-2 text-sm font-semibold">
            Your persona
          </p>
          <p id={`${listId}-personas-about`} className="px-2 pb-1 text-xs text-muted">
            Who you are in this chat, {"{{user}}"}: it takes the place of the one you play now.
          </p>
          {personaShown.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted">
              {loading
                ? "Loading…"
                : typed !== ""
                  ? `No persona is called “${typed}”.`
                  : "No cards in the persona folder."}
            </p>
          ) : (
            personaShown.map((card, at) => (
              <SectionRow
                key={card.entityId}
                id={listId}
                card={card}
                index={shown.length + at}
                active={shown.length + at === active}
                current={card.entityId === personas.current}
                played={card.entityId === personas.current}
                onActive={setActive}
                onPick={() => pickAt(shown.length + at)}
              />
            ))
          )}
        </div>
      </div>
    ) : (
      <CardOptions
        personaOnly={persona && tab === "personas"}
        id={listId}
        cards={loading ? [] : shown}
        active={active}
        current={speaker}
        currentLabel={persona ? "your persona" : "speaking"}
        played={persona ? speaker : (view.cast?.playedByMe[0] ?? null)}
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
      // Two sections at the composer: room for the cast and the personas under it.
      wide={personas !== undefined}
      triggerLabel={
        persona ? `Playing as ${name}${defaultLabel}. Change your persona` : `Speaking as ${name}. Change the speaker`
      }
      hint={persona ? `You play ${name} ({{user}}). Change who you play` : `Speaking as ${name}. Change who's speaking`}
      triggerClassName={
        trigger
          ? buttonClass("secondary")
          : `inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised py-1 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus ${compact ? "pr-1.5 pl-1" : "max-w-44 pr-2.5 pl-1"}`
      }
      title={persona ? "Your persona" : "Speak as"}
      trigger={
        trigger ?? (
          <>
            {speaker !== null ? (
              <Avatar
                id={speaker}
                name={name}
                mediaId={(view.cards.get(speaker) ?? names.get(speaker))?.avatarMediaId ?? null}
                crop={(view.cards.get(speaker) ?? names.get(speaker))?.avatarCrop}
                size="chip"
              />
            ) : (
              <span aria-hidden="true" className="size-1" />
            )}
            {!compact && (
              <span className="min-w-0 truncate">
                {name}
                {defaultLabel}
              </span>
            )}
            <ChevronIcon up />
          </>
        )
      }
    >
      <Input
        ref={search}
        type="search"
        role="combobox"
        aria-label={
          persona
            ? "Find a card to play as"
            : personas
              ? "Find someone to speak as, or a persona"
              : "Find someone in this chat to speak as"
        }
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length > 0 ? `${listId}-${active}` : undefined}
        placeholder={persona ? "Find a card by name" : "Find by name"}
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
              : [{ value: "members" as const, label: "Members", panel: tab === "members" ? list : null }]),
            { value: "personas", label: "Personas", panel: tab === "personas" ? list : null },
            { value: "all", label: "All cards", panel: tab === "all" ? list : null }
          ]}
        />
      ) : personas === undefined && shown.length === 0 && typed !== "" && addToChat ? (
        <>
          {list}
          <p className="px-1 text-sm">{addToChat}</p>
        </>
      ) : (
        list
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
