import { CardSurface } from "../cardForks/surfaces.tsx"
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type {
  ShellCard,
  ShellCards,
  ShellFork as ShellForkRow,
  ShellForks,
  ShellForksView,
  ShellSection
} from "@rp/shared/chatSetupApi.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult, Atom } from "effect/reactivity"
import { createContext, type ReactNode, useContext, useState } from "react"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { FavouriteStar, SortDate } from "./cardBrowse.tsx"
import type { CardSort } from "./cardRecency.ts"

/** A fork row with its cast's cards, which the wire names once in `people`. */
export type ShellFork = Omit<ShellForkRow, "cast"> & { readonly cast: ReadonlyArray<CastCard> }
/** The shell's cards (GetShellCards): home, the grids, Start a chat and the card pages read them. */
export type ShellLibrary = ShellCards

const SHELL_KEYS = ["chats", "library", "pins", "favourites"]

/** Kept while the app runs: every screen reads it, and a remount mustn't cancel and send it again. */
export const shellAtom = Atom.keepAlive(AppClient.query("GetShellCards", undefined, { reactivityKeys: SHELL_KEYS }))

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
        rows: section.rows.map((f) => ({ ...f, cast: f.cast.flatMap((id) => people.get(id) ?? []) }))
      }
    ])
  )
}
/** One atom per view, by its JSON: each screen's lists are read with only the rows they show. */
const shellForksAtom = Atom.family((key: string) =>
  Atom.mapResult(
    AppClient.query("GetShellForks", JSON.parse(key) as ShellForksView, {
      reactivityKeys: SHELL_KEYS,
      timeToLive: "2 minutes"
    }),
    withCast
  )
)
/** Rows shown at first, and added by each "Show more". */
export const PAGE_ROWS = 100
const empty: ShellRows = { rows: [], total: 0 }

/**
 * The fork rows of `view`'s sections. While a longer list or another search of the same lists
 * is read, the last answer stays, so lists don't flash a spinner; another scope shows none
 * until its own. `loading`: nothing to show yet. `failure`: the read's error, for a retry.
 */
export function useShellForks(view: ShellForksView) {
  const atom = shellForksAtom(JSON.stringify(view))
  const result = useAtomValue(atom)
  const lists = JSON.stringify([view.entity, view.chat, view.chats, view.sort, view.sections.map((s) => s.id)])
  const [last, setLast] = useState<{ lists: string; data: ReadonlyMap<ShellSection, ShellRows> } | null>(null)
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
    section: (id: ShellSection) => data?.get(id) ?? empty
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
type SidebarSearch = { character?: string; forks?: string; side?: string }

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
  const search = useSearch({ strict: false }) as SidebarSearch
  const navigate = useNavigate()
  const { selection, picked } = useContext(Picks)!
  const scope: Scope = { entity: (search.character as EntityId | undefined) ?? null, chat: search.forks ?? null }
  return {
    scope,
    grid: search.side === "characters",
    setScope: (next: Scope) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...sidebarCleared, ...scopeSearch(next) })
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
        replace: true
      }),
    selection,
    picked
  }
}

export function useOpenCharacter() {
  const navigation = useShellNavigation()
  const result = useAtomValue(shellAtom)
  const navigate = useNavigate()
  const userId = useSession().user.id
  return (entity: EntityId) => {
    navigation.picked()
    const card = AsyncResult.isSuccess(result) ? result.value.cards.find((c) => c.card.entityId === entity) : undefined
    const latest = card?.open ?? null
    const panel = `card:${entity}`
    try {
      localStorage.setItem(`rp.chatPanel.${userId}`, panel)
    } catch {
      /* URL carries it. */
    }
    if (latest)
      void navigate({
        to: "/chats/$chatId",
        params: { chatId: latest.chatId },
        search: {
          ...sidebarCleared,
          character: entity,
          fork: latest.forkId,
          panel,
          ...(latest.leaf ? { leaf: latest.leaf } : {}),
          ...(latest.slot ? { slot: latest.slot } : {})
        }
      })
    else
      void navigate({
        to: "/cards/$entityId/chat",
        params: { entityId: entity },
        search: { ...sidebarCleared, character: entity, panel }
      })
  }
}

/**
 * Characters as tiles, in the order given (`browseCards`), each with the date `sort` orders
 * by. `onPick`: what a tile does, else open the character's chat. `children` follow the tiles
 * (an empty state). `className` sets the columns for where it's shown.
 */
export function CharacterGrid({
  cards,
  sort,
  onPick,
  className,
  children
}: {
  cards: ReadonlyArray<ShellCard>
  sort: CardSort
  onPick?: (card: ShellCard) => void
  className: string
  children?: ReactNode
}) {
  return (
    <div aria-label="Characters" className={className}>
      {cards.map((c) => (
        <CharacterTile key={c.card.entityId} card={c} sort={sort} {...(onPick ? { onPick } : {})} />
      ))}
      {children}
    </div>
  )
}

/**
 * A character's tile: its picture, names and use, with the favourite star over the picture.
 * `sort`: a date sort's date ends the last line. `onPick`: what a click does, else open its chat.
 */
function CharacterTile({
  card,
  sort = "name",
  onPick
}: {
  card: ShellCard
  sort?: CardSort
  onPick?: (card: ShellCard) => void
}) {
  const open = useOpenCharacter()
  const c = card.card
  return (
    <div className="relative flex min-w-0 flex-col">
      {/* Fills the grid row, its last line at the bottom, so tiles in a row match (DESIGN §2.1). */}
      <button
        type="button"
        onClick={() => (onPick ? onPick(card) : open(c.entityId))}
        aria-label={`Open ${c.label}${c.subtitle ? ` · ${c.subtitle}` : ""}`}
        className="group flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface text-left outline-none hover:border-focus focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="aspect-[2/3] w-full overflow-hidden">
          <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} size="fill" />
        </span>
        <span className="flex w-full min-w-0 flex-1 flex-col gap-0.5 p-2">
          <span className="truncate text-sm font-medium" title={c.label}>
            {c.label}
          </span>
          {c.subtitle && <span className="truncate text-xs text-muted">{c.subtitle}</span>}
          {/* The date a date sort orders by shares the last line, so tiles keep their height. */}
          <span className="mt-auto flex min-w-0 items-baseline justify-between gap-1.5 text-xs text-muted">
            <span className="shrink-0">
              {c.chats ? `${c.chats} ${c.chats === 1 ? "chat" : "chats"}` : "Never used"}
            </span>
            <SortDate card={card} sort={sort} />
          </span>
        </span>
      </button>
      <span className="absolute top-1 left-1 rounded-md bg-surface/85">
        <FavouriteStar card={card} />
      </span>
      <CardSurface placement="badge" entityId={c.entityId} label={c.label} />
    </div>
  )
}
