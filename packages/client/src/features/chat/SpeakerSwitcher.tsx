import { Tooltip } from "../../ui/Tooltip.tsx"
// The one picker of who speaks and who the user plays (`{{user}}`, DESIGN §2.2), registered as
// `chat.card-switcher` (presentation.tsx) and rendered through `CardSwitcher` everywhere: the
// composer's chip (saved and new chats, workshops), the Cast and This chat tabs' Switch, a
// workshop's start card, the insert editor. A search field on top, focused as it opens: typing
// filters by name, the arrow keys move through what's left, Enter picks, Escape closes. Picking
// a persona has the same tabs, rows, row menus, lock row and buttons wherever it is: Members (a
// saved chat's), Personas, All cards (not for a workshop, whose persona comes from the folder),
// opening on Personas. The composer's adds a Speak as tab before them, the one it opens on:
// anyone in the chat, the speakers used last first. A library of hundreds of cards is filtered
// in memory and only the rows in view are drawn.
import { CardSurface } from "../cardForks/surfaces.tsx"
import { CardVersion } from "./CardVersion.tsx"
import { useDefaultPersona } from "../characters/defaultPersona.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import type { CastCard, EntityId } from "@dreamspan/shared/chat.ts"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { type KeyboardEvent, memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Input } from "../../ui/Field.tsx"
import { useOpenPlace } from "../editor/durable.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { nameOf, useCast } from "./cast.ts"
import { ChevronIcon } from "./icons.tsx"
import type { Outcome } from "./session.ts"
import { NewCardDialog } from "../editor/NewCard.tsx"
import { Button } from "../../ui/Button.tsx"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { useShowPanel } from "./panels.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { cardSwitchers } from "./presentation.tsx"

type SwitcherTab = "cast" | "members" | "personas" | "all"

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
  // Away from the scene (spec/CHARACTER-CONTEXT.md §2.1), shown wherever the cast is.
  const away = useCast().cast?.away ?? []
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
    <div ref={list} id={id} role="listbox" aria-label="Cards" className="max-h-64 min-h-0 overflow-y-auto p-2">
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
              aria-description={card.subtitle?.trim() ? `Version: ${card.subtitle.trim()}` : undefined}
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
                <span data-layout-name className="truncate">
                  {card.name}
                </span>
                <CardVersion card={card} truncate />
              </span>
              {/* Played as the persona, a character card joins the chat; a persona takes the
                  place of the one played until now, so it isn't said to add anyone. */}
              {members !== null && !members.has(card.entityId) && !card.persona && (
                <span className="shrink-0 text-xs text-muted">adds to this chat</span>
              )}
              {away.includes(card.entityId) && <span className="shrink-0 text-xs text-muted">away</span>}
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

/** The persona part of the composer's picker: who `{{user}}` is, picked on its persona tabs. */
export interface PersonaSection {
  readonly current: EntityId | null
  readonly listCards: () => Promise<Outcome<ReadonlyArray<CastCard>>>
  readonly onPick: (card: CastCard) => void
  /** Offered as "No persona" on the persona tabs. */
  readonly onNone?: (() => void) | undefined
}

export interface SpeakerSwitcherProps {
  /** The library's cards, which the persona is picked from. */
  readonly listCards?: (() => Promise<Outcome<ReadonlyArray<CastCard>>>) | undefined
  /** The card speaking, or with `persona`, the one the user plays. */
  readonly speaker: EntityId | null
  /** The speakers of the latest messages, most recent first: listed first. */
  readonly recent: ReadonlyArray<EntityId>
  readonly onPick: (card: CastCard) => void
  /**
   * Picks the persona alone (DESIGN §2.2: who `{{user}}` is), from the library: it opens on
   * Personas every time.
   */
  readonly persona?: boolean | undefined
  /** A chat not made yet: there are no members to join. */
  readonly pending?: boolean | undefined
  /** Offered as "No persona" (with `persona`). */
  readonly onNone?: (() => void) | undefined
  /** Its button's content in place of the chip ("Switch persona" where the name is already shown). */
  readonly trigger?: ReactNode
  /** The trigger's accessible name in place of "Playing as …" or "Speaking as …". */
  readonly triggerLabel?: string | undefined
  /** With `trigger`, its class in place of a secondary button's. */
  readonly triggerClassName?: string | undefined
  /**
   * The composer's persona part: a Speak as tab (who the next message is from: anyone in the
   * chat) comes first, then the persona tabs every persona picker has.
   */
  readonly personas?: PersonaSection | undefined
  /** Only cards in the persona folder can be the persona (a workshop's): no All cards tab. */
  readonly personasOnly?: boolean | undefined
  /** Offered when no one in the chat has the name searched for: adding a card is the Cast tab's. */
  readonly onAddToChat?: (() => void) | undefined
  /** The trigger shows the portrait alone (the name is its label and tooltip). */
  readonly compact?: boolean | undefined
  /** Where on the page it is ("composer", "cast"): names its New persona form in the URL, so a reload opens it again. */
  readonly place?: string | undefined
  /** Rows under the list, inset as its rows are: the persona lock (DESIGN §2.2). */
  readonly footer?: ReactNode
}

