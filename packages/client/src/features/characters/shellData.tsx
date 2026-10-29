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
const Context = createContext<{
  scope: Scope
  setScope: (scope: Scope) => void
  grid: boolean
  setGrid: (grid: boolean) => void
  selection: number
  picked: () => void
} | null>(null)
export function ShellNavigation({ children }: { children: ReactNode }) {
  const search = useSearch({ strict: false }) as { character?: string; forks?: string }
  const [scope, setScope] = useState<Scope>({
    entity: (search.character as EntityId) ?? null,
    chat: search.forks ?? null
  })
  const [grid, setGrid] = useState(false)
  const [selection, setSelection] = useState(0)
  return (
    <Context value={{ scope, setScope, grid, setGrid, selection, picked: () => setSelection((n) => n + 1) }}>
      {children}
    </Context>
  )
}
export const useShellNavigation = () => useContext(Context)!

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
    navigation.setScope({ entity, chat: null })
    navigation.setGrid(false)
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
      void navigate({ to: "/cards/$entityId/chat", params: { entityId: entity }, search: { character: entity, panel } })
  }
}

export function CharacterTile({ card }: { card: ShellCard }) {
  const open = useOpenCharacter()
  const c = card.card
  return (
    <div className="relative flex min-w-0 flex-col">
      <button
        type="button"
        onClick={() => open(c.entityId)}
        aria-label={`Open ${c.label}${c.subtitle ? ` · ${c.subtitle}` : ""}`}
        className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface text-left outline-none hover:border-focus focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="aspect-[2/3] w-full overflow-hidden">
          <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} size="fill" />
        </span>
        <span className="flex w-full min-w-0 flex-col gap-0.5 p-2">
          <span className="truncate text-sm font-medium">{c.label}</span>
          {c.subtitle && <span className="truncate text-xs text-muted">{c.subtitle}</span>}
          <span className="text-xs text-muted">{c.chats ? `${c.chats} chats` : "Never used"}</span>
        </span>
      </button>
      <CardSurface placement="badge" entityId={c.entityId} />
    </div>
  )
}
