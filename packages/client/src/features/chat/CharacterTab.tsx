import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useChatCards } from "./chatCards.ts"
// A character's tab in the chat's panel, as ST's character panel: every field the full editor
// has, in the same tabs (`CardEditor`, `layout: "panel"`), edited right here with the editor's
// store and field histories (ARCHITECTURE §14.6), each long field openable large over the
// chat. At the top, the portrait beside the names renamed in place and the token counts
// (`CardHeader`; "You" is a badge on the persona's portrait), then
// the card's actions as buttons: New chat with them, Full editor, Fork for this chat, Export…
// and what else is registered (`chatCardActions`). The persona's tab is the same card editor
// (DESIGN §2.2: a persona is a card). Card data and actions stay in their
// feature; the panel host only sees its descriptor.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { CardEditor } from "../editor/CardEditor.tsx"
import { CardHeader, CardNameHeader, CardTokensRow } from "../editor/CardNameHeader.tsx"
import { CARD_LOREBOOK_FOCUS } from "../editor/cardSections.ts"
import { RecoveredNotice } from "../editor/controls.tsx"
import { CardHeaderPortrait, TabPortrait } from "../editor/PortraitControls.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { EditorStore, useEditorState, useLeaveGuard } from "../editor/store.ts"
import { ChatDefinition } from "./ChatDefinition.tsx"
import type { ChatCardInfo } from "./CardForkDialogs.tsx"
import type { PanelProps, PendingPanelProps } from "./panels.tsx"
import type { PendingChat } from "./pendingChat.ts"
import { usePendingCardInfo } from "./pendingCardInfo.ts"
import { ChatCardActions } from "./presentation.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export function CharacterTab({ session, view, tab }: PanelProps) {
  const entityId = tab.slice(5) as EntityId
  return <ChatCharacterPanel session={session} view={view} entityId={entityId} />
}

/**
 * The same tab in a chat not made yet: the card editor and the card's actions, its entry read
 * from the library (pendingCardInfo.ts); what needs the saved chat (Fork for this chat, Use
 * another version) comes once it's saved.
 */
export function PendingCharacterTab({ pending, view, tab }: PendingPanelProps) {
  const entityId = tab.slice(5) as EntityId
  const card = view.cast?.cards.find((item) => item.entityId === entityId)
  const info = usePendingCardInfo()(entityId)
  const persona = view.cast?.playedByMe.includes(entityId) ?? false
  if (!card) return <p className="text-sm text-muted">This character isn't in the chat.</p>
  if (!info) return <p className="text-sm text-muted">Loading the card…</p>
  return (
    <CardPanel
      key={info.refId}
      session={null}
      pending={pending}
      view={view}
      card={card}
      info={info}
      persona={persona}
    />
  )
}

function ChatCharacterPanel({ session, view, entityId }: { session: ChatSession; view: ChatView; entityId: EntityId }) {
  const card = view.cast?.participants.includes(entityId)
    ? view.cast.cards.find((item) => item.entityId === entityId)
    : view.cast?.playedByMe.includes(entityId)
      ? view.cast.cards.find((item) => item.entityId === entityId)
      : undefined
  const live = card !== undefined && !card.inBin
  const persona = view.cast?.playedByMe.includes(entityId) ?? false
  const result = useChatCards(session)
  const info = AsyncResult.isSuccess(result) ? result.value.find((item) => item.entityId === entityId) : undefined
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
      <CardHeader
        portrait={
          <CardHeaderPortrait
            badge={persona ? <PersonaBadge played portrait /> : card.persona ? <PersonaBadge portrait /> : undefined}
          >
            <Avatar
              id={entityId}
              name={card.name}
              mediaId={card.avatarMediaId}
              crop={card.avatarCrop}
              size="fill"
              className="size-full"
              preview
            />
          </CardHeaderPortrait>
        }
      >
        <h2
          data-card-header-row
          className="col-span-full line-clamp-2 text-lg leading-7 font-semibold [overflow-wrap:anywhere]"
        >
          {card.label}
        </h2>
        {card.subtitle && (
          <p data-card-header-row className="col-span-full truncate text-sm text-muted">
            {card.subtitle}
          </p>
        )}
      </CardHeader>
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
    <Tooltip label="Start a chat with only them, at their greeting.">
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
  pending = null,
  view,
  card,
  info,
  persona
}: {
  /** Null in a chat not made yet, which `pending` is. */
  session: ChatSession | null
  pending?: PendingChat | null
  view: ChatView
  card: CastCard
  info: ChatCardInfo & Partial<Pick<ChatCard, "definition">>
  /** The card you play: saving changes it wherever you play it. */
  persona: boolean
}) {
  const store = useCardStore(info.refId)
  const workspace = usePresetWorkspace()
  const call = useCaller()
  const state = useEditorState(store)
  const avatar = state.snapshot?.doc.avatar_media_id
  const previousAvatar = useRef(avatar)
  useEffect(() => {
    const changed = previousAvatar.current !== undefined && previousAvatar.current !== avatar
    previousAvatar.current = avatar
    if (changed) void session?.rereadCast()
  }, [avatar, session])
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)
  // A new chat with only them is this one, while it's pending with no one else.
  const alone =
    pending !== null &&
    view.cast?.participants.every((id) => id === card.entityId || view.cast?.playedByMe.includes(id))
  return (
    <div className="flex flex-col gap-4">
      <CardHeader
        portrait={
          <TabPortrait
            store={store}
            call={call}
            id={card.entityId}
            shown={{ name: card.name, mediaId: card.avatarMediaId, crop: card.avatarCrop ?? null }}
            {...(session === null ? {} : { onChanged: () => void session.rereadCast() })}
            badge={persona ? <PersonaBadge played portrait /> : card.persona ? <PersonaBadge portrait /> : undefined}
          />
        }
      >
        {state.snapshot ? (
          <>
            <CardNameHeader
              store={store}
              call={call}
              saveControls={<SaveRevision store={store} />}
              current={session === null ? undefined : { chatId: session.id, forkId: view.forkId }}
            />
            <CardTokensRow store={store} entityId={card.entityId} label={card.label} />
          </>
        ) : (
          <h2
            data-card-header-row
            className="col-span-full line-clamp-2 text-lg leading-7 font-semibold [overflow-wrap:anywhere]"
          >
            {card.label}
          </h2>
        )}
      </CardHeader>
      <div className="-mx-2 flex flex-wrap items-center gap-x-1">
        {!persona && !alone && <NewChat card={card} />}
        <ChatCardActions session={session} card={card} info={info} persona={persona} />
      </div>
      {state.loadError && <ErrorAlert error={state.loadError} />}
      {!state.snapshot && !state.loadError && <p className="text-sm text-muted">Loading the card…</p>}
      {state.snapshot && (
        <>
          {/* Only where editing wouldn't reach this chat (DESIGN §6.2, §10.1). */}
          {info.binding === "revision" && (
            <p className="text-sm">
              This chat uses an earlier version of {card.name}: editing changes the card, not what this chat uses.
            </p>
          )}
          {info.binding === "revision" && info.definition && (
            <ChatDefinition name={card.name} info={{ ...info, definition: info.definition }} />
          )}
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
