import type { Draft } from "@rp/shared/drafts.ts"
import { greetingPick } from "@rp/shared/greetings.ts"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { StripRow } from "./nextReplyStrip.tsx"
import {
  PendingComposerControls,
  invokePendingComposer,
  type PendingComposerContext
} from "./pendingComposerControls.tsx"
// A chat that doesn't exist yet (DESIGN §2.1): a card's greeting, with its alternates to
// pick from and `{{user}}` following the persona picked, and a composer. The chat is made
// only on the first send, so opening cards leaves no greeting-only chats behind. Pending
// prose has a private server draft and browser copy before that chat exists (DESIGN §6.2).
//
// It looks and works like any other chat (owner, 2026-11-02): the saved chat's header, message
// column, composer and side panel, resizable, with the same tabs in the same places. Its state
// is a `PendingChat` (pendingChat.ts) the panel's tabs change: who's in it (Cast, with Add
// characters), who the user plays, who answers first. Tabs that need a saved chat say so.
//
// A new chat of a group (`/groups/$chatId/new`) is the same, with the group's characters:
// each member greets in turn, as ST starts a group chat (`getGroupChat` in its
// group-chats.js: the group's members in order, a member without a greeting skipped), each
// greeting with its card's alternates to pick from; the reply comes from the character
// picked, and the chat is titled with the group's name, so it's one of the group's chats.
import type { CastCard, ChatId, EntityId } from "@rp/shared/chat.ts"
import type { CardForChat, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { Effect, Option } from "effect"
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { IconButton, TooltipProvider } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSession } from "../../session.ts"
import { useCaller } from "../editor/caller.ts"
import { type Copy, dropCopy, keepCopy, pendingChatCopy, pendingGroupChatCopy } from "../editor/backup.ts"
import { useTitle } from "../shell.tsx"
import { CastContext, type CastView, castView } from "./cast.ts"
import { ChatPortraitProvider } from "./ChatPortraitProvider.tsx"
import { PendingChatHeader } from "./ChatHeader.tsx"
import { ChatSidePanel, usePanel } from "./ChatPanels.tsx"
import { composerCarryCopy } from "./composerCarry.ts"
import { ComposerBox, useCompactComposer } from "./Composer.tsx"
import { composerKeyDown, composerSubmitHint } from "./composerKeys.ts"
import { expandForDisplay } from "./macros.ts"
import { useIsPanelTab } from "./panels.tsx"
import { PendingChat, pendingOptions, pendingTitle } from "./pendingChat.ts"
import { chatColumns } from "./presentation.tsx"
import { seedChat } from "./session.ts"
import { preloadChatPage } from "./chatPageLoader.ts"

/**
 * One greeting of the chat not made yet, as the saved chat shows a message: the portrait, the
 * name, the text, and its card's alternates to step through at its end, as a message's versions.
 */
function Greeting({
  card,
  index,
  onIndex,
  text,
  groupOnly,
  count
}: {
  card: CardForChat
  index: number
  onIndex: (index: number) => void
  /** The greeting shown, its macros expanded. */
  text: string
  groupOnly: boolean
  count: number
}) {
  const name = card.card.name
  return (
    <article
      aria-label={`Greeting from ${name}`}
      className="group flex gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:bg-surface-raised/40 max-sm:gap-2.5 max-sm:px-2.5"
    >
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <Avatar
          id={card.card.entityId}
          name={name}
          mediaId={card.card.avatarMediaId}
          crop={card.card.avatarCrop}
          size="chat"
          preview
          className="mt-0.5"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex min-h-8 min-w-0 items-center gap-x-2 text-sm max-sm:flex-wrap max-sm:gap-y-1">
          <span className="min-w-0 font-semibold max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:max-w-48 sm:shrink-0 sm:truncate">
            {name}
          </span>
          {groupOnly && <span className="shrink-0 text-xs text-muted">group greeting</span>}
        </header>
        <Markdown text={text} streaming={false} />
        {count > 1 && (
          <footer className="flex min-h-8 items-center">
            <span className="flex-1" />
            <div className="flex shrink-0 items-center" role="group" aria-label={`${name}'s greetings`}>
              <IconButton
                label={`Previous greeting from ${name}`}
                hint="Shows their previous greeting: the chat starts with the one shown"
                icon="left"
                className="max-sm:size-7"
                disabled={index === 0}
                onClick={() => onIndex(index - 1)}
              />
              <span className="inline-flex h-8 min-w-9 items-center justify-center px-1 text-xs text-muted tabular-nums">
                {index + 1}/{count}
              </span>
              <IconButton
                label={`Next greeting from ${name}`}
                hint="Shows their next greeting: the chat starts with the one shown"
                icon="right"
                className="max-sm:size-7"
                disabled={index === count - 1}
                onClick={() => onIndex(index + 1)}
              />
            </div>
          </footer>
        )}
      </div>
    </article>
  )
}

