// The sidebar's "Start a chat": a search over the characters, with the characters' filter and
// sort (no Groups: a group chat starts from its group), that opens a new chat with the one
// picked (its greeting; nothing is saved until the first send, DESIGN §2.1). Registered in the
// sidebar's actions slot, so a plugin can replace it.
import { useAtomValue } from "@effect/atom-react"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Input } from "../../ui/Field.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import { type CardBrowse, browseCards, FavouriteStar, SortDate, useCardBrowse } from "./cardBrowse.tsx"
import { CardBrowseBar } from "./CardBrowseBar.tsx"
import { shellAtom, sidebarCleared, useShellNavigation, type ShellLibrary } from "./shellData.tsx"

/** Enough to pick from; a name narrows the rest. */
const SHOWN = 40

/** Groups aren't offered here: a remembered Groups reads as All. */
const matching = (data: ShellLibrary, browse: CardBrowse, needle: string) =>
  browseCards(data.cards, browse.filter === "groups" ? { ...browse, filter: "all" } : browse, needle)

/** The card's tab beside the new chat where there's room; on a phone it would cover the chat. */
const startSearch = (entityId: ShellLibrary["cards"][number]["card"]["entityId"], wide: boolean) => ({
  ...sidebarCleared,
  character: entityId,
  ...(wide ? { panel: `card:${entityId}` } : {})
})

function Choices({
  data,
  browse,
  needle,
  onPick
}: {
  data: ShellLibrary
  browse: CardBrowse
  needle: string
  onPick: () => void
}) {
  const wide = useWide()
  const matches = matching(data, browse, needle)
  if (!matches.length)
    return (
      <p className="px-1 py-2 text-sm text-muted">
        {!data.cards.length
          ? "No characters yet."
          : needle.trim()
            ? "No character by that name."
            : browse.filter === "favourites"
              ? "No favourites yet: star a character to keep it here."
              : "No characters here."}
      </p>
    )
  return (
    <ul aria-label="Characters" className="-mx-1 flex min-h-0 flex-col overflow-y-auto">
      {matches.slice(0, SHOWN).map((c) => {
        const last = c.recentAt ?? undefined
        return (
          <li key={c.card.entityId} className="flex min-w-0 items-center gap-0.5">
            <Link
              to="/cards/$entityId/chat"
              params={{ entityId: c.card.entityId }}
              search={startSearch(c.card.entityId, wide)}
              onClick={onPick}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Avatar id={c.card.entityId} name={c.card.name} mediaId={c.card.avatarMediaId} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm" title={c.card.label}>
                  {c.card.label}
                </span>
                {/* The date a date sort orders by ends the line, as on the tiles. */}
                <span className="flex min-w-0 items-baseline justify-between gap-1.5 text-xs text-muted">
                  <span className="min-w-0 truncate">
                    {c.card.subtitle ? `${c.card.subtitle} · ` : ""}
                    {last === undefined ? "Never used" : `Last chat ${new Date(last).toLocaleDateString()}`}
                  </span>
                  {browse.sort !== "recent" && <SortDate card={c} sort={browse.sort} />}
                </span>
              </span>
            </Link>
            <FavouriteStar card={c} />
          </li>
        )
      })}
      {matches.length > SHOWN && (
        <li className="px-1 pt-1 text-xs text-muted">{matches.length - SHOWN} more: type a name to find them.</li>
      )}
    </ul>
  )
}

export function StartChatPicker({ onNavigate }: { onNavigate: (() => void) | undefined }) {
  const [open, setOpen] = useState(false)
  const [needle, setNeedle] = useState("")
  const [browse, setBrowse] = useCardBrowse("start")
  const search = useRef<HTMLInputElement>(null)
  const navigation = useShellNavigation()
  const navigate = useNavigate()
  const wide = useWide()
  const result = useAtomValue(shellAtom)
  const picked = () => {
    setOpen(false)
    setNeedle("")
    navigation.picked()
    onNavigate?.()
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setNeedle("")
      }}
      trigger="Start a chat"
      triggerLabel="Start a chat"
      title="Start a chat with…"
      side="bottom"
      align="end"
      initialFocus={search}
      triggerClassName="shrink-0 rounded-md px-2 py-1 text-sm text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Input
        ref={search}
        type="search"
        aria-label="Find a character"
        placeholder="Find by name"
        // The list below scrolls; the field keeps its height.
        className="shrink-0"
        value={needle}
        onChange={(e) => setNeedle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !AsyncResult.isSuccess(result)) return
          // Enter starts with the first match, as the list shows it.
          const [first] = matching(result.value, browse, needle)
          if (!first) return
          e.preventDefault()
          picked()
          void navigate({
            to: "/cards/$entityId/chat",
            params: { entityId: first.card.entityId },
            search: startSearch(first.card.entityId, wide)
          })
        }}
      />
      {AsyncResult.isSuccess(result) ? (
        <>
          <CardBrowseBar
            data={result.value}
            browse={browse.filter === "groups" ? { ...browse, filter: "all" } : browse}
            onChange={setBrowse}
          />
          <Choices data={result.value} browse={browse} needle={needle} onPick={picked} />
        </>
      ) : (
        <Loading label="Loading characters…" />
      )}
    </Popover>
  )
}
