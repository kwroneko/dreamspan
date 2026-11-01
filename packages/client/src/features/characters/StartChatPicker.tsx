// The sidebar's "Start a chat": a search over the characters, most recently used first,
// that opens a new chat with the one picked (its greeting; nothing is saved until the first
// send, DESIGN §2.1). Registered in the sidebar's actions slot, so a plugin can replace it.
import { useAtomValue } from "@effect/atom-react"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Input } from "../../ui/Field.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import { sortCards } from "./cardRecency.ts"
import { shellAtom, sidebarCleared, useShellNavigation, type ShellLibrary } from "./shellData.tsx"

/** Enough to pick from; a name narrows the rest. */
const SHOWN = 40

const matching = (data: ShellLibrary, needle: string) => {
  const words = needle.trim().toLowerCase()
  return sortCards(
    data.cards.filter((c) => [c.card.label, c.card.name, c.card.subtitle].some((n) => n.toLowerCase().includes(words))),
    "recent"
  )
}
/** The card's tab beside the new chat where there's room; on a phone it would cover the chat. */
const startSearch = (entityId: ShellLibrary["cards"][number]["card"]["entityId"], wide: boolean) => ({
  ...sidebarCleared,
  character: entityId,
  ...(wide ? { panel: `card:${entityId}` } : {})
})

function Choices({ needle, onPick }: { needle: string; onPick: () => void }) {
  const wide = useWide()
  const result = useAtomValue(shellAtom)
  if (!AsyncResult.isSuccess(result)) return <Loading label="Loading characters…" />
  const data = result.value
  const matches = matching(data, needle)
  if (!matches.length)
    return (
      <p className="px-1 py-2 text-sm text-muted">
        {data.cards.length ? "No character by that name." : "No characters yet."}
      </p>
    )
  return (
    <ul aria-label="Characters" className="-mx-1 flex min-h-0 flex-col overflow-y-auto">
      {matches.slice(0, SHOWN).map((c) => {
        const last = c.recentAt ?? undefined
        return (
          <li key={c.card.entityId}>
            <Link
              to="/cards/$entityId/chat"
              params={{ entityId: c.card.entityId }}
              search={startSearch(c.card.entityId, wide)}
              onClick={onPick}
              className="flex items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Avatar
                id={c.card.entityId}
                name={c.card.name}
                mediaId={c.card.avatarMediaId}
                crop={c.card.avatarCrop}
                size="sm"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm" title={c.card.label}>
                  {c.card.label}
                </span>
                <span className="truncate text-xs text-muted">
                  {c.card.subtitle ? `${c.card.subtitle} · ` : ""}
                  {last === undefined ? "Never used" : `Last chat ${new Date(last).toLocaleDateString()}`}
                </span>
              </span>
            </Link>
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
          const [first] = matching(result.value, needle)
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
      <Choices needle={needle} onPick={picked} />
    </Popover>
  )
}