function Pending({
  pending,
  card,
  groupMembers
}: {
  pending: PendingChat
  /** The card that greets first: the chat's card, or the group's first character. */
  card: CardForChat
  /** A group's characters as the group names them: its pending copy's key. */
  groupMembers: ReadonlyArray<string> | null
}) {
  const action = useAction()
  const navigate = useNavigate()
  const navigationSearch = useSearch({ strict: false }) as { panel?: string; character?: string; guidance?: string }
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const view = pending.view()
  const { greeters, picks, persona, fallbackNote } = state
  const group = pending.group
  const options = pendingOptions(state)
  const effectivePicks = options.map((list, at) => greetingPick(list, picks[at] ?? 0)?.index ?? -1)
  const members = group === null && greeters.length === 1 ? null : greeters.map((item) => item.card)
  // Who replies: in a group, the character picked (its first, as the chat's default speaker).
  const [selectedSpeaker, setSelectedSpeaker] = useState<EntityId | null>(null)
  const [text, setTextState] = useState("")
  // The latest text, for what's typed while the first send is on its way (read after it).
  const typed = useRef("")
  const setText = (next: string | ((current: string) => string)) =>
    setTextState((current) => {
      const value = typeof next === "function" ? next(current) : next
      typed.current = value
      return value
    })
  // This browser's copy of the text, and the text on its way in the first send.
  const userId = useSession().user.id
  const entityId = card.card.entityId
  const copyKey = group === null ? pendingChatCopy(entityId) : pendingGroupChatCopy(group.name, groupMembers ?? [])
  const durable = useUserDraft(copyKey, "First message", "")
  // The saved chat's page, ready before the first send opens it.
  useEffect(preloadChatPage, [])
  const sending = useRef<string | null>(null)
  const destination = useRef<{ chatId: string; composer: Draft } | null>(null)
  // The draft store reconciles its synchronous and IndexedDB backups before opening.
  useEffect(() => {
    if (!durable.ready || sending.current !== null) return
    typed.current = durable.text
    setTextState(durable.text)
  }, [durable.ready, durable.text])
  const copy = useRef<Copy | null>(null)
  const keep = (content: string) => {
    if (destination.current === null) {
      durable.setText(content)
      return Promise.resolve()
    }
    const previous = copy.current
    copy.current = null
    if (content === "") return previous === null ? Promise.resolve() : dropCopy(previous)
    copy.current = composerCarryCopy(
      userId,
      destination.current.chatId,
      entityId,
      group?.name ?? card.card.name,
      content,
      previous,
      destination.current.composer
    )
    return keepCopy(copy.current, previous)
  }
  const playing = pending.playing(state)
  // The guidance toggle, as in the chat's composer (DESIGN §2.2).
  const viewPrefs = useViewPrefs()
  const { compact: phone, ref: composerRef } = useCompactComposer()
  const guidance = state.guidance
  const setGuidance = (guidance: boolean) => pending.change((state) => ({ ...state, guidance }))
  const repliers = greeters.filter((item) => item.card.entityId !== persona)
  const replyId = (repliers.find((item) => item.card.entityId === state.replier) ?? repliers[0] ?? card).card.entityId
  const castCards = view.cast?.cards ?? []
  const speakerId = castCards.some((item) => item.entityId === selectedSpeaker)
    ? selectedSpeaker
    : (playing?.entityId ?? null)
  const speakerName = castCards.find((item) => item.entityId === speakerId)?.name ?? "You"
  // Rows and the composer read the cast from context, as in a saved chat.
  const castState = view.cast
  const cast = useMemo(() => castView(castState), [castState])
  // What each greeting's random and time macros drew when first shown, by greeter and
  // greeting: the chat keeps them, so a greeting reads the same after the send (DESIGN §5.6).
  const [frozen] = useState(() => new Map<string, Map<number, FrozenValues>>())
  const draws = (at: number) => {
    const id = greeters[at]!.card.entityId
    if (!frozen.has(id)) frozen.set(id, new Map())
    return frozen.get(id)!
  }
  const expandGreeting = (at: number, index: number) => {
    const greeter = greeters[at]!
    const fields = {
      description: greeter.description,
      personality: greeter.personality,
      scenario: greeter.scenario
    }
    const result = expandForDisplay(
      options[at]!.find((option) => option.index === index)!.text,
      "template",
      { user: playing?.modelName ?? playing?.name ?? "User", char: greeter.card.modelName ?? greeter.card.name },
      fields,
      draws(at).get(index) ?? {}
    )
    draws(at).set(index, result.frozen)
    return result.text
  }
  // The side panel: the saved chat's, its tab in the URL and remembered the same way.
  const urlPanel = useIsPanelTab(navigationSearch.panel) ? navigationSearch.panel! : null
  const { panel, show, wide } = usePanel(urlPanel, view)
  const title = pendingTitle(pending, state)
  const prefs = viewPrefs.prefs

  const start = async (first: "send" | "generate") => {
    if (!viewPrefs.ready || action.pending || (first === "send" && text.trim() === "")) return
    const personaId = playing?.entityId ?? null
    // A sent message, or guidance for the first reply, leaves the box as it's sent; whatever
    // is typed while the chat is being made goes along to its composer, and a failure puts
    // the submitted text back. With guidance off, Generate doesn't use the text, which stays
    // in the box and goes along too.
    const submitted = text
    const sent = first === "send" || guidance
    sending.current = sent ? submitted : ""
    if (sent) setText("")
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const started = yield* client("StartChat", {
            guidance,
            // The greeting card leads; a group's chat has all its characters, under its name.
            cards: greeters.map((greeter) => greeter.card.entityId),
            persona: personaId,
            greeting: null,
            ...(group === null ? {} : { title: group.name }),
            greeters: greeters.map((greeter, at) => {
              const shown = draws(at).get(effectivePicks[at] ?? 0)
              return {
                entityId: greeter.card.entityId,
                greeting: Math.max(0, effectivePicks[at] ?? 0),
                ...(shown === undefined ? {} : { frozen: shown })
              }
            }),
            first:
              first === "send"
                ? { _tag: "Send", content: submitted, speakerEntityId: speakerId }
                : { _tag: "Generate", speakerEntityId: speakerId, direction: guidance ? submitted : "" }
          })
          // A message gets its reply, as after any send; a server without a generator still keeps the message.
          if (first === "send") {
            yield* Effect.ignore(
              client("Generate", {
                chatId: started.chat.id,
                parentSlotId: started.entry.slotId,
                branch: false,
                speakerEntityId: replyId
              })
            )
          }
          // What the saved chat's page opens on, so it shows the chat at once rather than
          // loading it (no skeleton, no placeholder title); it reads it all again behind.
          const opened = yield* Effect.option(
            Effect.gen(function* () {
              const path = yield* client("ReadPath", {
                chatId: started.chat.id,
                forkId: null,
                leafSlotId: null,
                range: { _tag: "Bottom" },
                limit: 60
              })
              const cast = yield* client("GetCast", { chatId: started.chat.id, slotId: path.leafSlotId })
              return { path, cast }
            })
          )
          if (Option.isSome(opened)) {
            const { path, cast } = opened.value
            seedChat(started.chat.id, {
              chat: started.chat,
              forkId: path.forkId,
              leafSlotId: path.leafSlotId,
              entries: path.entries,
              older: path.older,
              newer: path.newer,
              cast
            })
          }
          return started
        }),
      ["chats"]
    )
    sending.current = null
    if (!result.ok) {
      if (sent && submitted !== "") {
        const restored = typed.current === "" ? submitted : `${submitted}\n\n${typed.current}`
        setText(restored)
        void keep(restored)
      }
      return
    }
    // Only submitted text was acknowledged. Atomically replace the pending copy with
    // the extra text addressed to the saved chat, before navigating or opening its draft.
    destination.current = { chatId: result.value.chat.id, composer: result.value.composer }
    await keep(typed.current)
    await durable.commit(durable.text, async () => true)
    // The saved chat opens in place: the same page, its panel at the same tab.
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: result.value.chat.id },
      replace: true,
      search: {
        ...(panel !== null ? { panel } : {}),
        ...(navigationSearch.character ? { character: navigationSearch.character } : {})
      }
    })
  }

  const controls: PendingComposerContext = {
    compact: phone,
    speaker: { speaker: speakerId, recent: [], pending: true, onPick: (picked) => setSelectedSpeaker(picked.entityId) },
    speakerName,
    submitHint: composerSubmitHint(viewPrefs.prefs.enterSends),
    guidance,
    prefsReady: viewPrefs.ready,
    changeGuidance: setGuidance,
    busy: action.pending,
    hasText: text.trim() !== "",
    start,
    view,
    onSettings: show
  }

  return (
    <PendingSurface cast={cast} wide={wide} ready={view.cast !== null}>
      <div
        className="flex min-h-0 flex-1"
        style={
          {
            "--chat-portrait-width": `${{ small: 48, default: 60, large: 72, largest: 84 }[prefs.portraitSize]}px`
          } as CSSProperties
        }
      >
        <SlotOutlet slot={chatColumns} props={{ wide }} />
        <div data-chat-main className="relative flex min-w-0 flex-1 flex-col">
          <PendingChatHeader
            pending={pending}
            view={view}
            title={title}
            panel={{ userId, open: panel, wide, onToggle: (tab) => show(panel === tab ? null : tab) }}
          />
          {fallbackNote && (
            <p role="status" className="chat-column border-b border-border px-2 py-1 text-sm text-muted">
              {fallbackNote}
            </p>
          )}
          <TooltipProvider>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {/* The message list's column, its padding and its gap between rows. */}
              <div className="chat-column flex flex-col gap-1.5 py-4">
                {options.every((list) => list.length === 0) && (
                  <p className="px-3 text-sm text-muted">
                    {members === null ? `${card.card.name} has no greeting.` : "None of them has a greeting."} Your
                    first message starts the chat.
                  </p>
                )}
                {greeters.map((greeter, at) =>
                  options[at]!.length === 0 ? (
                    members !== null && (
                      <p key={greeter.card.entityId} className="px-3 text-sm text-muted">
                        {greeter.card.name} has no greeting.
                      </p>
                    )
                  ) : (
                    <Greeting
                      key={greeter.card.entityId}
                      card={greeter}
                      count={options[at]!.length}
                      groupOnly={greetingPick(options[at]!, effectivePicks[at]!)!.groupOnly}
                      index={options[at]!.findIndex((option) => option.index === effectivePicks[at])}
                      onIndex={(index) => pending.pick(at, options[at]![index]!.index)}
                      text={expandGreeting(at, effectivePicks[at]!)}
                    />
                  )
                )}
              </div>
            </div>
          </TooltipProvider>
          {/* What to know before sending, above the composer as the saved chat's notes are. */}
          <PendingComposerControls placement="notes" context={controls} />
          {/* The chat's composer: its column, the box, and what's said under it. */}
          <div
            ref={composerRef}
            className="@container chat-column flex flex-col gap-1.5 border-t border-border pt-2 pb-2 max-sm:px-2"
          >
            <ComposerBox
              guidance={guidance}
              header={<UserDraftNotices draft={durable} />}
              start={
                <>
                  <PendingComposerControls placement="speaker" context={controls} />
                  {/* Where the saved composer has its earlier text. */}
                  <UserDraftUndo draft={durable} />
                </>
              }
              end={
                <>
                  <PendingComposerControls placement="guidance" context={controls} />
                  <PendingComposerControls placement="actions" context={controls} />
                </>
              }
            >
              {guidance && (
                <span aria-hidden className="px-2 pt-0.5 text-xs font-medium text-guidance">
                  Guidance
                </span>
              )}
              <label htmlFor="composer" className="sr-only">
                {guidance ? "Guidance" : "Message"}
              </label>
              <AutoGrowTextarea
                id="composer"
                data-testid="composer"
                value={text}
                // Short, so it fits one line on a phone, as the chat's composer does.
                placeholder={guidance ? "Guidance for the next message…" : "Message…"}
                aria-describedby={text.trim() !== "" || guidance ? "composer-hint" : undefined}
                onKeyDown={(event) =>
                  composerKeyDown(async () => {
                    await invokePendingComposer(controls)
                  }, viewPrefs.prefs.enterSends)(event)
                }
                onChange={(event) => {
                  const value = event.currentTarget.value
                  typed.current = value
                  setText(value)
                  // While the first send is out, the copy keeps both, as a failed send leaves them.
                  const out = sending.current
                  void keep(out === null || out === "" ? value : value === "" ? out : `${out}\n\n${value}`)
                }}
              />
            </ComposerBox>
            {(guidance || text.trim() !== "") && (
              <p id="composer-hint" className="text-xs text-muted">
                {guidance
                  ? `Guidance: one-turn guidance for ${speakerName}'s first reply. It leaves the box when you submit it.`
                  : "Write doesn't use this text: turn guidance on to direct the reply with it."}
              </p>
            )}
            <ErrorAlert error={action.error} />
            <StripRow scroll={phone}>
              <PendingComposerControls placement="strip" context={controls} />
            </StripRow>
          </div>
        </div>
        {panel !== null && (
          <ChatSidePanel
            tab={panel}
            wide={wide}
            title={title}
            onTab={show}
            onClose={() => show(null)}
            pending={pending}
            view={view}
          />
        )}
      </div>
    </PendingSurface>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="ghost" onClick={onRetry}>
      Try again
    </Button>
  )
}

