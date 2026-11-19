import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
// The chats as a page (DESIGN §2.1): the sidebar's list, full width, for phones, where the
// sidebar is folded away. Chats with characters start from the character grid; this page
// also starts one without any, and whatever else is registered (a workshop).
import type { Chat } from "@dreamspan/shared/chat.ts"
import { importState } from "@dreamspan/shared/stImportApi.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useEffect } from "react"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { ChatList, useRefreshChats } from "./ChatList.tsx"
import { KindBadge } from "./KindBadge.tsx"

/** The badges a chat's title gets: its kind's, and an import still unfinished (ARCHITECTURE §13). */
export function ChatBadges({ chat }: { chat: Pick<Chat, "title" | "kind"> }) {
  return (
    <>
      <KindBadge kind={chat.kind} />
      {importState(chat.title).unfinished && <Badge tone="warning">import unfinished</Badge>}
    </>
  )
}

/**
 * The Chats page's cards for starting a chat that isn't with a character, under the list
 * (spec/WORKSHOP.md §2.2): a chat without characters, and what features add (the workshop's).
 */
export const chatStartSections = defineSlot<object>("chats.start-sections")

/** Where an empty chat's title is kept until it's made: the start card and the page share it. */
export const EMPTY_CHAT_TITLE = "chat:new"

/**
 * A start card's form: an optional title and its button, which opens the chat not made yet
 * (`to`, with `search`); it's made by its first message there (owner, 2026-11-17: "The chat is
 * created when the first message is sent"), and the title, kept as a draft, can change there too.
 */
export function StartChatForm({
  draft,
  label,
  button,
  hint,
  to,
  search = {},
  extra
}: {
  /** The user draft the title is kept under, which the page opened reads. */
  draft: string
  /** The title field's accessible name. */
  label: string
  button: string
  hint: string
  /** The page of the chat not made yet. */
  to: "/new/chat" | "/new/workshop"
  search?: Record<string, string>
  /** Choices above the title, such as who a workshop starts with. */
  extra?: ReactNode
}) {
  const navigate = useNavigate()
  const durable = useUserDraft(draft, "Title", "")
  const { text: title, setText: setTitle } = durable
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate({ to, search })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <UserDraftStatus draft={durable} />
      {extra}
      <div className="flex gap-2">
        <Input
          aria-label={label}
          placeholder="Title (optional)"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Button hint={hint} type="submit">
          {button}
        </Button>
      </div>
    </form>
  )
}

/** A chat with nobody in it yet: for notes, or trying a model. Characters join from the composer. */
export function EmptyChatCard() {
  return (
    <Card>
      <CardHeader title="A chat without characters" about="Characters can join later, from the Cast tab." />
      <StartChatForm
        draft={EMPTY_CHAT_TITLE}
        label="Title of the new chat"
        button="New chat"
        hint="Opens a new chat. It's saved when you send its first message."
        to="/new/chat"
      />
    </Card>
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
      <SlotOutlet slot={chatStartSections} props={{}} />
    </div>
  )
}
