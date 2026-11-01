// A character's tab in the chat's panel, as ST's character panel: every definition field is a
// text box, edited right here with the editor's drafts and field undo (ARCHITECTURE §14.6),
// each long one openable large over the chat. The full editor opens over the chat, never
// instead of it. The persona's tab is the same with its one field, the description (ST's
// persona panel), and Switch persona. Card data and actions stay in their feature; the panel
// host only sees its descriptor.
import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { TabPortrait } from "../editor/PortraitControls.tsx"
import { Button } from "../../ui/Button.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { Menu, MenuItem, MenuLinkItem } from "../../ui/Menu.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useCaller } from "../editor/caller.ts"
import { RecoveredNotice } from "../editor/controls.tsx"
import { TextField } from "../editor/controls.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { EditorStore, useEditorState, useLeaveGuard } from "../editor/store.ts"
import { ChatDefinition } from "./ChatDefinition.tsx"
import { useIsPanelTab, type PanelProps } from "./panels.tsx"
import { PersonaSwitch } from "./PersonaSwitch.tsx"
import { ChatCardActions } from "./presentation.tsx"
import type { CastCard } from "@rp/shared/chat.ts"
import type { ChatSession, ChatView } from "./session.ts"

/** The definition fields ST's panel shows, in its order; the rest are in the full editor. */
const FIELDS: ReadonlyArray<{ path: string; label: string; rows: number }> = [
  { path: "description", label: "Description", rows: 8 },
  { path: "first_mes", label: "First message", rows: 5 },
  { path: "personality", label: "Personality", rows: 3 },
  { path: "scenario", label: "Scenario", rows: 3 },
  { path: "mes_example", label: "Example messages", rows: 5 },
  { path: "system_prompt", label: "System prompt", rows: 3 },
  { path: "post_history_instructions", label: "Post-history instructions", rows: 3 },
  { path: "creator_notes", label: "Creator's notes", rows: 3 }
]

/** A persona is its description (DESIGN §2.2: ST's persona text is the persona card's description). */
const PERSONA_FIELDS: typeof FIELDS = [{ path: "description", label: "Description", rows: 12 }]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function CharacterTab({ session, view, tab, onNotes }: PanelProps) {
  const entityId = tab.slice(5) as EntityId
  return <ChatCharacterPanel session={session} view={view} entityId={entityId} onNotes={() => onNotes(entityId)} />
}

