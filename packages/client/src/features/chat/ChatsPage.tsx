import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
// The chats as a page (DESIGN §2.1): the sidebar's list, full width, for phones, where the
// sidebar is folded away. Chats with characters start from the character grid; this page
// also starts one without any.
import type { Chat } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useEffect } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { ChatList, useRefreshChats } from "./ChatList.tsx"

/** The badges a chat's title gets: an import still unfinished (ARCHITECTURE §13). */
export function ChatBadges({ chat }: { chat: Pick<Chat, "title"> }) {
  return importState(chat.title).unfinished ? <Badge tone="warning">import unfinished</Badge> : null
}

/** A chat with nobody in it yet: for notes, or trying a model. Characters join from the composer. */
function EmptyChat() {
  const action = useAction()
  const navigate = useNavigate()
  const durable = useUserDraft("chat:new", "Title", "")
  const { text: title, setText: setTitle } = durable
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await durable.commit(title, async () => {
      const result = await action.run((client) => client("CreateChat", { title }), ["chats"])
      if (result.ok) void navigate({ to: "/chats/$chatId", params: { chatId: result.value.id } })
      return result.ok
    })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <UserDraftStatus draft={durable} />
      <div className="flex gap-2">
        <Input
          aria-label="Title of the new chat"
          placeholder="Title (optional)"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Button hint="Opens a new chat." type="submit" pending={action.pending}>
          New chat
        </Button>
      </div>
      <ErrorAlert error={action.error} />
    </form>
  )
}

export function ChatsPage() {
  useTitle("Chats")
  // The sidebar's list may have been showing since before a chat went elsewhere.
  const refresh = useRefreshChats()
  useEffect(() => refresh(), [refresh])
  return (
    <div className="flex flex-col gap-4">
      <CenterHeaderContent>
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Chats</h1>
          <Tooltip label="Opens the character picker for a new chat.">
            <Link to="/" className="text-sm text-accent hover:underline">
              New chat with a character
            </Link>
          </Tooltip>
        </div>
      </CenterHeaderContent>
      <ChatList />
      <Card>
        <CardHeader title="A chat without characters" about="Characters can join later, from the composer." />
        <EmptyChat />
      </Card>
    </div>
  )
}
