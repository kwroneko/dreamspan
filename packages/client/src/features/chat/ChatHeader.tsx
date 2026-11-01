import { SlotOutlet } from "../../slots.tsx"
import { chatBranchControls, chatHeaderActions } from "./presentation.tsx"
// The open chat's header, one row: whose chat it is (the cast's faces, the chat's readable
// name, never ST's file name, which a click renames in place, and the cast's names under it),
// then the branch control and the chat's buttons (the pin, the side panel, ⋯), which are
// contributions (`chatBranchControls`, `chatHeaderActions`). On a phone it replaces the app's
// top bar (shell.tsx), with ← to the chats. While the chat loads it shows placeholders, not
// a name it doesn't know yet.
import type { Chat, SlotId } from "@rp/shared/chat.ts"
import type { ChatName } from "@rp/shared/chatName.ts"
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useEffect, useRef, useState } from "react"
import type { AppError } from "../../errors.ts"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset, Input } from "../../ui/Field.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { NameDialog } from "./NameDialog.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip, TooltipProvider } from "../../ui/Tooltip.tsx"
import { openAppMenu, sidebarToggle, useTitle } from "../shell.tsx"
import { ChatBadges } from "./ChatsPage.tsx"
import { castCharacters, chatName, formatDay } from "./chatTitle.ts"
import type { PanelTab } from "./ChatPanels.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

/** Runs a session write, keeping its pending state and error. */
function useWrite() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const run = async <A,>(write: () => Promise<Outcome<A>>) => {
    setPending(true)
    setError(null)
    const result = await write()
    setPending(false)
    if (!result.ok) setError(result.error)
    return result
  }
  return { run, pending, error, clear: () => setError(null) }
}

/**
 * The chat's name, which a click (or ⋯ Rename, `request`) renames in place (DESIGN §2.1). In a
 * group of several chats a dialog asks instead whether to rename this chat or the whole group.
 */
function ChatTitle({
  session,
  view,
  name,
  request
}: {
  session: ChatSession
  view: ChatView
  name: ChatName | null
  request: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<{ group: ChatGroup; chats: ReadonlyArray<Chat> } | null>(null)
  const [scope, setScope] = useState<"chat" | "group">("chat")
  const write = useWrite()
  const input = useRef<HTMLInputElement>(null)
  const shown = name?.name ?? "Chat"
  const begin = async () => {
    if (view.chat === null) return
    setGroup(null)
    setScope("chat")
    write.clear()
    const result = await session.call((client) => client("ListGroupChats", { chatId: view.chat!.id }))
    if (!result.ok && result.error.tag !== "NotFound") {
      showToast({ title: "Couldn't check this chat's group", description: result.error.message })
      return
    }
    const found = result.ok ? result.value : null
    setGroup(found)
    if (found !== null && found.chats.length > 1) return setOpen(true)
    setDraft(shown)
    setEditing(true)
  }
  const handled = useRef(request)
  useEffect(() => {
    if (request === handled.current) return
    handled.current = request
    void begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each request once
  }, [request])
  /** Escape keeps the name: the blur that follows mustn't save. */
  const kept = useRef(false)
  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (write.pending || kept.current) return
    if (draft.trim() === shown) return setEditing(false)
    const result = await write.run(() => session.rename(draft))
    if (result.ok) setEditing(false)
    else input.current?.focus()
  }
  const many = group !== null && group.chats.length > 1
  if (view.chat === null)
    return (
      <span
        role="status"
        aria-label="Loading the chat"
        className="block h-5 w-40 animate-pulse rounded bg-surface-raised motion-reduce:animate-none"
      />
    )
  return (
    <>
      {editing ? (
        <form className="flex min-w-0 flex-1 flex-col" onSubmit={(event) => void save(event)}>
          <Input
            ref={input}
            aria-label="Chat name"
            aria-description="Enter renames it, Escape keeps the name. Leave it empty to name it after its characters."
            value={draft}
            maxLength={200}
            autoFocus
            disabled={write.pending}
            onFocus={(event) => {
              kept.current = false
              event.currentTarget.select()
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                kept.current = true
                setEditing(false)
                write.clear()
              }
            }}
            onBlur={() => void save()}
            className="h-8 text-base font-semibold"
          />
          {write.error && (
            <span role="alert" className="text-xs text-danger">
              {write.error.message}
            </span>
          )}
        </form>
      ) : (
        <h1 className="min-w-0 text-base font-semibold">
          <Tooltip label="Rename this chat">
            <button
              type="button"
              aria-description="Rename this chat"
              onClick={() => void begin()}
              className="group/title flex max-w-full min-w-0 items-center gap-1.5 rounded-md text-left outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="truncate">{shown}</span>
              {/* A phone has ⋯ Rename instead: the name needs the room. */}
              <Icon name="edit" size={14} className="shrink-0 text-muted group-hover/title:text-accent max-sm:hidden" />
            </button>
          </Tooltip>
        </h1>
      )}
      <NameDialog
        draftTarget={`chat:${session.id}:rename`}
        open={open}
        onOpenChange={setOpen}
        title="Rename chat"
        label="Name"
        initial={shown}
        description={
          <>
            Leave it empty to name it after its characters.
            {name?.started ? ` It keeps the day SillyTavern started it (${formatDay(name.started)}).` : ""}
          </>
        }
        maxLength={200}
        saveLabel="Rename"
        pending={write.pending}
        error={write.error}
        onSave={async (next) => {
          const result =
            scope === "group"
              ? await write.run(() => session.renameGroup(next))
              : await write.run(() => session.rename(next))
          if (result.ok) setOpen(false)
          return result.ok
        }}
      >
        {many && (
          <Fieldset legend={`It's one of ${group.chats.length} chats in the group “${group.group.name}”`}>
            <RadioGroup
              value={scope}
              onValueChange={setScope}
              options={[
                {
                  value: "chat",
                  label: "Only this chat",
                  description: `It leaves “${group.group.name}” and appears under its new name on Characters. Chats with the same name and characters share a tile.`
                },
                {
                  value: "group",
                  label: `The whole group (${group.chats.length} chats)`,
                  description: "Every chat of the group takes the name, and so does the group's tile."
                }
              ]}
            />
          </Fieldset>
        )}
      </NameDialog>
    </>
  )
}