/**
 * The one speaker and persona picker, as registered (`chat.card-switcher`, presentation.tsx):
 * every place that picks who speaks or who the user plays renders this.
 */
export function CardSwitcher(props: SpeakerSwitcherProps) {
  return <SlotOutlet slot={cardSwitchers} props={props} />
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
  triggerLabel,
  triggerClassName,
  personas,
  personasOnly = false,
  onAddToChat,
  compact = false,
  footer,
  place = "speaker"
}: SpeakerSwitcherProps) {
  const view = useCast()
  const defaultPersona = useDefaultPersona()
  const defaultLabel = pending && persona && speaker !== null && speaker === defaultPersona ? " (default)" : ""
  // Whether it picks a persona at all; with `personas`, also the speaker (its Speak as tab).
  const picksPersona = persona || personas !== undefined
  const firstTab: SwitcherTab = personas !== undefined ? "cast" : "personas"
  const [open, setOpen] = useState(false)
  const [making, setMaking] = useOpenPlace(`new-persona:${place}`)
  const [tab, setTab] = useState<SwitcherTab>(firstTab)
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
  // Picking on this tab picks the speaker; on the others, the persona.
  const speakerTab = !picksPersona || tab === "cast"
  // The persona now: with `persona` the chip's card, else the composer's persona part's.
  const personaNow = persona ? speaker : (personas?.current ?? null)
  const pickPersona = persona ? onPick : (personas?.onPick ?? onPick)
  const noPersona = persona ? onNone : personas?.onNone
  // A card in the chat by the name the chat uses for it (its own version's, say).
  const cards = useMemo(() => (all ?? []).map((card) => view.cards.get(card.entityId) ?? card), [all, view.cards])
  const shown = useMemo(() => {
    if (speakerTab)
      return ranked(
        castIds.flatMap((id) => view.cards.get(id) ?? []),
        query,
        recent,
        castIds
      )
    // The persona played comes first, then the members.
    const first = personaNow === null ? [] : [personaNow]
    const source = tab === "members" ? members : tab === "personas" ? cards.filter((card) => card.persona) : cards
    return ranked(source, query, first, memberIds)
  }, [speakerTab, castIds, view.cards, query, recent, personaNow, tab, members, cards, memberIds])

  const openChange = (next: boolean) => {
    setOpen(next)
    setQuery("")
    setActive(0)
    if (!next || !picksPersona) return
    setTab(firstTab)
    const list = personas?.listCards ?? listCards
    // Another selector or editor may have created a persona since this picker last opened.
    if (list)
      void list().then((result) => {
        setAll(result.ok ? result.value : [])
        if (result.ok) setNames(new Map(result.value.map((card) => [card.entityId, card])))
      })
  }
  const pickAt = (index: number) => {
    const card = shown[index]
    if (card === undefined) return
    openChange(false)
    if (speakerTab) onPick(card)
    else pickPersona(card)
  }
  const pick = (card: CastCard) => pickAt(shown.indexOf(card))
  const showPanel = useShowPanel()
  // A persona made here becomes the one played, then opens in the card editor in the side
  // panel: its tab exists once the chat plays it.
  const reveal = useRef<EntityId | null>(null)
  const created = async (ref: LibraryRef) => {
    const list = personas?.listCards ?? listCards
    const result = list ? await list() : null
    if (!result?.ok) return
    setAll(result.value)
    setNames(new Map(result.value.map((card) => [card.entityId, card])))
    const card = result.value.find((c) => c.entityId === ref.entityId)
    if (!card) return
    reveal.current = card.entityId
    pickPersona(card)
  }
  useEffect(() => {
    const entity = reveal.current
    if (entity === null || !view.cast?.playedByMe.includes(entity)) return
    reveal.current = null
    showPanel(`card:${entity}`)
  }, [view.cast, showPanel])
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
      pickAt(active)
    }
  }
  const memberSet = useMemo(() => new Set(memberIds), [memberIds])
  const loading = !speakerTab && tab !== "members" && all === null
  const typed = query.trim()
  const empty =
    typed !== ""
      ? speakerTab
        ? `No one in this chat is called “${typed}”.`
        : tab === "personas"
          ? `No persona is called “${typed}”.`
          : `No card's name has “${typed}”.`
      : speakerTab
        ? "No one is in the chat yet. Add cards in the Cast tab."
        : tab === "members"
          ? "No one has joined yet."
          : loading
            ? "Loading…"
            : tab === "personas"
              ? "No cards in the persona folder."
              : "No cards yet."
  const addToChat = onAddToChat && speakerTab && shown.length === 0 && typed !== "" && (
    <p className="px-1 text-sm">
      <Tooltip label="Opens the character picker to add to this chat.">
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
      </Tooltip>
    </p>
  )
  const list = (
    <CardOptions
      personaOnly={tab === "personas" && !speakerTab}
      id={listId}
      cards={loading ? [] : shown}
      active={active}
      current={speakerTab ? speaker : personaNow}
      currentLabel={speakerTab ? "speaking" : "your persona"}
      played={personaNow ?? view.cast?.playedByMe[0] ?? null}
      // Played as the persona, a character card not in a saved chat joins it.
      members={pending || speakerTab ? null : memberSet}
      empty={empty}
      onActive={setActive}
      onPick={pick}
    />
  )
  const tabs: ReadonlyArray<{ value: SwitcherTab; label: string }> = [
    ...(personas !== undefined ? [{ value: "cast" as const, label: "Speak as" }] : []),
    ...(pending ? [] : [{ value: "members" as const, label: "Members" }]),
    { value: "personas" as const, label: "Personas" },
    ...(personasOnly ? [] : [{ value: "all" as const, label: "All cards" }])
  ]
  return (
    <>
      <Popover
        open={open}
        onOpenChange={openChange}
        initialFocus={search}
        // The composer's has a tab more: room for its tabs on one line.
        wide={personas !== undefined}
        triggerLabel={
          triggerLabel ??
          (persona
            ? `Playing as ${name}${defaultLabel}. Change your persona`
            : `Speaking as ${name}. Change the speaker`)
        }
        hint={
          persona ? `You play ${name} ({{user}}). Change who you play` : `Speaking as ${name}. Change who's speaking`
        }
        triggerClassName={
          trigger
            ? (triggerClassName ?? buttonClass("secondary"))
            : `inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-raised py-1 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus ${compact ? "pr-1.5 pl-1" : "max-w-44 pr-2.5 pl-1"}`
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
              ) : compact ? (
                // Without a persona and without room for "You", the chip still shows who speaks.
                <Icon name="person" size={16} className="mx-0.5 text-muted" />
              ) : (
                <span aria-hidden="true" className="size-1" />
              )}
              {!compact && (
                <span data-layout-name className="min-w-0 truncate">
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
            !speakerTab
              ? "Find a card to play as"
              : personas
                ? "Find someone to speak as"
                : "Find someone in this chat to speak as"
          }
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown.length > 0 && !loading ? `${listId}-${active}` : undefined}
          placeholder={speakerTab ? "Find by name" : "Find a card by name"}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="shrink-0"
        />
        {picksPersona ? (
          <Tabs
            label={personas !== undefined ? "Speak as, or play as" : "Cards to play as"}
            // The list shrinks to the popover's height, scrolling, rather than running under its buttons.
            panelClassName="flex flex-col"
            value={tab}
            onValueChange={(next) => {
              setTab(next)
              setActive(0)
            }}
            onPointerActivate={() => search.current?.focus()}
            tabs={tabs.map((entry) => ({
              ...entry,
              panel:
                tab === entry.value ? (
                  <>
                    {list}
                    {addToChat}
                  </>
                ) : null
            }))}
          />
        ) : (
          <>
            {list}
            {addToChat}
          </>
        )}
        {footer}
        {noPersona && !speakerTab && (
          <Tooltip label="Uses no persona for this chat.">
            <button
              type="button"
              onClick={() => {
                openChange(false)
                noPersona()
              }}
              className="shrink-0 rounded-md px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
            >
              No persona
            </button>
          </Tooltip>
        )}
        {picksPersona && (
          <Button
            hint="Opens a form to create a persona to play in this chat."
            onClick={() => {
              openChange(false)
              setAll(null)
              setMaking(true)
            }}
          >
            New persona…
          </Button>
        )}
      </Popover>
      {picksPersona && (
        <NewCardDialog persona open={making} onOpenChange={setMaking} onCreated={(_, ref) => void created(ref)} />
      )}
    </>
  )
})
