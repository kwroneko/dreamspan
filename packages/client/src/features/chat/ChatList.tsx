// The chat list (DESIGN §2.1): every chat, most recent message first, each with its cast's
// faces, a readable name (the group's or the character's, never ST's file name), when it
// started, how long it is and how it ends. It's the sidebar on wide screens, the chats page
// on phones, a card's chats on its page and a group's on its own. It reads a page at a time, with Load more for
// older chats; finding a chat asks the server, so it finds chats not loaded yet.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { Chat, ChatId, ChatSummary, EntityId } from "@rp/shared/chat.ts"
import { chatCursor } from "@rp/shared/chatApi.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useRouterState } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type MouseEvent, useEffect, useMemo, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { AvatarStack } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useUnseen } from "../notices.tsx"
import { chatName, formatDay, formatWhen } from "./chatTitle.ts"

const PAGE = 50

/** Which chats a list shows: a card's (`entityId`), those found by `search`, or all. */
interface Query {
  readonly entityId?: EntityId
  readonly search?: string
}

const firstPage = (query: Query) =>
  AppClient.query("ListChats", { limit: PAGE, before: null, ...query }, { reactivityKeys: ["chats", "library"] })

/** All the chats' first page: the sidebar's, refreshed on its own. */
const chatsAtom = firstPage({})

/**
 * Where a chat sits in the server's order (ListChats), newest first: a card's chats put
 * those with a message first. Compared as the server compares the cursor.
 */
type Key = readonly [number, number, string]
const keyOf = (chat: Chat, query: Query): Key => [
  query.entityId !== undefined && chat.lastMessageAt !== null ? 1 : 0,
  chat.lastMessageAt ?? chat.createdAt,
  chat.id
]
/** Whether `a` comes after (is older than) `b`. */
const after = (a: Key, b: Key) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2])

