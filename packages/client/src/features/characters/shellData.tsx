import { useCardGrouping } from "./cardGrouping.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { CardSurface } from "../cardForks/surfaces.tsx"
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@dreamspan/shared/chat.ts"
import type {
  ShellCard,
  ShellCards,
  ShellFork as ShellForkRow,
  ShellForks,
  ShellForksView,
  ShellSection
} from "@dreamspan/shared/chatSetupApi.ts"
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { openOnPlainClick } from "../../ui/links.ts"
import { OPEN_BESIDE_HINT, openBeside, useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { openPageBeside, PAGE_BESIDE_HINT } from "../../ui/openBeside.ts"
import { ContextMenu, MenuItem } from "../../ui/Menu.tsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { Effect, Schedule, Stream } from "effect"
import { applyShellCards, applyShellForks } from "@dreamspan/shared/shellUpdates.ts"
import { createContext, type DragEvent, type ReactNode, useContext, useState } from "react"
import { CARD_DRAG, carryOnDrag } from "../../ui/appDrags.ts"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { PICTURE_TOGGLE, Tooltip } from "../../ui/Tooltip.tsx"
import { FavouriteStar, SortDate } from "./cardBrowse.tsx"
import type { CardSort } from "./cardRecency.ts"
import { type FamilyPlace } from "./cardFamilies.ts"
import { Icon } from "../../ui/Icon.tsx"
import { rememberPanel } from "../chat/ChatPanels.tsx"

/** A fork row with its cast's cards, which the wire names once in `people`. */
export type ShellFork = Omit<ShellForkRow, "cast" | "added" | "thread"> & {
  readonly cast: ReadonlyArray<CastCard>
  readonly added: ReadonlyArray<CastCard>
  readonly thread?: { readonly name: string | null; readonly cast: ReadonlyArray<CastCard> }
}
/** The shell's cards (GetShellCards): home, the grids and the card pages read them. */
export type ShellLibrary = ShellCards

const SHELL_KEYS = ["chats", "library", "pins", "favourites"]
const shellRetry = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("15 seconds")]).pipe(
  Schedule.setInputType<{ readonly _tag: string }>(),
  Schedule.while(({ input }) => input._tag === "RpcClientError" || input._tag === "ServerError"),
  Schedule.modifyDelay(({ input, duration }) => Effect.succeed(input._tag === "RpcClientError" ? "1 second" : duration))
)

/** Kept while the app runs: every screen reads it, and a remount mustn't cancel and send it again. */
export const shellAtom = Atom.keepAlive(
  AppClient.runtime.factory.withReactivity(SHELL_KEYS)(
    AppClient.runtime.atom(
      Stream.unwrap(
        Effect.map(AppClient, (client) =>
          client("WatchShellCards", undefined).pipe(
            Stream.retry(shellRetry),
            Stream.scan(
              (): ShellCards => ({ cards: [], personas: [], archived: [], pinsCollapsed: false }),
              applyShellCards
            ),
            Stream.drop(1)
          )
        )
      )
    )
  )
)

/** Every card the lists browse: the characters, then the persona folder's (each `persona`), for `browseCards`. */
export const browsable = (data: ShellLibrary) => [...data.cards, ...data.personas, ...data.archived]

/** A section's rows, with their cast's cards, and how many it has. */
export interface ShellRows {
  readonly rows: ReadonlyArray<ShellFork>
  readonly total: number
}
const withCast = (data: ShellForks): ReadonlyMap<ShellSection, ShellRows> => {
  const people = new Map(data.people.map((c) => [c.entityId, c]))
  return new Map(
    data.sections.map((section) => [
      section.id,
      {
        total: section.total,
        rows: section.rows.map(({ thread, ...f }) => ({
          ...f,
          cast: f.cast.flatMap((id) => people.get(id) ?? []),
          added: f.added.flatMap((id) => people.get(id) ?? []),
          ...(thread ? { thread: { ...thread, cast: thread.cast.flatMap((id) => people.get(id) ?? []) } } : {})
        }))
      }
    ])
  )
}
/** One atom per view, by its JSON: each screen's lists are read with only the rows they show. */
const shellForksAtom = Atom.family((key: string) =>
  Atom.mapResult(
    AppClient.runtime.factory.withReactivity(SHELL_KEYS)(
      AppClient.runtime.atom(
        Stream.unwrap(
          Effect.map(AppClient, (client) =>
            client("WatchShellForks", JSON.parse(key) as ShellForksView).pipe(
              Stream.retry(shellRetry),
              Stream.scan(
                () =>
                  ({
                    sections: [],
                    people: [],
                    filterCounts: { all: 0, pinned: 0, groups: 0, solo: 0, branches: 0, workshops: 0 }
                  }) as ShellForks,
                applyShellForks
              ),
              Stream.drop(1)
            )
          )
        )
      )
    ),
    (data) => ({ rows: withCast(data), filterCounts: data.filterCounts, progress: data.loading ?? null })
  )
)
/** Rows shown at first, and added by each "Show more". */
export const PAGE_ROWS = 100
const empty: ShellRows = { rows: [], total: 0 }

