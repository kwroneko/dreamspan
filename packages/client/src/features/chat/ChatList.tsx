// The chat list (DESIGN §2.1): every chat, most recent message first, each with its cast's
// faces, a readable name (the group's or the character's, never ST's file name), when it
// started, how long it is and how it ends. It's the sidebar on wide screens and the home
// screen on phones.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { Chat, ChatId, ChatSummary } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useRouterState } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { AvatarStack } from "../../ui/Avatar.tsx"
import { Input } from "../../ui/Field.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useUnseen } from "../notices.tsx"
import { chatName, formatDay, formatWhen } from "./chatTitle.ts"

const LIMIT = 200

const chatsAtom = AppClient.query("ListChats", { limit: LIMIT, before: null }, { reactivityKeys: ["chats"] })

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
  const others = characters.map((card) => card.name).filter((n) => n !== name.name)
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
            <span className={`truncate ${unseen > 0 ? "font-semibold" : "font-medium"}`}>{name.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted">
              {formatWhen(chat.lastMessageAt ?? chat.createdAt)}
            </span>
          </span>
          <span className="truncate text-xs text-muted">
            {[
              others.length > 0 ? others.join(", ") : null,
              name.started ? `started ${formatDay(name.started)}` : null,
              summary ? plural(summary.messages, "message") : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
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

/**
 * Chats as the list shows them, each with its cast, length and last message. `findable`
 * adds a box to find one by title or character.
 */
export function ChatRows({ chats, findable = true }: { chats: ReadonlyArray<Chat>; findable?: boolean }) {
  // Keyed by the ids, not the array, which is new on every read.
  const key = chats.map((chat) => chat.id).join()
  const summariesAtom = useMemo(
    () =>
      AppClient.query(
        "ListChatSummaries",
        { chatIds: key === "" ? [] : (key.split(",") as Array<ChatId>) },
        { reactivityKeys: ["chats"] }
      ),
    [key]
  )
  const summaries = useAtomValue(summariesAtom)
  const byId = new Map(
    (AsyncResult.isSuccess(summaries) ? summaries.value : []).map((summary) => [summary.chatId as string, summary])
  )
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [filter, setFilter] = useState("")
  const action = useAction()
  const deleted = useDeletedToast()
  const remove = async (chat: Chat) => {
    const result = await action.run((client) => client("DeleteChat", { chatId: chat.id }), ["chats"])
    if (result.ok) deleted(result.value)
  }
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? chats.filter((chat) =>
        [chat.title, ...(byId.get(chat.id)?.cast.map((card) => card.name) ?? [])].some((text) =>
          text.toLowerCase().includes(needle)
        )
      )
    : chats
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
      {chats.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">
          No chats yet. Pick a character to start one, or import your SillyTavern folder.
        </p>
      ) : (
        <ul aria-label="Chats" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {shown.map((chat) => (
            <Row
              key={chat.id}
              chat={chat}
              summary={byId.get(chat.id)}
              active={pathname.startsWith(`/chats/${chat.id}`)}
              onDelete={() => void remove(chat)}
            />
          ))}
          {shown.length === 0 && <li className="px-2 py-4 text-sm text-muted">No chat matches.</li>}
        </ul>
      )}
    </div>
  )
}

/** Reads the chats again: a chat deleted or made in another tab isn't announced to the list. */
export const useRefreshChats = () => useAtomRefresh(chatsAtom)

export function ChatList() {
  const result = useAtomValue(chatsAtom)
  if (AsyncResult.isSuccess(result)) return <ChatRows chats={result.value} />
  if (AsyncResult.isFailure(result)) return <p className="px-2 text-sm text-danger">The chats couldn't be loaded.</p>
  return <Spinner />
}
