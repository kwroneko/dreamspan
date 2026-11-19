import { panelEditorActions } from "../editor/panelActions.tsx"
import { editorNotices } from "../editor/editorSlots.ts"
import { SearchReplaceButton } from "../../ui/SearchReplace.tsx"
import { SearchDialog } from "../editor/SearchDialog.tsx"
import { SearchNavigation, type SearchMatch } from "../editor/searchNavigation.ts"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useChatCards } from "./chatCards.ts"
// A character's tab in the chat's panel, as ST's character panel: every field the full editor
// has, in the same tabs (`CardEditor`, `layout: "panel"`), edited right here with the editor's
// store and field histories (ARCHITECTURE §14.6), each long field openable large over the
// chat. At the top, the portrait beside the names renamed in place and the token counts
// (`CardHeader`; "You" is a badge on the persona's portrait), then
// the card's actions as buttons: New chat with them, Fork for this chat, Export…
// and what else is registered (`chatCardActions`). The persona's tab is the same card editor
// (DESIGN §2.2: a persona is a card). Card data and actions stay in their
// feature; the panel host only sees its descriptor.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
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
import { chatCardActions, chatCharacterRows } from "./presentation.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { composerChoice } from "./speaker.ts"
import { remoteOf } from "@rp/shared/cardSources.ts"
import { RemoteCardLine } from "../cardSources/RemoteBadge.tsx"
import { showAdopted } from "../cardSources/remote.ts"
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
  // A card from a card source (spec/CARD-SOURCES.md §4.3): the editor on its cached copy,
  // under its placeholder id; saving a change adds it to the user's cards.
  const remote = remoteOf(entityId) !== null
  const shown = remote
    ? { entityId, refId: entityId as unknown as RefId, usedByChats: 0, binding: "default" as const }
    : info
  if (!shown) return <p className="text-sm text-muted">Loading the card…</p>
  return (
    <CardPanel
      key={shown.refId}
      session={null}
      pending={pending}
      view={view}
      card={card}
      info={shown}
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
          <CardHeaderPortrait badge={persona ? <PersonaBadge played portrait /> : undefined}>
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
function NewChat({ card, guidance }: { card: CastCard; guidance: boolean }) {
  const from = remoteOf(card.entityId)
  const search = { panel: `card:${card.entityId}`, guidance: guidance ? "on" : "off" }
  const className = `${buttonClass("ghost")} h-8! px-2!`
  return (
    <Tooltip label="Start a chat with only them, at their greeting.">
      {from === null ? (
        <Link to="/cards/$entityId/chat" params={{ entityId: card.entityId }} search={search} className={className}>
          New chat with {card.name}
        </Link>
      ) : (
        <Link
          to="/sources/$sourceId/cards/$remoteId/chat"
          params={{ sourceId: from.sourceId, remoteId: from.remoteId }}
          search={search}
          className={className}
        >
          New chat with {card.name}
        </Link>
      )}
    </Tooltip>
  )
}

/** A source's card's actions before it's added: what needs it in the user's cards says so. */
function RemoteCardActions({ card }: { card: CastCard }) {
  return (
    <Button
      variant="ghost"
      className="h-8! px-2!"
      disabled
      focusableWhenDisabled
      hint={`Add ${card.name} to your cards to export it.`}
    >
      Export…
      <Icon name="down" />
    </Button>
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
  const choices = session === null ? pending : composerChoice(session)
  const remote = remoteOf(card.entityId) !== null
  const guidance = useSyncExternalStore(choices!.subscribe, () => choices!.snapshot().guidance)
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
  // A source's card that became the user's (Save here, or Add to my cards): the chat, and
  // this tab, go on with their card (spec/CARD-SOURCES.md §4.5).
  // A Save added it when the editor, open on the source's copy, opens the user's card.
  const ownId = state.snapshot?.ref.entityId
  const navigate = useNavigate()
  const sawCopy = useRef(false)
  const adopted = (entityId: string) => void pending?.swap(card.entityId, entityId as EntityId)
  useEffect(() => {
    if (!remote || ownId === undefined) return
    if (ownId === card.entityId) {
      sawCopy.current = true
      return
    }
    if (sawCopy.current) showAdopted(navigate, { entityId: ownId, name: card.name, existing: false })
    void pending?.swap(card.entityId, ownId)
  }, [remote, ownId, card.entityId, card.name, pending, navigate])
  // A new chat with only them is this one, while it's pending with no one else.
  const alone =
    pending !== null &&
    view.cast?.participants.every((id) => id === card.entityId || view.cast?.playedByMe.includes(id))
  const [searching, setSearching] = useState(false)
  const [searchMatch, setSearchMatch] = useState<SearchMatch | null>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  return (
    <SearchNavigation value={searchMatch}>
      <div className="flex flex-col gap-4">
        <CardHeader
          portrait={
            remote ? (
              <CardHeaderPortrait>
                <Avatar
                  id={card.entityId}
                  name={card.name}
                  mediaId={card.avatarMediaId}
                  size="fill"
                  className="size-full"
                  preview
                />
              </CardHeaderPortrait>
            ) : (
              <TabPortrait
                store={store}
                call={call}
                id={card.entityId}
                shown={{ name: card.name, mediaId: card.avatarMediaId, crop: card.avatarCrop ?? null }}
                {...(session === null ? {} : { onChanged: () => void session.rereadCast() })}
                badge={persona ? <PersonaBadge played portrait /> : undefined}
              />
            )
          }
        >
          {remote && (
            <div data-card-header-row className="col-span-full">
              <RemoteCardLine card={card} beforeAdd={() => store.flush()} onAdded={adopted} />
            </div>
          )}
          {state.snapshot ? (
            <>
              <CardNameHeader
                store={store}
                call={call}
                saveControls={
                  <>
                    <SaveRevision store={store} adds={remote ? card.name : null} />
                    {!remote && (
                      <SlotOutlet
                        slot={chatCardActions}
                        only="card.edit"
                        props={{ session, card, info, persona, presentation: "header" }}
                      />
                    )}
                  </>
                }
                current={session === null ? undefined : { chatId: session.id, forkId: view.forkId }}
              />
              <CardTokensRow panel store={store} entityId={card.entityId} label={card.label} />
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
          {!persona && !alone && <NewChat card={card} guidance={guidance} />}
          {remote ? (
            <RemoteCardActions card={card} />
          ) : (
            <SlotOutlet slot={chatCardActions} except={["card.edit"]} props={{ session, card, info, persona }} />
          )}
        </div>
        {!remote && <SlotOutlet slot={chatCharacterRows} props={{ card, persona }} />}
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
            <div className="flex flex-wrap items-center gap-2">
              <SearchReplaceButton
                ref={searchButton}
                open={searching}
                controls="card-panel-search"
                onClick={() => setSearching(!searching)}
              />
              <SlotOutlet slot={panelEditorActions} props={{ store }} />
            </div>
            {searching && (
              <SearchDialog
                store={store}
                inline
                idPrefix="card-panel-search"
                onReveal={setSearchMatch}
                onClose={() => {
                  setSearching(false)
                  searchButton.current?.focus()
                }}
              />
            )}
            <RecoveredNotice store={store} />
            <SlotOutlet slot={editorNotices} props={{ store }} />
            <CardEditor
              store={store}
              call={call}
              layout="panel"
              onOpenBook={workspace && !remote ? () => workspace.open(info.refId, CARD_LOREBOOK_FOCUS) : undefined}
            />
          </>
        )}
      </div>
    </SearchNavigation>
  )
}