export const shellForksQuery = (view: ShellForksView) => shellForksAtom(JSON.stringify(view))

/**
 * The fork rows of `view`'s sections. While a longer list or another search of the same lists
 * is read, the last answer stays, so lists don't flash a spinner; another scope shows none
 * until its own. `loading`: nothing to show yet. `failure`: the read's error, for a retry.
 */
export function useShellForks(view: ShellForksView) {
  const atom = shellForksQuery(view)
  const result = useAtomValue(atom)
  const lists = JSON.stringify([
    view.entity,
    view.chat,
    view.chats,
    view.sort,
    view.browse,
    view.sections.map((s) => s.id)
  ])
  const [last, setLast] = useState<{
    lists: string
    data: {
      rows: ReadonlyMap<ShellSection, ShellRows>
      filterCounts: ShellForks["filterCounts"]
      progress: ShellForks["loading"] | null
    }
  } | null>(null)
  // Kept as React's "state from the previous render": set again only when the answer changes.
  if (AsyncResult.isSuccess(result) && (last?.data !== result.value || last.lists !== lists))
    setLast({ lists, data: result.value })
  const shown = AsyncResult.isSuccess(result) ? { lists, data: result.value } : last
  const data = shown?.lists === lists ? shown.data : null
  return {
    atom,
    loading: data === null,
    waiting: !AsyncResult.isSuccess(result) || result.waiting,
    failure: AsyncResult.isFailure(result) ? result : null,
    filterCounts: data?.filterCounts ?? null,
    /**
     * While the server is still reading some of the scope's forks (a cold library): how many of
     * them are ready. Their rows are listed already, `pending`, and fill in as they are read.
     */
    progress: data?.progress ?? null,
    section: (id: ShellSection) => data?.rows.get(id) ?? empty
  }
}

/** How many groups (chats of several characters) there are, for the filter's count; null while it's read. */
export function useGroupCount() {
  const forks = useShellForks({
    entity: null,
    chat: null,
    search: "",
    sort: "recent",
    sections: [{ id: "groups", limit: 0 }]
  })
  return forks.loading ? null : forks.section("groups").total
}

type Scope = { entity: EntityId | null; chat: string | null }
type SidebarSearch = { character?: string | undefined; forks?: string | undefined; side?: string | undefined }