/** Holds the pending chat for as long as the page shows this card or group. */
function PendingFor({
  card,
  cards,
  greeters,
  group,
  defaultPersona
}: {
  card: CardForChat
  defaultPersona: EntityId | null
  cards: ReadonlyArray<CastCard>
  greeters: ReadonlyArray<CardForChat>
  group: { name: string; chatId: ChatId; members: ReadonlyArray<string> } | null
}) {
  const call = useCaller()
  const search = useSearch({ strict: false }) as { guidance?: string }
  const [pending] = useState(
    () =>
      new PendingChat(
        cards,
        greeters,
        group && { name: group.name, chatId: group.chatId },
        call,
        defaultPersona,
        search.guidance === "on"
      )
  )
  return <Pending pending={pending} card={card} groupMembers={group?.members ?? null} />
}

/** /cards/$entityId/chat: a new chat with a card, made on its first send. */
export function StartChatPage() {
  const { entityId } = useParams({ strict: false }) as { entityId: EntityId }
  const action = useAction()
  const [loaded, setLoaded] = useState<{
    card: CardForChat
    defaultPersona: EntityId | null
    cards: ReadonlyArray<CastCard>
  } | null>(null)
  useTitle(loaded ? loaded.card.card.name : "New chat")
  // Asking again after a failure or a load that takes too long.
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    action.clearError()
    setAttempt((n) => n + 1)
  }
  useEffect(() => {
    void action
      .run((client) =>
        Effect.all({
          card: client("GetCardForChat", { entityId }),
          cards: client("ListCards", undefined),
          defaults: client("GetGenerationDefaults", undefined)
        })
      )
      .then((result) => {
        if (result.ok)
          setLoaded({
            card: result.value.card,
            cards: result.value.cards.filter((c) => c.entityId !== entityId),
            defaultPersona: result.value.defaults.persona ?? null
          })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per card and attempt
  }, [entityId, attempt])
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col">
      {loaded ? (
        <PendingFor
          key={entityId}
          card={loaded.card}
          cards={loaded.cards}
          greeters={[loaded.card]}
          group={null}
          defaultPersona={loaded.defaultPersona}
        />
      ) : action.error ? (
        <div className="chat-column pt-4">
          <ErrorAlert error={action.error} actions={<RetryButton onRetry={retry} />} />
        </div>
      ) : (
        <div className="chat-column pt-4">
          <Loading label="Loading the card…" onRetry={retry} />
        </div>
      )}
    </div>
  )
}

