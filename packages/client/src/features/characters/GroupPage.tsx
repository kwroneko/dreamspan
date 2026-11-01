// A group's page (DESIGN §2.1; ST's group tile opened): who's in it, Continue (its latest
// chat), New chat (`/groups/$chatId/new`, made on its first send), and every chat of the group, latest message first. A group is named by any of its
// chats (`/groups/$chatId`); a group is the chats with the same name and characters
// (`ChatGroup`), worked out on the server.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { Chat, ChatId } from "@rp/shared/chat.ts"
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { FailureView, useAction } from "../../actions.tsx"
import { describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { ChatList } from "../chat/ChatList.tsx"
import { NameDialog } from "../chat/NameDialog.tsx"
import { useTitle } from "../shell.tsx"
import { usageLine } from "./data.ts"
import { useOpenCharacter } from "./shellData.tsx"
import { GroupFaces } from "./GroupFaces.tsx"

function Page({ group, chats }: { group: ChatGroup; chats: ReadonlyArray<Chat> }) {
  useTitle(group.name)
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const navigate = useNavigate()
  const openCharacter = useOpenCharacter()
  const [renaming, setRenaming] = useState(false)
  const rename = useAction()
  return (
    <div className="flex flex-col gap-5">
      <Link to="/" className="self-start text-sm text-muted hover:text-text">
        ← Characters
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="block aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-xl">
          <GroupFaces members={group.members} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{group.name}</h1>
          <p className="text-sm text-muted">
            A group of {group.members.length}: the chats named “{group.name}” with these characters.
          </p>
          <p className="text-sm text-muted">{usageLine(group)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link to="/chats/$chatId" params={{ chatId: group.latestChatId }} className={buttonClass("primary")}>
              Continue the latest chat
            </Link>
            <Link to="/groups/$chatId/new" params={{ chatId: group.latestChatId }} className={buttonClass()}>
              New chat
            </Link>
            <Button
              onClick={() => {
                rename.clearError()
                setRenaming(true)
              }}
            >
              <Icon name="edit" />
              Rename group
            </Button>
          </div>
        </div>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <Card>
          <CardHeader title={`Chats (${chats.length.toLocaleString()})`} description="Latest message first." />
          <ChatList
            chats={chats}
            onDeleted={(chat) => {
              // The page is named by one of its chats: when that one goes, another names it.
              const next = chats.find((other) => other.id !== chat.id)
              if (chat.id === chatId && next !== undefined)
                void navigate({ to: "/groups/$chatId", params: { chatId: next.id }, replace: true })
            }}
          />
        </Card>
        <Card>
          <CardHeader title={`Characters (${group.members.length})`} />
          <ul aria-label="Characters in the group" className="flex flex-col gap-1">
            {group.members.map((member) => (
              <li key={member.entityId}>
                <button
                  type="button"
                  onClick={() => openCharacter(member.entityId)}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 outline-none hover:bg-surface-raised/60 focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Avatar
                    id={member.entityId}
                    name={member.name}
                    mediaId={member.avatarMediaId}
                    crop={member.avatarCrop}
                    size="lg"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{member.name}</span>
                    {member.subtitle && <span className="truncate text-xs text-muted">{member.subtitle}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <NameDialog
        draftTarget={`group:${chatId}:rename`}
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename group"
        label="Name"
        initial={group.name}
        description={`All ${chats.length.toLocaleString()} of its chats take the name, and so do the chats you start from here. A chat imported from SillyTavern keeps the day it started. Leave it empty to name them after their characters.`}
        maxLength={200}
        saveLabel="Rename"
        pending={rename.pending}
        error={rename.error}
        onSave={async (name) => {
          const result = await rename.run((client) => client("RenameGroup", { chatId, name }), ["chats"])
          if (result.ok) setRenaming(false)
          return result.ok
        }}
      />
    </div>
  )
}

export function GroupPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const atom = useMemo(
    () => AppClient.query("ListGroupChats", { chatId }, { reactivityKeys: ["chats", "library"] }),
    [chatId]
  )
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  if (AsyncResult.isSuccess(result)) return <Page group={result.value.group} chats={result.value.chats} />
  if (AsyncResult.isFailure(result)) {
    return describeCause(result.cause).tag === "NotFound" ? (
      <EmptyState title="This group isn't here any more">
        <p>Its chats may be in the bin, or this chat no longer has two or more characters.</p>
        <Link to="/" className={buttonClass()}>
          Characters
        </Link>
      </EmptyState>
    ) : (
      <FailureView cause={result.cause} onRetry={refresh} />
    )
  }
  return <Loading label="Loading the group…" onRetry={refresh} />
}