/** The search params for a scope, to merge into a navigation that should keep or set it. */
export const scopeSearch = (scope: Scope) => ({
  ...(scope.entity ? { character: scope.entity } : {}),
  ...(scope.chat ? { forks: scope.chat } : {})
})
/** Explicitly none: screens that retain the panel's params (sidebarSearch.ts) would keep them otherwise. */
export const sidebarCleared = { character: undefined, forks: undefined, side: undefined }
// Counts picks in the left panel, so the phone sheet can close on a pick that leaves the URL as it was.
const Picks = createContext<{ selection: number; picked: () => void } | null>(null)
export function ShellNavigation({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState(0)
  return <Picks value={{ selection, picked: () => setSelection((n) => n + 1) }}>{children}</Picks>
}
/**
 * Where the left panel is, read from the URL alone (owner, 2026-10-31: tied to the path), so
 * back/forward, reloads and links always agree with it. Moving it navigates to the same page
 * with other search params: the middle stays as it is (UX-REWORK §3).
 */
export function useShellNavigation() {
  // Only these three: the whole search would re-render every row of the left panel whenever
  // another param moves, the chat panel's tab with each switch (night/tabperf).
  const search: SidebarSearch = {
    character: useSearch({ strict: false, select: (s: SidebarSearch) => s.character }),
    forks: useSearch({ strict: false, select: (s: SidebarSearch) => s.forks }),
    side: useSearch({ strict: false, select: (s: SidebarSearch) => s.side })
  }
  const navigate = useNavigate()
  const { selection, picked } = useContext(Picks)!
  const scope: Scope = {
    entity: typeof search.character === "string" && search.character ? (search.character as EntityId) : null,
    chat: typeof search.forks === "string" && search.forks ? search.forks : null
  }
  return {
    scope,
    grid: search.side === "characters",
    setScope: (next: Scope) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...sidebarCleared, ...scopeSearch(next) }),
        state: (prev) => ({ ...prev })
      }),
    setGrid: (grid: boolean) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          ...sidebarCleared,
          ...scopeSearch(scope),
          ...(grid ? { side: "characters" } : {})
        }),
        state: (prev) => ({ ...prev }),
        resetScroll: false
      }),
    selection,
    picked
  }
}

/**
 * Whether opening a character's chat (its tile, its row) goes to the line the character last
 * spoke, which then flashes (chat/jumpFlash.ts), rather than to the chat's end. The owner called
 * it "dubiously useful" (2026-11-06): `false` drops it everywhere.
 */
const OPEN_AT_LAST_LINE = true

/** The `slot` a character's chat opens at (`OPEN_AT_LAST_LINE`); none: its end. */
const lastLine = (latest: { readonly slot: string | null }) =>
  OPEN_AT_LAST_LINE && latest.slot ? { slot: latest.slot } : {}

/**
 * Where a character's tile links: the chat it opens (its latest), else a new one, with the
 * sidebar on the character's chats and its card's panel, as a click opens it (`useOpenCharacter`),
 * so Open beside, Alt-click and a new browser tab open the character too (owner, 2026-11-06).
 */
const characterLink = (entity: EntityId, latest: ShellCard["open"]) => {
  const character = { character: entity, panel: `card:${entity}` }
  return latest
    ? {
        to: "/chats/$chatId" as const,
        params: { chatId: latest.chatId },
        search: { ...character, fork: latest.forkId, ...lastLine(latest) }
      }
    : { to: "/cards/$entityId/chat" as const, params: { entityId: entity }, search: character }
}

export function useCharacterNavigation() {
  const navigation = useShellNavigation()
  const result = useAtomValue(shellAtom)
  const navigate = useNavigate()
  const userId = useSession().user.id
  const link = (entity: EntityId) => {
    const matches = (card: ShellCard) => card.card.entityId === entity
    const card = AsyncResult.isSuccess(result)
      ? (result.value.cards.find(matches) ?? result.value.personas.find(matches) ?? result.value.archived.find(matches))
      : undefined
    const target = characterLink(entity, card?.open ?? null)
    return { ...target, search: { ...sidebarCleared, ...target.search } }
  }
  const open = (entity: EntityId) => {
    navigation.picked()
    const target = link(entity)
    rememberPanel(userId, target.search.panel)
    void navigate(target)
  }
  return { link, open }
}

export function useOpenCharacter() {
  return useCharacterNavigation().open
}

/**
 * What a tile does when it isn't opening the character's chat (the Cast's Add characters),
 * given the tile's status (a word from the grid's `status`, undefined for none): `label`, its
 * accessible name; `hint`, its tooltip; `state`, how it stands: `mark`, a badge over its
 * picture ("In chat"), `done` dims it and makes a click do nothing (it stays focusable, so its
 * tooltip can say why), `pending` while the pick is under way. A tile gets only its own status,
 * so a change re-renders only the tiles it changes. With `onOpen`, the tile opens the editor
 * and a separate pick button carries the label, hint and disabled state.
 */