/** Shows a clipped text in full on hover. */
const titleIfClipped = (text: string) => (event: MouseEvent<HTMLElement>) => {
  const element = event.currentTarget
  element.title = element.scrollWidth > element.clientWidth ? text : ""
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`

function Row({
  chat,
  summary,
  active,
  onDelete
}: {
  chat: Chat
  summary: ChatSummary | undefined
  active: boolean
  onDelete: () => void
}) {
  const unseen = useUnseen(chat.id)
  const { title, unfinished } = importState(chat.title)
  const characters = (summary?.cast ?? []).filter((card) => !card.persona)
  const name = chatName(title, characters)
  const speaker = summary?.last?.speaker
    ? summary.cast.find((card) => card.entityId === summary.last!.speaker)?.name
    : null
  const others = characters
    .filter((card) => card.name !== name.name || card.subtitle)
    .map((card) => `${card.name}${card.subtitle ? ` · ${card.subtitle}` : ""}`)
  return (
    <li className="group relative">
      <Link
        to="/chats/$chatId"
        params={{ chatId: chat.id }}
        aria-current={active ? "page" : undefined}
        className={`flex gap-3 rounded-lg px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:pr-16 ${
          active ? "bg-surface-raised" : "hover:bg-surface-raised/60"
        }`}
      >
        <AvatarStack
          faces={characters.map((card) => ({ id: card.entityId, name: card.name, mediaId: card.avatarMediaId }))}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate ${unseen > 0 ? "font-semibold" : "font-medium"}`}
              onMouseEnter={titleIfClipped(name.name)}
            >
              {name.name}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted">
              {formatWhen(chat.lastMessageAt ?? chat.createdAt)}
            </span>
          </span>
          {/* What tells two chats of the same cast apart, on a line of its own so it's never cut off. */}
          <span data-chat-meta className="text-xs text-muted">
            <span className="whitespace-nowrap">started {formatDay(name.started ?? new Date(chat.createdAt))}</span>
            {summary && (
              <>
                {" · "}
                <span className="whitespace-nowrap">{plural(summary.messages, "message")}</span>
              </>
            )}
          </span>
          {others.length > 0 && (
            <span className="truncate text-xs text-muted" onMouseEnter={titleIfClipped(others.join(", "))}>
              with {others.join(", ")}
            </span>
          )}
          {summary?.last && (
            <span className="truncate text-sm text-muted">
              {speaker ? <span className="text-text">{speaker}: </span> : null}
              {summary.last.text.replace(/\s+/g, " ")}
            </span>
          )}
          {(unseen > 0 || unfinished) && (
            <span className="mt-0.5 flex gap-1.5 text-xs">
              {unseen > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-accent-contrast">
                  {unseen === 1 ? "1 new reply" : `${unseen} new replies`}
                </span>
              )}
              {unfinished && <span className="text-warning">import unfinished</span>}
            </span>
          )}
        </span>
      </Link>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${name.name}${name.started ? `, started ${formatDay(name.started)}` : ""}`}
        title="Delete (to the bin)"
        className="absolute top-2 right-2 hidden rounded bg-surface-raised px-1.5 py-0.5 text-xs text-muted outline-none group-focus-within:block group-hover:block hover:text-danger focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:top-auto pointer-coarse:bottom-2 pointer-coarse:block"
      >
        Delete
      </button>
    </li>
  )
}

/** Chats as the list shows them, each with its cast, length and last message, a page at a time. */
function Rows({ chats, onDelete }: { chats: ReadonlyArray<Chat>; onDelete: (chat: Chat) => void }) {
  // Keyed by the ids, not the array, which is new on every read.
  const key = chats.map((chat) => chat.id).join()
  const summariesAtom = useMemo(
    () =>
      AppClient.query(
        "ListChatSummaries",
        { chatIds: key === "" ? [] : (key.split(",") as Array<ChatId>) },
        { reactivityKeys: ["chats", "library"] }
      ),
    [key]
  )
  const summaries = useAtomValue(summariesAtom)
  const byId = new Map(
    (AsyncResult.isSuccess(summaries) ? summaries.value : []).map((summary) => [summary.chatId as string, summary])
  )
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return chats.map((chat) => (
    <Row
      key={chat.id}
      chat={chat}
      summary={byId.get(chat.id)}
      active={pathname.startsWith(`/chats/${chat.id}`)}
      onDelete={() => onDelete(chat)}
    />
  ))
}

/**
 * The first page as the server has it now, and the older pages loaded since. A refreshed
 * first page is right up to its last chat: older pages' chats above that are gone or have
 * moved up into it. Chats it pushed out are read again from its end.
 */
function Loaded({ first, query }: { first: ReadonlyArray<Chat>; query: Query }) {
  const [older, setOlder] = useState<ReadonlyArray<Chat>>([])
  const [end, setEnd] = useState(false)
  /**
   * Chats deleted here, hidden until the list they were in is read again from the server:
   * each with the first page and the older pages as they were when it was deleted.
   */
  const [gone, setGone] = useState<ReadonlyMap<string, readonly [ReadonlyArray<Chat>, ReadonlyArray<Chat>]>>(new Map())
  const more = useAction()
  const fill = useAction()
  const action = useAction()
  const deleted = useDeletedToast()
  const firstEnd = first.length < PAGE
  const last = first.at(-1)
  const inFirst = new Set(first.map((chat) => chat.id))
  const chats = [
    ...first,
    ...(firstEnd || last === undefined
      ? []
      : older.filter((chat) => !inFirst.has(chat.id) && after(keyOf(chat, query), keyOf(last, query))))
  ].filter((chat) => {
    const at = gone.get(chat.id)
    return at === undefined || (inFirst.has(chat.id) ? at[0] !== first : at[1] !== older)
  })

  /** The page after `from`. */
  const pageAfter = (from: Chat) => (client: AppClient["Service"]) =>
    client("ListChats", { limit: PAGE, before: chatCursor(from), ...query })
  /** The page read after `from` replaces what was loaded between `from` and its end. */
  const cover = (from: Chat, rows: ReadonlyArray<Chat>) => {
    const complete = rows.length < PAGE
    const start = keyOf(from, query)
    const stop = rows.at(-1)
    const ids = new Set(rows.map((chat) => chat.id))
    setOlder((current) =>
      [
        ...current.filter(
          (chat) =>
            !ids.has(chat.id) &&
            (!after(keyOf(chat, query), start) ||
              (!complete && stop !== undefined && after(keyOf(chat, query), keyOf(stop, query))))
        ),
        ...rows
      ].sort((a, b) => (after(keyOf(a, query), keyOf(b, query)) ? 1 : -1))
    )
    if (complete) setEnd(true)
  }
  const loadMore = async () => {
    const from = chats.at(-1)
    if (from === undefined) return
    const result = await more.run(pageAfter(from))
    if (result.ok) cover(from, result.value)
  }
  // The first page read again (a chat deleted, restored or added, here or elsewhere): the
  // older pages loaded are read again as far as they went, so they agree with the server.
  useEffect(() => {
    if (older.length === 0 || firstEnd || last === undefined) return
    const target = older.length
    let live = true
    void (async () => {
      const rows: Array<Chat> = []
      let from = last
      let complete = false
      while (rows.length < target) {
        const result = await fill.run(pageAfter(from))
        if (!live || !result.ok) return
        rows.push(...result.value)
        const next = result.value.at(-1)
        if (result.value.length < PAGE || next === undefined) {
          complete = true
          break
        }
        from = next
      }
      setOlder(rows)
      setEnd(complete)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the first page is read again
  }, [first])

  const remove = async (chat: Chat) => {
    const result = await action.run((client) => client("DeleteChat", { chatId: chat.id }), ["chats"])
    if (!result.ok) return
    setGone(new Map([...gone, [chat.id, [first, older] as const]]))
    deleted(result.value)
  }
  const pages = Array.from({ length: Math.ceil(chats.length / PAGE) }, (_, i) => chats.slice(i * PAGE, (i + 1) * PAGE))
  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
      {chats.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">
          {query.search
            ? `No chat's title or characters have “${query.search}”.`
            : "No chats yet. Pick a character to start one, or import your SillyTavern folder."}
        </p>
      ) : (
        <ul aria-label="Chats" className="flex flex-col gap-0.5">
          {pages.map((page, i) => (
            <Rows key={i} chats={page} onDelete={(chat) => void remove(chat)} />
          ))}
        </ul>
      )}
      {!firstEnd && !end && last !== undefined && (
        <Button variant="ghost" className="self-center" pending={more.pending} onClick={() => void loadMore()}>
          Load more
        </Button>
      )}
      <ErrorAlert error={more.error ?? action.error} />
    </div>
  )
}