/** /groups/$chatId/new: a new chat with a group's characters, made on its first send. */
export function StartGroupChatPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const action = useAction()
  const [loaded, setLoaded] = useState<{
    group: ChatGroup
    defaultPersona: EntityId | null
    cards: ReadonlyArray<CardForChat>
    all: ReadonlyArray<CastCard>
  } | null>(null)
  useTitle(loaded ? `New chat: ${loaded.group.name}` : "New chat")
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    action.clearError()
    setAttempt((n) => n + 1)
  }
  useEffect(() => {
    void action
      .run((client) =>
        Effect.gen(function* () {
          const { group } = yield* client("ListGroupChats", { chatId })
          // Every member's greetings: each greets in turn.
          const { greeters, cards, defaults } = yield* Effect.all(
            {
              greeters: Effect.forEach(
                group.members,
                (member) => client("GetCardForChat", { entityId: member.entityId }),
                { concurrency: "unbounded" }
              ),
              cards: client("ListCards", undefined),
              defaults: client("GetGenerationDefaults", undefined)
            },
            { concurrency: "unbounded" }
          )
          return { group, greeters, cards, defaults }
        })
      )
      .then((result) => {
        if (!result.ok) return
        const { group, greeters, cards, defaults } = result.value
        const inGroup = new Set<string>(group.members.map((member) => member.entityId))
        setLoaded({
          group,
          cards: greeters,
          all: cards.filter((c) => !inGroup.has(c.entityId)),
          defaultPersona: defaults.persona ?? null
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per group and attempt
  }, [chatId, attempt])
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col">
      {loaded ? (
        <PendingFor
          key={chatId}
          card={loaded.cards[0]!}
          cards={loaded.all}
          defaultPersona={loaded.defaultPersona}
          greeters={loaded.cards}
          group={{
            name: loaded.group.name,
            chatId,
            members: loaded.group.members.map((member) => member.entityId)
          }}
        />
      ) : action.error ? (
        <div className="chat-column pt-4">
          <ErrorAlert error={action.error} actions={<RetryButton onRetry={retry} />} />
        </div>
      ) : (
        <div className="chat-column pt-4">
          <Loading label="Loading the group…" onRetry={retry} />
        </div>
      )}
    </div>
  )
}

/** The pending chat's cast, and its portrait viewer as a saved chat's: its portraits open beside it. */
function PendingSurface({
  cast,
  wide,
  ready,
  children
}: {
  cast: CastView
  wide: boolean
  ready: boolean
  children: ReactNode
}) {
  return (
    <CastContext value={cast}>
      <ChatPortraitProvider wide={wide} cast={cast} ready={ready}>
        {children}
      </ChatPortraitProvider>
    </CastContext>
  )
}
