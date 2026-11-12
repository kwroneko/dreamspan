// Finding a message in any chat (DESIGN §10.1 left panel; ST-COMPARISON item 21: "which chat had
// this scene?"). The left panel's chat search widens from names to message text with a pressed
// toggle beside the field; the URL says so (`sideIn=messages`) and holds the text (`sideQ`), so a
// reload shows the same results. A result is one message as written, with the branches that
// show it (SearchMessages, @rp/shared/messageSearch.ts), and opens the chat on its first branch
// at that message (`fork` and `slot` in the URL). Each page of results is its own query: a
// changed text unmounts the old ones, which stops their reads on the server.
import { useAtomValue } from "@effect/atom-react"
import type { ChatId } from "@rp/shared/chat.ts"
import type { Excerpt, MessageCursor, MessageHit } from "@rp/shared/messageSearch.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { pressedButtonClass } from "../../ui/InlinePanel.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { Spinner } from "../../ui/Spinner.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { defineSlot } from "../../slots.tsx"
import { forkLabel, formatMoment } from "../chat/forks.ts"
import { useShellNavigation } from "./shellData.tsx"

/** The URL key that widens the left panel's chat search to message text. */
const MESSAGE_SEARCH_KEY = "sideIn"

/** Whether the left panel's chat search looks through message text, and a way to switch it. */
export function useMessageSearch() {
  const on = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[MESSAGE_SEARCH_KEY] === "messages" })
  const navigate = useNavigate()
  const set = (next: boolean) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, [MESSAGE_SEARCH_KEY]: next ? "messages" : undefined }),
      replace: true,
      resetScroll: false
    })
  return [on, set] as const
}

/** Beside the left panel's chat search field: replaceable, registered by the characters feature. */
export const sidebarSearchTools = defineSlot<{ grid: boolean }>("sidebar.search-tools")
/** What the left panel lists while its search looks through message text. */
export const sidebarMessageResults = defineSlot<{ text: string }>("sidebar.message-results")

export function MessageSearchToggle({ grid }: { grid: boolean }) {
  const [on, set] = useMessageSearch()
  if (grid) return null
  return (
    <Button
      aria-label="Search message text"
      aria-pressed={on}
      variant="ghost"
      className={`h-9! w-9! shrink-0 px-0! ${pressedButtonClass}`}
      hint={
        on
          ? "Searching the text of messages in all your chats. Click to search chat and character names again."
          : "Click to search the text of messages in all your chats instead of names."
      }
      onClick={() => set(!on)}
    >
      <Icon name="chat" />
    </Button>
  )
}

/** What's typed, once typing pauses. */
const useSettled = (value: string, ms: number) => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export function MessageResults({ text }: { text: string }) {
  const settled = useSettled(text.trim().slice(0, 200), 300)
  if (settled.length < 2)
    return <p className="p-2 text-sm text-muted">Type at least two letters to find them in your messages.</p>
  return <Pages key={settled} text={settled} />
}

function Pages({ text }: { text: string }) {
  const [cursors, setCursors] = useState<ReadonlyArray<MessageCursor | null>>([null])
  return (
    <ul aria-label="Messages found" className="flex flex-col gap-1">
      {cursors.map((cursor, i) => (
        <Page
          key={cursor?.before ?? "first"}
          text={text}
          cursor={cursor}
          first={i === 0}
          last={i === cursors.length - 1}
          onMore={(next) => setCursors([...cursors, next])}
        />
      ))}
    </ul>
  )
}

function Page({
  text,
  cursor,
  first,
  last,
  onMore
}: {
  text: string
  cursor: MessageCursor | null
  first: boolean
  last: boolean
  onMore: (next: MessageCursor) => void
}) {
  // Keep loaded pages fixed. Refreshing the first page while retaining older cursors
  // would drop its former last row whenever a new reply arrives.
  const atom = useMemo(() => AppClient.query("SearchMessages", { text, cursor }), [text, cursor])
  const result = useAtomValue(atom)
  if (AsyncResult.isFailure(result))
    return <li className="p-2 text-sm text-danger">The search couldn't be finished. Try again in a moment.</li>
  if (!AsyncResult.isSuccess(result))
    return (
      <li className="flex items-center gap-2 p-2 text-sm text-muted">
        <Spinner /> Searching your messages…
      </li>
    )
  const page = result.value
  return (
    <>
      {first && page.hits.length === 0 && page.next === null && (
        <li className="p-2 text-sm text-muted">No message in your chats has “{text}”.</li>
      )}
      {page.hits.map((hit) => (
        <HitRow key={hit.versionId} hit={hit} />
      ))}
      {last && page.next !== null && (
        <li>
          <Tooltip label="Searches older messages.">
            <button
              type="button"
              onClick={() => onMore(page.next!)}
              className="mt-1 px-2 py-1 text-xs text-accent hover:underline"
            >
              {page.hits.length === 0 ? "Search older messages" : "Show more"}
            </button>
          </Tooltip>
        </li>
      )}
    </>
  )
}

/** The excerpt with its matches marked. */
function Marked({ excerpt }: { excerpt: Excerpt }) {
  const parts: Array<ReactNode> = []
  let at = 0
  excerpt.marks.forEach((mark, i) => {
    parts.push(excerpt.text.slice(at, mark.at))
    parts.push(
      <mark key={i} className="rounded-sm bg-warning/30 text-text">
        {excerpt.text.slice(mark.at, mark.at + mark.length)}
      </mark>
    )
    at = mark.at + mark.length
  })
  parts.push(excerpt.text.slice(at))
  return (
    <>
      {excerpt.before && "…"}
      {parts}
      {excerpt.after && "…"}
    </>
  )
}

function HitRow({ hit }: { hit: MessageHit }) {
  const navigate = useNavigate()
  const navigation = useShellNavigation()
  const branch = hit.branches[0]!
  const label = forkLabel(branch)
  const others = hit.branchCount - 1
  const where = { to: "/chats/$chatId" as const, params: { chatId: hit.chatId as ChatId } }
  const open = () => {
    navigation.picked()
    void navigate({ ...where, search: { fork: branch.forkId, slot: hit.slotId } })
  }
  const branchNames = hit.branches.map((b) => forkLabel(b)).join(", ")
  return (
    <li>
      <Tooltip
        label={`Opens ${hit.chatName} at message #${hit.position} on ${label}.${others > 0 ? ` The message is on ${hit.branchCount.toLocaleString()} branches: ${branchNames}${hit.branchCount > hit.branches.length ? "…" : ""}.` : ""}`}
      >
        <Link
          {...where}
          search={{ fork: branch.forkId, slot: hit.slotId }}
          onClick={openOnPlainClick(open)}
          data-message-hit
          className="flex w-full max-w-controls min-w-0 flex-col gap-0.5 rounded-md border border-border p-2 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="flex min-w-0 items-baseline gap-2 text-sm">
            <span data-hit-chat className="min-w-0 flex-1 truncate font-medium">
              {hit.chatName}
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{formatMoment(hit.createdAt)}</span>
          </span>
          <span data-hit-text className="line-clamp-3 text-sm [overflow-wrap:anywhere]">
            <span className="font-medium">{hit.speaker}:</span> <Marked excerpt={hit.excerpt} />
          </span>
          <span data-hit-branch className="flex min-w-0 items-center gap-1 text-xs text-muted">
            <Icon name="branch" size={12} />
            <span className="min-w-0 truncate">
              #{hit.position} on {label}
              {others > 0 && ` and ${others.toLocaleString()} other branch${others === 1 ? "" : "es"}`}
            </span>
          </span>
        </Link>
      </Tooltip>
    </li>
  )
}
