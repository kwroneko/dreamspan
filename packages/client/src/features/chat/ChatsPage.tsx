// The chat list (DESIGN §2.1): most recent first, a new chat, and delete to the bin.
import type { Chat } from "@rp/shared/chat.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { importState } from "@rp/shared/stImportApi.ts"
import { useDeletedToast } from "../bin/deleted.ts"
import { useUnseen } from "../notices.tsx"
import { useTitle } from "../shell.tsx"

const PAGE = 50

const chatsAtom = AppClient.query("ListChats", { limit: PAGE, before: null }, { reactivityKeys: ["chats"] })

/** A chat's title as shown, without the unfinished-import marker, which shows as a badge. */
export const chatTitle = (chat: Pick<Chat, "title">) => importState(chat.title).title || "Untitled chat"

/** The badges a chat's title gets: an import still unfinished (ARCHITECTURE §13). */
export function ChatBadges({ chat }: { chat: Pick<Chat, "title"> }) {
  return importState(chat.title).unfinished ? <Badge tone="warning">import unfinished</Badge> : null
}

function ChatRow({ chat, onDelete }: { chat: Chat; onDelete: (chat: Chat) => void }) {
  const unseen = useUnseen(chat.id)
  return (
    <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/chats/$chatId"
            params={{ chatId: chat.id }}
            className="truncate font-medium text-accent underline-offset-4 hover:underline"
          >
            {chatTitle(chat)}
          </Link>
          <ChatBadges chat={chat} />
          {unseen > 0 && <Badge tone="accent">{unseen === 1 ? "1 new reply" : `${unseen} new replies`}</Badge>}
        </div>
        <span className="text-sm text-muted">{when(chat)}</span>
      </div>
      <Button variant="ghost" aria-label={`Delete ${chatTitle(chat)}`} onClick={() => onDelete(chat)}>
        Delete
      </Button>
    </li>
  )
}

const when = (chat: Chat) =>
  new Date(chat.lastMessageAt ?? chat.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

function NewChat() {
  const action = useAction()
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = await action.run((client) => client("CreateChat", { title }), ["chats"])
    if (result.ok) void navigate({ to: "/chats/$chatId", params: { chatId: result.value.id } })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          aria-label="Title of the new chat"
          placeholder="Title (optional)"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary" pending={action.pending}>
          New chat
        </Button>
      </div>
      <ErrorAlert error={action.error} />
    </form>
  )
}

function ChatRows({ first }: { first: ReadonlyArray<Chat> }) {
  const action = useAction()
  const deleted = useDeletedToast()
  const remove = async (chat: Chat) => {
    const result = await action.run((client) => client("DeleteChat", { chatId: chat.id }), ["chats"])
    if (result.ok) deleted(result.value)
  }
  const [more, setMore] = useState<ReadonlyArray<Chat>>([])
  const [end, setEnd] = useState(first.length < PAGE)
  const chats = [...first, ...more]
  const loadMore = async () => {
    const last = chats.at(-1)!
    const result = await action.run((client) =>
      client("ListChats", { limit: PAGE, before: { at: last.lastMessageAt ?? last.createdAt, id: last.id } })
    )
    if (!result.ok) return
    setMore([...more, ...result.value])
    setEnd(result.value.length < PAGE)
  }
  if (chats.length === 0) {
    return (
      <EmptyState title="No chats yet">
        <p>Start one above.</p>
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {chats.map((chat) => (
          <ChatRow key={chat.id} chat={chat} onDelete={(it) => void remove(it)} />
        ))}
      </ul>
      {!end && (
        <Button className="self-start" pending={action.pending} onClick={loadMore}>
          Load more
        </Button>
      )}
      <ErrorAlert error={action.error} />
    </div>
  )
}

export function ChatsPage() {
  useTitle("Chats")
  return (
    <Card>
      <CardHeader title="Chats" description="Most recent first." />
      <div className="flex flex-col gap-5">
        <NewChat />
        <AsyncView atom={chatsAtom} loading="Loading chats…">
          {(chats) => <ChatRows key={chats.map((chat) => chat.id).join()} first={chats} />}
        </AsyncView>
      </div>
    </Card>
  )
}
