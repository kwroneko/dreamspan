// Finding a message in any chat (DESIGN §10.1 left panel; ST-COMPARISON item 21: "which chat had
// this scene?"). The left panel's chat search widens from names to message text with a pressed
// toggle beside the field; the URL says so (`sideIn=messages`) and holds the text (`sideQ`), so a
// reload shows the same results. A result is one message as written, with the branches that
// show it (SearchMessages, @dreamspan/shared/messageSearch.ts), and opens the chat on its first branch
// at that message (`fork` and `slot` in the URL). Each page of results is its own query: a
// changed text unmounts the old ones, which stops their reads on the server.
import { useAtomValue } from "@effect/atom-react"
import type { ChatId, EntityId } from "@dreamspan/shared/chat.ts"
import type { ChatBrowse } from "@dreamspan/shared/chatBrowse.ts"
import {
  type Excerpt,
  MESSAGE_SORTS,
  type MessageCursor,
  type MessageHit,
  type MessageSearchPage,
  type MessageSort,
  messageCountText
} from "@dreamspan/shared/messageSearch.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { pressedButtonClass } from "../../ui/InlinePanel.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { Spinner } from "../../ui/Spinner.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { defineSlot } from "../../slots.tsx"
import { forkLabel, formatMoment } from "../chat/forks.ts"
import { SortDirection } from "./cardBrowse.tsx"
import { SortControl } from "./ChatBrowseBar.tsx"
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

/** The URL keys of the message search's sort and its direction (the Chat sort's Z to A). */
const SORT_KEY = "sideMsgSort"
const REVERSE_KEY = "sideMsgReverse"

interface MessageSortChoice {
  readonly sort: MessageSort
  readonly reversed: boolean
}

/** How found messages are listed, from the URL (Best match by default), and a way to change it. */
function useMessageSort() {
  const sort = useSearch({
    strict: false,
    select: (s: Record<string, unknown>) => MESSAGE_SORTS.find((v) => v === s[SORT_KEY]) ?? "best"
  })
  const reversed = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[REVERSE_KEY] === true })
  const navigate = useNavigate()
  const set = (next: MessageSortChoice) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [SORT_KEY]: next.sort === "best" ? undefined : next.sort,
        [REVERSE_KEY]: next.sort === "chat" && next.reversed ? true : undefined
      }),
      replace: true,
      resetScroll: false
    })
  return [{ sort, reversed: sort === "chat" && reversed }, set] as const
}

const SORTS = {
  best: { label: "Best match", hint: "Messages with the words side by side first, then the rest, newest first" },
  newest: { label: "Newest", hint: "Orders messages from the newest" },
  oldest: { label: "Oldest", hint: "Orders messages from the oldest" },
  chat: { label: "Chat", hint: "Groups messages by chat, chats by name, newest first in each" }
} as const

/** The message search's sort, in the chat list's browse row in place of the chats' sort. */
export function MessageSortControl() {
  const [{ sort, reversed }, set] = useMessageSort()
  return (
    <SortControl
      noun="messages"
      sorts={SORTS}
      order={MESSAGE_SORTS}
      value={sort}
      onChange={(next) => set({ sort: next, reversed: false })}
    >
      <SortDirection
        order={sort === "chat" ? "name" : "date"}
        reversed={sort === "chat" ? reversed : sort === "oldest"}
        onToggle={() =>
          set(
            sort === "chat"
              ? { sort, reversed: !reversed }
              : { sort: sort === "oldest" ? "newest" : "oldest", reversed: false }
          )
        }
        disabledReason={sort === "best" ? "Best matches come first; pick Newest or Oldest to order by date" : undefined}
      />
    </SortControl>
  )
}

/** Beside the left panel's chat search field: replaceable, registered by the characters feature. */
export const sidebarSearchTools = defineSlot<{ grid: boolean }>("sidebar.search-tools")
/**
 * What the left panel lists while its search looks through message text: in the chats the
 * chat list's filter shows (`filter`), of one character's when `entity` is given.
 */
interface MessageResultsProps {
  readonly text: string
  readonly filter: ChatBrowse["filter"]
  readonly entity: EntityId | null
}
export const sidebarMessageResults = defineSlot<MessageResultsProps>("sidebar.message-results")

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
          ? "Searching the text of messages in the chats the filter shows. Words in quotes are found as written, side by side. Click to search chat and character names again."
          : "Click to search the text of messages in the chats the filter shows instead of names."
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

/** One search: its words and the chats and order it's in. */
interface Search extends MessageSortChoice {
  readonly text: string
  readonly filter: ChatBrowse["filter"]
  readonly entity: EntityId | null
}