function ChatCharacterPanel({
  session,
  view,
  entityId,
  onNotes
}: {
  session: ChatSession
  view: ChatView
  entityId: EntityId
  onNotes: () => void
}) {
  const notesPanel = useIsPanelTab("notes", view)
  const card = view.cast?.participants.includes(entityId)
    ? view.cast.cards.find((item) => item.entityId === entityId)
    : view.cast?.playedByMe.includes(entityId)
      ? view.cast.cards.find((item) => item.entityId === entityId)
      : undefined
  const live = card !== undefined && !card.inBin
  const persona = view.cast?.playedByMe.includes(entityId) ?? false
  const query = useMemo(
    () =>
      AppClient.query(
        "ListChatCards",
        { chatId: session.id, slotId: view.leafSlotId, forkId: view.forkId, entityIds: live ? [entityId] : [] },
        { reactivityKeys: ["library", `chat-cards:${session.id}`] }
      ),
    [session.id, view.leafSlotId, view.forkId, entityId, live]
  )
  const result = useAtomValue(query)
  const info = AsyncResult.isSuccess(result) ? result.value[0] : undefined
  if (!card)
    return (
      <p className="text-sm text-muted">
        {view.cast ? "This character isn't in the chat on this branch." : "Loading the card…"}
      </p>
    )
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        {info && live ? (
          <HeaderPortrait session={session} refId={info.refId} entityId={entityId} card={card} />
        ) : (
          <Avatar
            id={entityId}
            name={card.name}
            mediaId={card.avatarMediaId}
            crop={card.avatarCrop}
            size="lg"
            preview
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {persona && <p className="text-xs text-muted">You play</p>}
          <h2 className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{card.label}</h2>
          {card.subtitle && <p className="text-sm text-muted [overflow-wrap:anywhere]">{card.subtitle}</p>}
        </div>
        <CardMenu
          entityId={entityId}
          card={card}
          persona={persona}
          refId={info?.refId}
          onNotes={notesPanel ? onNotes : undefined}
        />
      </header>
      {persona && (
        <div className="flex flex-wrap items-center gap-2">
          <PersonaSwitch session={session} trigger="Switch persona" />
        </div>
      )}
      {card.inBin && <p className="text-sm text-muted">This card is in the bin: restore it to edit it.</p>}
      {AsyncResult.isFailure(result) && (
        <p role="alert" className="text-sm text-danger">
          The card couldn't be read.
        </p>
      )}
      {info && <CardFields key={info.refId} session={session} view={view} card={card} info={info} persona={persona} />}
      {live && !info && !AsyncResult.isFailure(result) && <p className="text-sm text-muted">Loading the card…</p>}
    </div>
  )
}

const FULL_EDITOR = "Every field of the card, not only its description."

/** What's used less: a new chat (a persona's: its full editor), the card's notes. */
function CardMenu({
  entityId,
  card,
  persona,
  refId,
  onNotes
}: {
  entityId: EntityId
  card: CastCard
  persona: boolean
  refId: RefId | undefined
  onNotes: (() => void) | undefined
}) {
  const workspace = usePresetWorkspace()
  return (
    <Menu
      label={`More for ${card.name}`}
      trigger={
        <Button variant="ghost" className="h-8 shrink-0 px-2" aria-label={`More for ${card.name}`}>
          More
        </Button>
      }
    >
      {persona ? (
        refId &&
        (workspace ? (
          <MenuItem icon="edit" description={FULL_EDITOR} onClick={() => workspace.open(refId)}>
            Full editor
          </MenuItem>
        ) : (
          <MenuLinkItem icon="edit" description={FULL_EDITOR} render={<Link to="/library/$refId" params={{ refId }} />}>
            Full editor
          </MenuLinkItem>
        ))
      ) : (
        <MenuLinkItem
          icon="chat"
          description="Starts a chat with only them, from their greeting. It's saved when you first send."
          render={<Link to="/cards/$entityId/chat" params={{ entityId }} search={{ panel: `card:${entityId}` }} />}
        >
          New chat with {card.name}
        </MenuLinkItem>
      )}
      {onNotes && (
        <MenuItem icon="note" description="Opens the Notes tab at this card's notes." onClick={onNotes}>
          {card.name}'s notes
        </MenuItem>
      )}
    </Menu>
  )
}

/**
 * The tab's portrait: a click changes the picture (owner, 2026-11-01), beside Adjust cutout and
 * View full image, which opens it as a message portrait's click does.
 */
function HeaderPortrait({
  session,
  refId,
  entityId,
  card
}: {
  session: ChatSession
  refId: RefId
  entityId: EntityId
  card: CastCard
}) {
  const store = useCardStore(refId)
  const call = useCaller()
  const viewer = usePortraitViewer()
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  const portrait = { id: entityId, name: card.name, mediaId: card.avatarMediaId }
  return (
    <TabPortrait
      store={store}
      call={call}
      id={entityId}
      shown={{ name: card.name, mediaId: card.avatarMediaId, crop: card.avatarCrop ?? null }}
      onViewFull={viewer && card.avatarMediaId !== null ? () => viewer.show(portrait) : undefined}
      onChanged={() => void session.rereadCast()}
    />
  )
}

/** The workspace's store for the card, shared with the full editor over the chat. */
function useCardStore(refId: RefId) {
  const workspace = usePresetWorkspace()
  const call = useCaller()
  const userId = useSession().user.id
  const [own] = useState(() => (workspace ? null : new EditorStore(refId, userId, call)))
  return workspace?.store(refId) ?? own!
}

function CardFields({
  session,
  view,
  card,
  info,
  persona
}: {
  session: ChatSession
  view: ChatView
  card: CastCard
  info: ChatCard
  /** The card you play: its description only, which saving changes wherever you play it. */
  persona: boolean
}) {
  const store = useCardStore(info.refId)
  const workspace = usePresetWorkspace()
  const state = useEditorState(store)
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.loadError) return <ErrorAlert error={state.loadError} />
  if (!state.snapshot) return <p className="text-sm text-muted">Loading the card…</p>
  const others = info.usedByChats - 1
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {!persona && (
          <div className="-mx-2 flex flex-wrap items-center gap-x-1">
            <ChatCardActions session={session} card={card} info={info} />
          </div>
        )}
        {/* The consequence, once, where it matters (DESIGN §6.2). */}
        <p className="text-sm">
          {info.binding === "revision"
            ? `This chat uses an earlier version of ${card.name}: editing changes the card, not what this chat uses.`
            : persona
              ? `What you change is used for ${card.name} as you type, in every chat where you play them.`
              : others === 0
                ? `What you change is used for ${card.name} as you type; no other chat uses it.`
                : `What you change is used for ${card.name} as you type, in ${plural(others + 1, "chat", "chats")}, this one included. To change it here only, fork it for this chat.`}
        </p>
        {info.binding === "revision" && <ChatDefinition name={card.name} info={info} />}
      </div>
      {/* Save stays in sight while a field further down is edited; what's typed is used as it's typed. */}
      <div className="sticky -top-4 z-10 -mx-4 -my-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2">
        <SaveRevision store={store} current={{ chatId: session.id, forkId: view.forkId }} />
      </div>
      {state.saveError && (
        <ErrorAlert error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }} />
      )}
      <RecoveredNotice store={store} />
      {(persona ? PERSONA_FIELDS : FIELDS).map((field) => (
        <TextField
          key={field.path}
          store={store}
          path={[field.path]}
          label={field.label}
          rows={field.rows}
          expandable
        />
      ))}
      {!persona && (
        <Alert tone="neutral">
          <p>
            Greetings, tags, the card's lorebook and its other fields are in the{" "}
            {workspace ? (
              <button
                type="button"
                className="text-accent underline-offset-4 hover:underline"
                onClick={() => workspace.open(info.refId)}
              >
                full editor
              </button>
            ) : (
              "full editor"
            )}
            .
          </p>
        </Alert>
      )}
    </div>
  )
}
