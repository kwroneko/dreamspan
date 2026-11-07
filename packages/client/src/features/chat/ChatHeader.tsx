import { useSplitChats } from "./splitChats.ts"
import { CenterHeader } from "../../ui/CenterHeader.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chatBranchControls, chatHeaderActions, pendingChatHeaderActions } from "./presentation.tsx"
// The open chat's header, one row: whose chat it is (the cast's faces, the chat's readable
// name, never ST's file name, which a click renames in place, and the cast's names under it),
// then the branch control and the chat's buttons (the pin, ⋯, the side panel), which are
// contributions (`chatBranchControls`, `chatHeaderActions`). On a phone it replaces the app's
// top bar (shell.tsx), with ← to the chats. While the chat loads it shows placeholders, not
// a name it doesn't know yet.
import type { CastCard, Chat, SlotId } from "@rp/shared/chat.ts"
import type { ChatName } from "@rp/shared/chatName.ts"
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import type { AppError } from "../../errors.ts"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset, Input } from "../../ui/Field.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { NameDialog } from "./NameDialog.tsx"
import { Avatar, PortraitOverflow } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { RemoteSourceBadges } from "../cardSources/RemoteBadge.tsx"
import { Tooltip, TooltipProvider } from "../../ui/Tooltip.tsx"
import { openAppMenu, sidebarToggle, useTitle } from "../shell.tsx"
import { ChatBadges } from "./ChatsPage.tsx"
import { castCharacters, chatName, formatDay } from "./chatTitle.ts"
import type { PanelTab } from "./ChatPanels.tsx"
import type { PendingChat } from "./pendingChat.ts"
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
  const split = useSplitChats(view.chat?.id ?? null, view.forkId)
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
    if (split && split.group.id !== split.group.chatId) {
      setDraft(shown)
      setEditing(true)
      return
    }
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
              {/* A narrow header (a phone, or a narrow chat column) has ⋯ Rename instead: the name needs the room. */}
              <Icon
                name="edit"
                size={14}
                className="shrink-0 text-muted group-hover/title:text-accent @max-[40rem]/header:hidden"
              />
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
            {name?.started ? ` It keeps the day it started (${formatDay(name.started)}).` : ""}
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
                  description: `Rename just this chat: it leaves “${group.group.name}” and shows under its new name.`
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

/** What a pending chat's header buttons (`pendingChatHeaderActions`) are given. */
export interface PendingHeaderActionProps {
  readonly pending: PendingChat
  readonly view: ChatView
  readonly panel: PanelControl
}

/** Under the name: who else is in it, by name only (versions are on their cards). */
const aboutLine = (characters: ReadonlyArray<CastCard>, name: string | undefined, started: Date | null) => {
  const others = characters.map((card) => card.name).filter((n) => n !== name)
  // With no one else, the day ST started it, which tells same-named chats apart.
  return others.length > 0
    ? others.length < characters.length
      ? `with ${others.join(", ")}`
      : others.join(", ")
    : started
      ? `started ${formatDay(started)}`
      : null
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
  const [renameRequest, setRenameRequest] = useState(0)
  const split = useSplitChats(view.chat?.id ?? null, view.forkId)
  const baseName = view.chat ? chatName(importState(view.chat.title).title, characters, view.chat.createdAt) : null
  const name =
    baseName && split && split.group.id !== split.group.chatId ? { ...baseName, name: split.group.title } : baseName
  useTitle(name?.name ?? "Chat")
  const loading = view.chat === null
  return (
    <ChatHeaderFrame
      characters={characters}
      loading={loading}
      title={
        <>
          <ChatTitle session={session} view={view} name={name} request={renameRequest} />
          {view.chat && <ChatBadges chat={view.chat} />}
        </>
      }
      about={aboutLine(characters, name?.name, name?.started ?? null)}
      actions={
        !loading && (
          <>
            <SlotOutlet slot={chatBranchControls} props={{ session, view, onJump }} />
            <SlotOutlet
              slot={chatHeaderActions}
              props={{ session, view, panel, onHistory, onJump, onRename: () => setRenameRequest((n) => n + 1) }}
            />
          </>
        )
      }
    />
  )
}