/**
 * A list given whole, as a group's chats are: its pages' summaries are read as the full
 * list's are. A chat deleted here stays hidden until the list is read again.
 */
function Given({ chats, onDeleted }: { chats: ReadonlyArray<Chat>; onDeleted?: ((chat: Chat) => void) | undefined }) {
  const [gone, setGone] = useState<ReadonlyMap<string, ReadonlyArray<Chat>>>(new Map())
  const action = useAction()
  const deleted = useDeletedToast()
  const shown = chats.filter((chat) => gone.get(chat.id) !== chats)
  const remove = async (chat: Chat) => {
    const result = await action.run((client) => client("DeleteChat", { chatId: chat.id }), ["chats"])
    if (!result.ok) return
    setGone(new Map([...gone, [chat.id, chats]]))
    deleted(result.value)
    onDeleted?.(chat)
  }
  const pages = Array.from({ length: Math.ceil(shown.length / PAGE) }, (_, i) => shown.slice(i * PAGE, (i + 1) * PAGE))
  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
      {shown.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">No chats left.</p>
      ) : (
        <ul aria-label="Chats" className="flex flex-col gap-0.5">
          {pages.map((page, i) => (
            <Rows key={i} chats={page} onDelete={(chat) => void remove(chat)} />
          ))}
        </ul>
      )}
      <ErrorAlert error={action.error} />
    </div>
  )
}

function Pages({ entityId, search }: { entityId: EntityId | undefined; search: string }) {
  const query = useMemo<Query>(
    () => ({ ...(entityId === undefined ? {} : { entityId }), ...(search === "" ? {} : { search }) }),
    [entityId, search]
  )
  const atom = useMemo(
    () => (entityId === undefined && search === "" ? chatsAtom : firstPage(query)),
    [entityId, search, query]
  )
  const result = useAtomValue(atom)
  if (AsyncResult.isSuccess(result)) return <Loaded first={result.value} query={query} />
  if (AsyncResult.isFailure(result)) return <p className="px-2 text-sm text-danger">The chats couldn't be loaded.</p>
  return <Spinner />
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

/**
 * A list of chats: all of them, a card's (`entityId`), or those given (`chats`, a group's,
 * with `onDeleted` told of each deleted here). `findable` adds a box to find one by title or
 * character, among all of them, loaded or not.
 */
export function ChatList({
  entityId,
  chats,
  onDeleted,
  findable = true
}: {
  entityId?: EntityId
  chats?: ReadonlyArray<Chat>
  onDeleted?: (chat: Chat) => void
  findable?: boolean
}) {
  const [filter, setFilter] = useState("")
  const search = useSettled(filter.trim().slice(0, 200), 250)
  if (chats !== undefined) return <Given chats={chats} onDeleted={onDeleted} />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {findable && (
        <Input
          aria-label="Find a chat"
          placeholder="Find a chat or character"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      )}
      <Pages key={`${entityId ?? ""}\n${search}`} entityId={entityId} search={search} />
    </div>
  )
}

/** Reads the chats again: a chat deleted or made in another tab isn't announced to the list. */
export const useRefreshChats = () => useAtomRefresh(chatsAtom)