export interface TilePick {
  /** When supplied, the tile opens this editor and the pick becomes a separate button. */
  readonly onOpen?: (card: ShellCard) => void
  /** Where `onOpen` goes, so the tile is a link (it opens in a new browser tab too). */
  readonly href?: (card: ShellCard) => string
  readonly onPick: (card: ShellCard) => void
  readonly label: (card: ShellCard, status: string | undefined) => string
  readonly hint: (card: ShellCard, status: string | undefined) => ReactNode
  readonly state: (status: string | undefined) => TileState
}
export interface TileState {
  readonly mark?: ReactNode
  readonly done?: boolean
  readonly pending?: boolean
}

/**
 * Characters as tiles, in the order given (`browseCards`), each with the date `sort` orders
 * by. `pick`: what a tile does, else open the character's chat, and `status` each tile's
 * status for it, by entity id. `markPersonas`: the list mixes the persona folder's cards in,
 * so each is marked "Persona" (`mixesPersonas`). `children` follow the tiles
 * (an empty state). `className` sets the columns for where it's shown.
 */
export function CharacterGrid({
  cards,
  sort,
  pick,
  status,
  markPersonas = false,
  families,
  className,
  children
}: {
  cards: ReadonlyArray<ShellCard>
  sort: CardSort
  pick?: TilePick
  status?: ReadonlyMap<string, string>
  markPersonas?: boolean
  /**
   * "Group forks" (cardFamilies.ts): a card and its forks are one tile, which `expanded` (a
   * family's id) opens to its members; `onToggle` opens one or closes it (null). Absent: every card its own tile.
   */
  families?: CardFamilies | undefined
  className: string
  children?: ReactNode
}) {
  const grouping = useCardGrouping()
  const tiles = families && grouping ? grouping.group(cards, families.expanded) : cards.map((card) => ({ card }))
  return (
    <div aria-label="Characters" className={className}>
      {tiles.map(({ card: c, ...tile }) => (
        <CharacterTile
          key={c.card.entityId}
          card={c}
          sort={sort}
          {...(pick ? { pick } : {})}
          status={status?.get(c.card.entityId)}
          marked={markPersonas && c.persona}
          {...("family" in tile && tile.family && families ? { family: tile.family, onFamily: families.onToggle } : {})}
        />
      ))}
      {children}
    </div>
  )
}

export interface CardFamilies {
  readonly expanded: string | null
  readonly onToggle: (family: string | null) => void
}

/**
 * Under a family's tile: how many cards it stands for, and the control that lists them after it.
 * Shaped as the fork badge beside it.
 */
function FamilyToggle({
  label,
  family,
  onToggle
}: {
  label: string
  family: FamilyPlace
  onToggle: (family: string | null) => void
}) {
  const others = family.count - 1
  return (
    <Tooltip
      label={
        family.expanded
          ? "Click to show this family as one tile again."
          : `Click to show the ${others === 1 ? "other card" : `${others} other cards`} of this family: its forks and the card they came from.`
      }
    >
      <button
        type="button"
        data-family-toggle
        aria-expanded={family.expanded}
        aria-label={`${label}: ${family.count} cards in this family`}
        className="inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-expanded:border-accent aria-expanded:text-text"
        onClick={() => onToggle(family.expanded ? null : family.id)}
      >
        <Icon name="family" size={12} />
        {family.count} cards
        <Icon name={family.expanded ? "down" : "right"} size={12} />
      </button>
    </Tooltip>
  )
}

// Fills the grid row, its last line at the bottom, so tiles in a row match (DESIGN §2.1).
const TILE_BASE =
  "group flex min-w-0 flex-1 flex-col overflow-hidden bg-surface text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
/** A tile that is the whole link (home, the sidebar, a card source's results). */
export const TILE_CLASS = `${TILE_BASE} rounded-lg border border-border`
const TILE_OPEN_CLASS = `${TILE_BASE} rounded-t-lg focus-visible:ring-inset`
const OPEN_AREA = "inset: The open area fills the tile above its badges and footer"
/** What holds a tile and the toggles over its picture's corners. */
export const TILE_SURFACE_CLASS = "tile-toggle-surface relative flex min-w-0 flex-col"

/**
 * A tile's face: the picture in its 2:3 box, the name on its line, then the tile's own lines.
 * Every card tile has it: the user's cards and a card source's results look the same (§3.3).
 */