/**
 * A chat not made yet has the same header (owner, 2026-11-02: it looks and works like any
 * other chat): the name it will be saved under, its cast's faces, and its buttons
 * (`pendingChatHeaderActions`: the side panel). The name isn't renamed until it's saved.
 */
export function PendingChatHeader({
  pending,
  view,
  title,
  panel
}: {
  pending: PendingChat
  view: ChatView
  title: string
  panel: PanelControl
}) {
  const characters = castCharacters(view)
  useTitle(title)
  return (
    <ChatHeaderFrame
      characters={characters}
      loading={false}
      title={
        <>
          <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
          <Tooltip label="Not saved yet: sending the first message saves the chat.">
            <span
              tabIndex={0}
              className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Badge>new</Badge>
            </span>
          </Tooltip>
          <RemoteSourceBadges cards={characters} />
        </>
      }
      about={aboutLine(characters, title, null)}
      actions={<SlotOutlet slot={pendingChatHeaderActions} props={{ pending, view, panel }} />}
    />
  )
}

/** The header's row, the same for a saved chat and one not made yet. */
function ChatHeaderFrame({
  characters,
  loading,
  title,
  about,
  actions
}: {
  characters: ReadonlyArray<CastCard>
  loading: boolean
  title: ReactNode
  about: string | null
  actions: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <TooltipProvider>
      {/* Narrow by the chat column's own width, not the screen's: below 40rem it takes the phone's
          layout, leaving out the faces, the pin and the rename pencil (the side panel has the cast,
          the chat lists the pin, ⋯ has Rename), and the branch control gives up room before the
          name does. */}
      <CenterHeader endControls={false}>
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
          <span className="h-12 w-8 shrink-0 animate-pulse rounded-sm bg-surface-raised motion-reduce:animate-none @max-[40rem]/header:hidden" />
        ) : (
          characters.length > 0 && (
            <div
              data-layout-audit-ignore="overlap: Header portraits intentionally form a stack"
              className="flex shrink-0 items-center -space-x-2 @max-[40rem]/header:hidden"
            >
              {characters.slice(0, 4).map((c) => (
                <Tooltip key={c.entityId} label={`Opens ${c.label}'s card in the side panel.`} side="bottom">
                  <button
                    type="button"
                    aria-label={`Show ${c.label}'s card`}
                    className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() =>
                      void navigate({
                        to: ".",
                        search: (prev: Record<string, unknown>) => ({ ...prev, panel: `card:${c.entityId}` })
                      })
                    }
                  >
                    <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} crop={c.avatarCrop} size="md" />
                  </button>
                </Tooltip>
              ))}
              {characters.length > 4 && (
                <Tooltip
                  label={characters
                    .slice(4)
                    .map((c) => c.label)
                    .join(", ")}
                  side="bottom"
                >
                  <PortraitOverflow
                    remaining={characters.length - 4}
                    tabIndex={0}
                    aria-label={`Other characters: ${characters
                      .slice(4)
                      .map((c) => c.label)
                      .join(", ")}`}
                    className="outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  />
                </Tooltip>
              )}
            </div>
          )
        )}
        <div className="flex min-w-24 flex-1 flex-col @max-[40rem]/header:max-w-[calc(100%_-_9rem)] @max-[40rem]/header:flex-none">
          <div className="flex min-w-0 items-center gap-2">{title}</div>
          {about !== null && (
            <p className="truncate text-xs text-muted" title={about}>
              {about}
            </p>
          )}
        </div>
        {/* Only the branch control shrinks, cutting its name short; the buttons keep their size. */}
        {actions && (
          <div className="flex min-w-0 items-center justify-end gap-0.5 *:shrink-0 @max-[40rem]/header:flex-1 sm:gap-1">
            {actions}
          </div>
        )}
      </CenterHeader>
    </TooltipProvider>
  )
}
