// A character's tab in the chat's panel, as ST's character panel: every field the full editor
// has, in the same tabs (`CardEditor`, `layout: "panel"`), edited right here with the editor's
// store and field histories (ARCHITECTURE §14.6), each long field openable large over the
// chat. At the top, the names renamed in place and the token counts (`CardNameHeader`), then
// the card's actions as buttons: New chat with them, Full editor, Fork for this chat, Export…
// and what else is registered (`chatCardActions`). The persona's tab is the same card editor
// (DESIGN §2.2: a persona is a card), with Switch persona. Card data and actions stay in their
// feature; the panel host only sees its descriptor.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { CardEditor } from "../editor/CardEditor.tsx"
import { CardNameHeader, CardTokens } from "../editor/CardNameHeader.tsx"
import { CARD_LOREBOOK_FOCUS } from "../editor/cardSections.ts"
import { RecoveredNotice } from "../editor/controls.tsx"
import { TabPortrait } from "../editor/PortraitControls.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { EditorStore, useEditorState, useLeaveGuard } from "../editor/store.ts"
import { ChatDefinition } from "./ChatDefinition.tsx"
import type { PanelProps } from "./panels.tsx"
import { PersonaSwitch } from "./PersonaSwitch.tsx"
import { ChatCardActions } from "./presentation.tsx"
import type { ChatSession, ChatView } from "./session.ts"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function CharacterTab({ session, view, tab }: PanelProps) {
  const entityId = tab.slice(5) as EntityId
  return <ChatCharacterPanel session={session} view={view} entityId={entityId} />
}

function ChatCharacterPanel({ session, view, entityId }: { session: ChatSession; view: ChatView; entityId: EntityId }) {
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
  if (info && live)
    return <CardPanel key={info.refId} session={session} view={view} card={card} info={info} persona={persona} />
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <Avatar id={entityId} name={card.name} mediaId={card.avatarMediaId} crop={card.avatarCrop} size="lg" preview />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {persona && <p className="text-xs text-muted">You play</p>}
          <h2 className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{card.label}</h2>
          {card.subtitle && <p className="text-sm text-muted [overflow-wrap:anywhere]">{card.subtitle}</p>}
        </div>
      </header>
      {card.inBin && <p className="text-sm text-muted">This card is in the bin: restore it to edit it.</p>}
      {AsyncResult.isFailure(result) && (
        <p role="alert" className="text-sm text-danger">
          The card couldn't be read.
        </p>
      )}
      {live && !AsyncResult.isFailure(result) && <p className="text-sm text-muted">Loading the card…</p>}
    </div>
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

/** "New chat with <name>": only them, from their greeting (owner, 2026-11-01: a button, not under More). */
function NewChat({ card }: { card: CastCard }) {
  return (
    <Tooltip label="Starts a chat with only them, from their greeting. It's saved when you first send.">
      <Link
        to="/cards/$entityId/chat"
        params={{ entityId: card.entityId }}
        search={{ panel: `card:${card.entityId}` }}
        className={`${buttonClass("ghost")} h-8! px-2!`}
      >
        New chat with {card.name}
      </Link>
    </Tooltip>
  )
}

function CardPanel({
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
  /** The card you play: saving changes it wherever you play it. */
  persona: boolean
}) {
  const store = useCardStore(info.refId)
  const workspace = usePresetWorkspace()
  const call = useCaller()
  const viewer = usePortraitViewer()
  const state = useEditorState(store)
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)
  const portrait = { id: card.entityId, name: card.name, mediaId: card.avatarMediaId }
  const others = info.usedByChats - 1
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <TabPortrait
          store={store}
          call={call}
          id={card.entityId}
          shown={{ name: card.name, mediaId: card.avatarMediaId, crop: card.avatarCrop ?? null }}
          onViewFull={viewer && card.avatarMediaId !== null ? () => viewer.show(portrait) : undefined}
          onChanged={() => void session.rereadCast()}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {persona && <p className="text-xs text-muted">You play</p>}
          {state.snapshot ? (
            <>
              <CardNameHeader store={store} call={call} current={{ chatId: session.id, forkId: view.forkId }} />
              <CardTokens store={store} />
            </>
          ) : (
            <h2 className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{card.label}</h2>
          )}
        </div>
      </header>
      <div className="-mx-2 flex flex-wrap items-center gap-x-1">
        {!persona && <NewChat card={card} />}
        <ChatCardActions session={session} card={card} info={info} persona={persona} />
        {persona && <PersonaSwitch session={session} trigger="Switch persona" />}
      </div>
      {state.loadError && <ErrorAlert error={state.loadError} />}
      {!state.snapshot && !state.loadError && <p className="text-sm text-muted">Loading the card…</p>}
      {state.snapshot && (
        <>
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
          {/* Save stays in sight while a field further down is edited; what's typed is used as it's typed. */}
          <div className="sticky -top-4 z-10 -mx-4 -my-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2">
            <SaveRevision store={store} />
          </div>
          {state.saveError && (
            <ErrorAlert
              error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }}
            />
          )}
          <RecoveredNotice store={store} />
          <CardEditor
            store={store}
            call={call}
            layout="panel"
            onOpenBook={workspace ? () => workspace.open(info.refId, CARD_LOREBOOK_FOCUS) : undefined}
          />
        </>
      )}
    </div>
  )
}
