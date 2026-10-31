import { CardSurface } from "../cardForks/surfaces.tsx"
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { ShellCard, ShellFork as ShellForkRow, ShellLibrary as ShellLibraryRows } from "@rp/shared/chatSetupApi.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult, Atom } from "effect/reactivity"
import { createContext, type ReactNode, useContext, useState } from "react"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"

/** A fork row with its cast's cards, which the wire names once in `people`. */
export type ShellFork = Omit<ShellForkRow, "cast"> & { readonly cast: ReadonlyArray<CastCard> }
export type ShellLibrary = Omit<ShellLibraryRows, "forks" | "people"> & { readonly forks: ReadonlyArray<ShellFork> }
const withCast = (data: ShellLibraryRows): ShellLibrary => {
  const people = new Map(data.people.map((c) => [c.entityId, c]))
  return {
    ...data,
    forks: data.forks.map((f) => ({ ...f, cast: f.cast.flatMap((id) => people.get(id) ?? []) }))
  }
}
export const shellAtom = Atom.mapResult(
  AppClient.query("GetShellLibrary", undefined, { reactivityKeys: ["chats", "library", "pins"] }),
  withCast
)
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

const latestFor = (card: ShellCard, forks: ReadonlyArray<ShellFork>) =>
  [...forks.filter((f) => f.joined.includes(card.card.entityId))].sort(
    (a, b) =>
      (b.activity.find((x) => x.entityId === card.card.entityId)?.at ?? -1) -
        (a.activity.find((x) => x.entityId === card.card.entityId)?.at ?? -1) ||
      Number(b.leaf !== null) - Number(a.leaf !== null) ||
      Number(a.activity.find((x) => x.entityId === card.card.entityId)?.category === "was") -
        Number(b.activity.find((x) => x.entityId === card.card.entityId)?.category === "was") ||
      Number(b.current) - Number(a.current) ||
      b.createdAt - a.createdAt
  )[0]

export function useOpenCharacter() {
  const navigation = useShellNavigation()
  const result = useAtomValue(shellAtom)
  const navigate = useNavigate()
  const userId = useSession().user.id
  return (entity: EntityId) => {
    navigation.picked()
    const card = AsyncResult.isSuccess(result) ? result.value.cards.find((c) => c.card.entityId === entity) : undefined
    const latest = card && AsyncResult.isSuccess(result) ? latestFor(card, result.value.forks) : undefined
    const panel = `card:${entity}`
    try {
      localStorage.setItem(`rp.chatPanel.${userId}`, panel)
    } catch {
      /* URL carries it. */
    }
    if (latest)
      void navigate({
        to: "/chats/$chatId",
        params: { chatId: latest.chat.id },
        search: {
          ...sidebarCleared,
          character: entity,
          fork: latest.forkId,
          panel,
          ...(latest.leaf ? { leaf: latest.leaf } : {}),
          ...(latest.activity.find((a) => a.entityId === entity)?.slot
            ? { slot: latest.activity.find((a) => a.entityId === entity)!.slot }
            : {})
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

export function CharacterTile({ card }: { card: ShellCard }) {
  const open = useOpenCharacter()
  const c = card.card
  return (
    <div className="relative flex min-w-0 flex-col">
      {/* Fills the grid row, its last line at the bottom, so tiles in a row match (DESIGN §2.1). */}
      <button
        type="button"
        onClick={() => open(c.entityId)}
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
          <span className="mt-auto text-xs text-muted">
            {c.chats ? `${c.chats} ${c.chats === 1 ? "chat" : "chats"}` : "Never used"}
          </span>
        </span>
      </button>
      <CardSurface placement="badge" entityId={c.entityId} />
    </div>
  )
}