export function MessageResults({ text, filter, entity }: MessageResultsProps) {
  const settled = useSettled(text.trim().slice(0, 200), 300)
  const [sort] = useMessageSort()
  const search: Search = { text: settled, filter, entity, ...sort }
  const key = JSON.stringify(search)
  return (
    <>
      {/* Its line is kept while the search is on, so the list doesn't move as the count comes. */}
      <p data-message-count aria-live="polite" className="h-4 truncate px-2 text-xs leading-4 text-muted">
        {settled.length >= 2 && <Count key={key} search={search} />}
      </p>
      {settled.length < 2 ? (
        <p className="p-2 text-sm text-muted">Type at least two letters to find them in your messages.</p>
      ) : (
        <Pages key={key} search={search} />
      )}
    </>
  )
}

/** "128 messages in 14 chats", or "1,000+ messages" past what a count reads. */
function Count({ search }: { search: Search }) {
  const atom = useMemo(
    () =>
      AppClient.query("CountMessages", {
        text: search.text,
        filter: search.filter,
        entity: search.entity
      }),
    [search.text, search.filter, search.entity]
  )
  const result = useAtomValue(atom)
  return AsyncResult.isSuccess(result) ? messageCountText(result.value) : null
}

function Pages({ search }: { search: Search }) {
  const [pages, setPages] = useState<{
    firstPage?: MessageSearchPage
    cursors: ReadonlyArray<MessageCursor | null>
  }>({ cursors: [null] })
  const { firstPage, cursors } = pages
  const restart = useCallback((firstPage: MessageSearchPage) => setPages({ firstPage, cursors: [null] }), [])
  const onMore = (next: MessageCursor) => setPages((current) => ({ ...current, cursors: [...current.cursors, next] }))
  return (
    <ul aria-label="Messages found" className="flex flex-col gap-1">
      {cursors.map((cursor, i) => {
        const props = { search, first: i === 0, last: i === cursors.length - 1, onMore }
        return cursor === null && firstPage !== undefined ? (
          <PageRows key="first" page={firstPage} {...props} />
        ) : (
          <Page
            key={
              cursor === null
                ? "first"
                : `${cursor.chatOrder ?? cursor.phase ?? "together"}/${cursor.chat ?? ""}/${cursor.before}`
            }
            cursor={cursor}
            restart={restart}
            {...props}
          />
        )
      })}
    </ul>
  )
}

interface PageRowsProps {
  search: Search
  first: boolean
  last: boolean
  onMore: (next: MessageCursor) => void
}

function Page({
  cursor,
  restart,
  ...props
}: PageRowsProps & { cursor: MessageCursor | null; restart: (firstPage: MessageSearchPage) => void }) {
  const { search } = props
  const { text } = search
  // Keep loaded pages fixed. Refreshing the first page while retaining older cursors
  // would drop its former last row whenever a new reply arrives. `search` is fixed per list (its key).
  const atom = useMemo(
    () =>
      AppClient.query("SearchMessages", {
        text,
        cursor,
        sort: search.sort,
        reversed: search.reversed,
        filter: search.filter,
        entity: search.entity
      }),
    [text, cursor, search.sort, search.reversed, search.filter, search.entity]
  )
  const result = useAtomValue(atom)
  const page = AsyncResult.isSuccess(result) ? result.value : null
  useEffect(() => {
    if (page?.restarted) restart(page)
  }, [page, restart])
  if (AsyncResult.isFailure(result))
    return <li className="p-2 text-sm text-danger">The search couldn't be finished. Try again in a moment.</li>
  if (!page)
    return (
      <li className="flex items-center gap-2 p-2 text-sm text-muted">
        <Spinner /> Searching your messages…
      </li>
    )
  return page.restarted ? null : <PageRows page={page} {...props} />
}

function PageRows({ page, search, first, last, onMore }: PageRowsProps & { page: MessageSearchPage }) {
  return (
    <>
      {first && page.hits.length === 0 && page.next === null && (
        <li className="p-2 text-sm text-muted">
          No message {search.filter === "all" && search.entity === null ? "in your chats" : "in these chats"} has “
          {search.text}”.
        </li>
      )}
      {page.hits.map((hit) => (
        <HitRow key={hit.versionId} hit={hit} />
      ))}
      {last && page.next !== null && (
        <li>
          <Tooltip label="Searches further through your messages.">
            <button
              type="button"
              onClick={() => onMore(page.next!)}
              className="mt-1 px-2 py-1 text-xs text-accent hover:underline"
            >
              {page.hits.length === 0 ? "Search further" : "Show more"}
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
            <span data-hit-chat data-layout-name className="min-w-0 flex-1 truncate font-medium">
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