/** The side panel's toggle, which the page owns. */
export interface PanelControl {
  readonly userId: string
  readonly open: PanelTab | null
  readonly wide: boolean
  readonly onToggle: (tab: PanelTab) => void
}

/** What the header's buttons (`chatHeaderActions`) are given. */
export interface ChatHeaderActionProps {
  readonly session: ChatSession
  readonly view: ChatView
  readonly panel: PanelControl
  readonly onHistory: () => void
  readonly onJump: (slotId: SlotId) => void
  /** Starts renaming the chat in the header. */
  readonly onRename: () => void
}

export function ChatHeader({
  session,
  view,
  panel,
  onJump,
  onHistory
}: {
  session: ChatSession
  view: ChatView
  panel: PanelControl
  onHistory: () => void
  onJump: (slotId: SlotId) => void
}) {
  const characters = castCharacters(view)
  const navigate = useNavigate()
  const [renameRequest, setRenameRequest] = useState(0)
  const name = view.chat ? chatName(importState(view.chat.title).title, characters) : null
  useTitle(name?.name ?? "Chat")
  // Under the name: who else is in it, by name only (versions are on their cards); with no
  // one else, the day ST started it, which tells same-named chats apart.
  const others = characters.map((card) => card.name).filter((n) => n !== name?.name)
  const about =
    others.length > 0
      ? others.length < characters.length
        ? `with ${others.join(", ")}`
        : others.join(", ")
      : name?.started
        ? `started ${formatDay(name.started)}`
        : null
  const loading = view.chat === null
  return (
    <TooltipProvider>
      <header className="flex min-h-13 w-full min-w-0 shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 sm:gap-3 sm:px-4">
        {/* The desktop's hidden sidebar comes back from here. */}
        <SlotOutlet slot={sidebarToggle} props={{ place: "header" }} />
        <Tooltip label="All chats">
          <Link
            to="/chats"
            aria-label="Chats"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus max-sm:hidden lg:hidden"
          >
            <Icon name="back" />
          </Link>
        </Tooltip>
        {/* A phone has no app bar in a chat: ← opens its menu, the chats first, where the chat is. */}
        <Tooltip label="Chats and menu">
          <button
            type="button"
            aria-label="Chats and menu"
            onClick={openAppMenu}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus sm:hidden"
          >
            <Icon name="back" />
          </button>
        </Tooltip>
        {loading ? (
          <span className="size-9 shrink-0 animate-pulse rounded-full bg-surface-raised motion-reduce:animate-none max-sm:hidden" />
        ) : (
          characters.length > 0 && (
            <div className="flex shrink-0 -space-x-2 max-sm:hidden">
              {characters.slice(0, 4).map((c) => (
                <Tooltip key={c.entityId} label={`Opens ${c.label}'s card in the side panel.`} side="bottom">
                  <button
                    type="button"
                    aria-label={`Show ${c.label}'s card`}
                    className="rounded-full ring-2 ring-surface outline-none focus-visible:ring-focus"
                    onClick={() =>
                      void navigate({
                        to: ".",
                        search: (prev: Record<string, unknown>) => ({ ...prev, panel: `card:${c.entityId}` })
                      })
                    }
                  >
                    <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} size="md" />
                  </button>
                </Tooltip>
              ))}
              {characters.length > 4 && (
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-surface-raised text-xs text-muted ring-2 ring-surface">
                  +{characters.length - 4}
                </span>
              )}
            </div>
          )
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <ChatTitle session={session} view={view} name={name} request={renameRequest} />
            {view.chat && <ChatBadges chat={view.chat} />}
          </div>
          {about !== null && (
            <p className="truncate text-xs text-muted" title={about}>
              {about}
            </p>
          )}
        </div>
        {!loading && (
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <SlotOutlet slot={chatBranchControls} props={{ session, view, onJump }} />
            <SlotOutlet
              slot={chatHeaderActions}
              props={{ session, view, panel, onHistory, onJump, onRename: () => setRenameRequest((n) => n + 1) }}
            />
          </div>
        )}
      </header>
    </TooltipProvider>
  )
}