export function TileFace({
  portrait,
  name,
  title,
  dim = false,
  children
}: {
  portrait: ReactNode
  name: string
  title?: string | undefined
  dim?: boolean
  children: ReactNode
}) {
  return (
    <>
      <span className={`relative aspect-[2/3] w-full overflow-hidden ${dim ? "opacity-50" : ""}`}>{portrait}</span>
      <span className="flex w-full min-w-0 flex-1 flex-col gap-0.5 p-2">
        <span data-layout-name className="truncate text-sm font-medium" {...(title === undefined ? {} : { title })}>
          {name}
        </span>
        {children}
      </span>
    </>
  )
}

/**
 * A character's tile: its picture, names and use, with its favourite star and archive toggle
 * over the picture's top corners.
 * `sort`: a date sort's date ends the last line. `pick`: what a click does, else open its chat.
 */
function CharacterTile({
  card,
  sort = "name",
  pick,
  status,
  marked,
  family,
  onFamily
}: {
  card: ShellCard
  sort?: CardSort
  pick?: TilePick
  status: string | undefined
  /** A persona in a mixed list: the "Persona" badge on its picture. */
  marked: boolean
  /** Its place in a family shown as one tile (cardFamilies.ts). */
  family?: FamilyPlace
  onFamily?: (family: string | null) => void
}) {
  const open = useOpenCharacter()
  const link = characterLink(card.card.entityId, card.open)
  const besideHref = useRouter().buildLocation(link).href
  const canBeside = useCanOpenBeside()
  const [menu, setMenu] = useState(false)
  const c = card.card
  const state = pick?.state(status) ?? {}
  const inner = (
    <TileFace
      dim={!pick?.onOpen && state.done === true}
      portrait={
        <>
          <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} crop={c.avatarCrop} size="fill" />
          {marked && <PersonaBadge portrait />}
        </>
      }
      name={c.label}
      // A pick's tooltip names it already.
      title={pick ? undefined : c.label}
    >
      {/* The date a date sort orders by shares the last line, so tiles keep their height. */}
      <span className="mt-auto flex min-w-0 items-baseline justify-between gap-1.5 text-xs text-muted">
        <span className="shrink-0">{c.chats ? `${c.chats} ${c.chats === 1 ? "chat" : "chats"}` : "Never used"}</span>
        <SortDate card={card} sort={sort} />
      </span>
    </TileFace>
  )
  // Dropped on a frame, the card's full-size editor opens there (owner, 2026-11-07): the
  // picker's own editor, bound to its chat; a click still does what it does.
  const editor = pick?.href?.(card) ?? `/library/${encodeURIComponent(c.refId)}`
  const onDragStart = (event: DragEvent) => carryOnDrag(event.dataTransfer, CARD_DRAG.id, editor)
  // An open family's tiles share the accent border, so its members read as one group in the grid.
  // The border is the surface's, so its badges and footer sit inside the tile, never on a row of
  // their own between grid rows; the open area fills the tile above them.
  const idle = !pick?.onOpen && (state.done || state.pending)
  const tileClass = `${TILE_OPEN_CLASS} ${idle ? "cursor-default" : ""}`
  const button = !pick ? (
    // A link to the chat it opens, so it opens in a new browser tab too.
    <Link
      {...link}
      onClick={openOnPlainClick(() => open(c.entityId))}
      onDragStart={onDragStart}
      aria-label={`Open ${c.label}${marked ? " (persona)" : ""}`}
      data-layout-audit-ignore={OPEN_AREA}
      className={tileClass}
    >
      {inner}
    </Link>
  ) : pick.onOpen && pick.href ? (
    <a
      href={pick.href(card)}
      onClick={openOnPlainClick(() => pick.onOpen?.(card))}
      onDragStart={onDragStart}
      aria-label={`Open ${c.label}${marked ? " (persona)" : ""}`}
      data-layout-audit-ignore={OPEN_AREA}
      className={tileClass}
    >
      {inner}
    </a>
  ) : (
    <button
      type="button"
      // A phone has one frame; there a long press is the browser's own.
      draggable={canBeside}
      onDragStart={onDragStart}
      onClick={() => {
        if (pick.onOpen) return pick.onOpen(card)
        if (!state.done && !state.pending) pick.onPick(card)
      }}
      aria-label={!pick.onOpen ? pick.label(card, status) : `Open ${c.label}${marked ? " (persona)" : ""}`}
      data-layout-audit-ignore={OPEN_AREA}
      {...(!pick.onOpen && (state.done || state.pending) ? { "aria-disabled": true } : {})}
      {...(!pick.onOpen && state.pending ? { "aria-busy": true } : {})}
      className={tileClass}
    >
      {inner}
    </button>
  )
  return (
    <div
      {...(family ? { "data-family": family.id, "data-family-head": family.head } : {})}
      className={`${TILE_SURFACE_CLASS} overflow-hidden rounded-lg border border-border bg-surface ${idle ? "" : "hover:border-focus"} ${family?.expanded ? "border-accent!" : ""}`}
    >
      {pick ? (
        <Tooltip label={pick.onOpen ? `Open ${c.label} in the full editor` : pick.hint(card, status)}>{button}</Tooltip>
      ) : (
        // The same menu as a chat row's (ShellBrowser's ForkRow).
        <ContextMenu
          label={`Actions for ${c.label}`}
          open={menu}
          onOpenChange={setMenu}
          trigger={
            <Tooltip label={`Opens ${c.label}’s card.${canBeside ? " Right-click to open it beside." : ""}`}>
              {button}
            </Tooltip>
          }
        >
          <MenuItem icon="chat" description="Opens it here, as a click does." onClick={() => open(c.entityId)}>
            Open
          </MenuItem>
          {canBeside && (
            <MenuItem icon="split-right" description={OPEN_BESIDE_HINT} onClick={() => openBeside(besideHref)}>
              Open beside
            </MenuItem>
          )}
          <MenuItem
            icon="external"
            description="Opens it in a new tab of the browser."
            onClick={() => window.open(besideHref, "_blank", "noopener")}
          >
            Open in a new browser tab
          </MenuItem>
          {/* The card's full-page editor beside (owner, 2026-11-24), as a drop on a frame opens it. */}
          {canBeside && (
            <MenuItem icon="edit" description={PAGE_BESIDE_HINT} onClick={() => openPageBeside(editor)}>
              Edit beside
            </MenuItem>
          )}
          <CardSurface placement="tile-menu" entityId={c.entityId} />
        </ContextMenu>
      )}
      {/* Its badges (forks, the default persona) and family toggle: a line inside the tile, gone when empty. */}
      <span data-tile-badges className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2 empty:hidden">
        {family?.head && onFamily && <FamilyToggle label={c.label} family={family} onToggle={onFamily} />}
        <CardSurface placement="badge" entityId={c.entityId} label={c.label} />
      </span>
      {pick?.onOpen && (
        <Button
          data-layout-audit-ignore="inset: The footer joins the tile border edge to edge"
          className="w-full rounded-none border-t border-border px-2 text-text focus-visible:ring-inset"
          variant="ghost"
          aria-label={pick.label(card, status)}
          hint={pick.hint(card, status)}
          disabled={state.done || state.pending}
          focusableWhenDisabled
          onClick={() => pick.onPick(card)}
        >
          {state.pending ? "Adding…" : state.done ? "In this chat" : "Add to chat"}
        </Button>
      )}
      {/* Each toggle has a corner of its own: the star top left, the archive top right. */}
      <span data-layout-overlay="Favourite action sits over the portrait" className="absolute top-2 left-2 flex">
        <FavouriteStar card={card} className={PICTURE_TOGGLE} />
      </span>
      {/* A picker adds to a chat (its corner shows whether one's in it); archiving isn't part of that. */}
      {!pick && (
        <span data-layout-overlay="Archive action sits over the portrait" className="absolute top-2 right-2 flex">
          <CardSurface placement="archive-toggle" entityId={c.entityId} className={PICTURE_TOGGLE} />
        </span>
      )}
      {state.mark && (
        <span
          data-layout-overlay="Chat membership sits over the portrait"
          className="pointer-events-none absolute top-1.5 right-1.5 max-w-[calc(100%-3rem)]"
        >
          {state.mark}
        </span>
      )}
    </div>
  )
}
