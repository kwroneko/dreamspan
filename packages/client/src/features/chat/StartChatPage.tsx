import { offeredGreetings, greetingPick } from "@rp/shared/greetings.ts"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
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
// A new chat of a group (`/groups/$chatId/new`) is the same, with the group's characters:
// each member greets in turn, as ST starts a group chat (`getGroupChat` in its
// group-chats.js: the group's members in order, a member without a greeting skipped), each
// greeting with its card's alternates to pick from; the reply comes from the character
// picked, and the chat is titled with the group's name, so it's one of the group's chats.
import type { CastCard, ChatId, EntityId } from "@rp/shared/chat.ts"
import type { CardForChat, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { CharacterPanel } from "../characters/CharacterPanel.tsx"
import { rememberPanel, useWide } from "./ChatPanels.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { type ReactNode } from "react"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { composerKeyDown, composerSubmitHint } from "./composerKeys.ts"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { CastContext, castView } from "./cast.ts"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field } from "../../ui/Field.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Select } from "../../ui/Select.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useSession } from "../../session.ts"
import {
  copiesOf,
  type Copy,
  dropCopy,
  keepCopy,
  makeCopy,
  pendingChatCopy,
  pendingGroupChatCopy
} from "../editor/backup.ts"
import { GroupFaces } from "../characters/GroupFaces.tsx"
import { useTitle } from "../shell.tsx"
import { composerCarryCopy } from "./composerCarry.ts"
import { ComposerBox, useCompactComposer } from "./Composer.tsx"
import { expandForDisplay } from "./macros.ts"

const PERSONA_KEY = "rp.lastPersona"
const NONE = "none"

const savedPersona = () => {
  try {
    return localStorage.getItem(PERSONA_KEY)
  } catch {
    return null
  }
}
const savePersona = (id: string) => {
  try {
    localStorage.setItem(PERSONA_KEY, id)
  } catch {
    // Not remembered, then.
  }
}

/** A group the new chat is of: its name, its characters, the chat that names it, and each character's greetings. */
interface PendingGroup {
  readonly group: ChatGroup
  readonly chatId: ChatId
  /** Each member's card, in the group's order: each greets in turn. */
  readonly cards: ReadonlyArray<CardForChat>
}

interface PendingCast {
  readonly greeters: ReadonlyArray<CardForChat>
  readonly picks: ReadonlyArray<number>
  readonly persona: string
  readonly fallbackNote: string
}

/** One greeting of the chat not made yet, with its card's alternates to pick from. */
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
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <header className="flex items-center gap-2 text-sm">
        <Avatar
          id={card.card.entityId}
          name={name}
          mediaId={card.card.avatarMediaId}
          crop={card.card.avatarCrop}
          size="sm"
        />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {count > 1 && (
          <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label={`${name}'s greetings`}>
            <Button
              variant="ghost"
              aria-label={`Previous greeting from ${name}`}
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
            >
              ‹
            </Button>
            <span className="min-w-12 text-center text-muted tabular-nums">
              {index + 1} / {count}
            </span>
            <Button
              variant="ghost"
              aria-label={`Next greeting from ${name}`}
              disabled={index === count - 1}
              onClick={() => onIndex(index + 1)}
            >
              ›
            </Button>
          </div>
        )}
      </header>
      {groupOnly && <span className="text-xs text-muted">group greeting</span>}
      <Markdown text={text} streaming={false} />
    </article>
  )
}

function Pending({
  card,
  personas,
  cards,
  group = null
}: {
  /** The card that greets: the chat's card, or the group's first character. */
  card: CardForChat
  personas: ReadonlyArray<CastCard>
  /** Every card that could be the persona (any card can be, DESIGN §2.2). */
  cards: ReadonlyArray<CastCard>
  group?: PendingGroup | null
}) {
  const action = useAction()
  const navigate = useNavigate()
  const navigationSearch = useSearch({ strict: false }) as { panel?: string; character?: string }
  // Keep cast and choices together: an in-flight card read must apply to the latest
  // persona, members and greeting selections, including edits made while it loaded.
  const [{ persona, greeters, picks, fallbackNote }, setPendingCast] = useState<PendingCast>(() => {
    const saved = savedPersona()
    const persona = cards.find((p) => p.entityId === saved)?.entityId ?? personas[0]?.entityId ?? NONE
    const greeters = group?.cards ?? [card]
    const count = new Set(greeters.filter((item) => item.card.entityId !== persona).map((item) => item.card.entityId))
      .size
    return {
      persona,
      greeters,
      picks: greeters.map((greeter) => {
        const options = offeredGreetings(greeter, count)
        return group === null ? 0 : (options[Math.floor(Math.random() * Math.max(1, options.length))]?.index ?? 0)
      }),
      fallbackNote: ""
    }
  })
  const listCards = useCallback(() => Promise.resolve({ ok: true as const, value: cards }), [cards])
  // No chat yet: the switcher names cards from the list, and there are no members to join.
  const pendingView = useMemo(() => castView(null, cards), [cards])
  const characterCount = new Set(
    greeters.filter((item) => item.card.entityId !== persona).map((item) => item.card.entityId)
  ).size
  const options = greeters.map((item) => offeredGreetings(item, characterCount))
  const effectivePicks = options.map((list, at) => greetingPick(list, picks[at] ?? 0)?.index ?? -1)
  const changePendingCast = (change: (current: PendingCast) => PendingCast) => {
    setPendingCast((current) => {
      const next = change(current)
      const count = new Set(
        next.greeters.filter((item) => item.card.entityId !== next.persona).map((item) => item.card.entityId)
      ).size
      const adjusted = next.greeters.map(
        (item, at) => greetingPick(offeredGreetings(item, count), next.picks[at] ?? 0)?.index ?? -1
      )
      const fellBack = next.greeters.some(
        (item, at) =>
          item.groupGreetings.length > 0 &&
          (next.picks[at] ?? -1) >= item.greetings.length &&
          adjusted[at] !== next.picks[at]
      )
      return {
        ...next,
        picks: adjusted,
        fallbackNote: fellBack
          ? "The selected group greeting is no longer available. Using the card’s first greeting."
          : next.fallbackNote
      }
    })
  }
  const members = group === null && greeters.length === 1 ? null : greeters.map((item) => item.card)
  const availableCharacters = [...(group?.cards.map((item) => item.card) ?? []), ...cards]
  // Who replies: in a group, the character picked (its first, as the chat's default speaker).
  const [selectedSpeaker, setSelectedSpeaker] = useState<EntityId | null>(null)
  const [replier, setReplier] = useState<string>(card.card.entityId)
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
  const copyKey =
    group === null
      ? pendingChatCopy(entityId)
      : pendingGroupChatCopy(
          group.group.name,
          group.group.members.map((member) => member.entityId)
        )
  const durable = useUserDraft(copyKey, "First message", "")
  const sending = useRef<string | null>(null)
  const destination = useRef<string | null>(null)
  useEffect(() => {
    if (durable.ready && sending.current === null) {
      typed.current = durable.text
      setTextState(durable.text)
    }
  }, [durable.ready, durable.text])
  const copy = useRef<Copy | null>(null)
  const keep = (content: string) => {
    if (destination.current === null) durable.setText(content)
    const previous = copy.current
    copy.current = null
    if (content === "") {
      return previous === null ? Promise.resolve() : dropCopy(previous)
    }
    copy.current =
      destination.current !== null
        ? composerCarryCopy(
            userId,
            destination.current,
            entityId,
            group?.group.name ?? card.card.name,
            content,
            previous
          )
        : makeCopy(
            userId,
            copyKey,
            "first message",
            {
              kind: "pendingChat",
              payload:
                group === null
                  ? { entityId, name: card.card.name, content }
                  : { entityId, name: group.group.name, content, groupChatId: group.chatId }
            },
            // eslint-disable-next-line react-hooks/purity -- keep runs from input/request handlers; registered controls carry start as a callback.
            Date.now()
          )
    return keepCopy(copy.current, previous)
  }
  // The text left here before, if nothing's been typed since; the newest of them, when
  // several tabs left one (the others stay in the sidebar's Unsaved text).
  useEffect(() => {
    let current = true
    void copiesOf(userId, copyKey).then((copies) => {
      const newest = [...copies].sort((a, b) => b.at - a.at)[0]
      if (!current || newest === undefined || copy.current !== null || typed.current !== "") return
      copy.current = newest
      typed.current = newest.content
      setTextState(newest.content)
    })
    return () => {
      current = false
    }
  }, [userId, copyKey])
  const playing = cards.find((p) => p.entityId === persona) ?? null
  // The guidance toggle, as in the chat's composer (DESIGN §2.2).
  const viewPrefs = useViewPrefs()
  const { compact: phone, ref: composerRef } = useCompactComposer()
  const guidance = viewPrefs.prefs.guidance
  const name = card.card.name
  /** What the chat is with: the card, or the group. */
  const title = group?.group.name ?? name
  const repliers = greeters.filter((item) => item.card.entityId !== persona)
  const replyId = (repliers.find((item) => item.card.entityId === replier) ?? repliers[0] ?? card).card.entityId
  const castCards = [
    ...new Map(
      [...greeters.map((greeter) => greeter.card), ...(playing ? [playing] : [])].map((item) => [item.entityId, item])
    ).values()
  ]
  const speakerId = castCards.some((item) => item.entityId === selectedSpeaker)
    ? selectedSpeaker
    : (playing?.entityId ?? null)
  const speakerName = castCards.find((item) => item.entityId === speakerId)?.name ?? "You"
  const speakerView = castView({
    participants: castCards.map((item) => item.entityId),
    playedByMe: playing ? [playing.entityId] : [],
    cards: castCards,
    slotId: null,
    absent: [],
    model: null,
    preset: null,
    lorebooks: [],
    cardLorebooksOff: [],
    globalLorebooksOff: [],
    loreBelowHistory: true,
    macroBindings: {},
    macroNames: {
      user: playing?.modelName ?? playing?.name ?? "User",
      char: castCards
        .filter((item) => item.entityId !== playing?.entityId)
        .map((item) => item.modelName ?? item.name)
        .join(", ")
    },
    rolesProjection: null,
    roleProjections: []
  })
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
            // The greeting card leads; a group's chat has all its characters, under its name.
            cards: greeters.map((greeter) => greeter.card.entityId),
            persona: personaId,
            greeting: null,
            ...(group === null ? {} : { title: group.group.name }),
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
    destination.current = result.value.chat.id
    await keep(typed.current)
    await durable.commit(durable.text, async () => true)
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: result.value.chat.id },
      search: {
        ...(navigationSearch.panel ? { panel: navigationSearch.panel } : {}),
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
    changeGuidance: (next) => void viewPrefs.change({ guidance: next }),
    busy: action.pending,
    hasText: text.trim() !== "",
    start
  }

  return (
    <>
      <header className="chat-column flex flex-wrap items-center gap-3 pb-2">
        {members === null ? (
          <button
            type="button"
            aria-label={`Show ${name}'s card`}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={() => {
              rememberPanel(userId, `card:${card.card.entityId}`)
              void navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({ ...prev, panel: `card:${card.card.entityId}` })
              })
            }}
          >
            <Avatar id={card.card.entityId} name={name} mediaId={card.card.avatarMediaId} crop={card.card.avatarCrop} />
          </button>
        ) : (
          <span className="block aspect-[2/3] w-12 shrink-0 overflow-hidden rounded-lg">
            <GroupFaces members={members} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="text-lg font-semibold [overflow-wrap:anywhere]">
            {members === null ? name : `New chat: ${title}`}
          </h1>
          {members === null && card.card.subtitle && <p className="text-sm text-muted">{card.card.subtitle}</p>}
          {members !== null && (
            <p className="text-sm text-muted [overflow-wrap:anywhere]">
              With {members.map((member) => member.name).join(", ")}, who greet in turn. Saved when you send the first
              message.
            </p>
          )}
        </div>
        {/* A group's chat picks who replies too: both fields on a row of their own. */}
        <div className={`flex gap-3 ${members === null ? "w-full sm:w-56" : "w-full"}`}>
          {/* The same persona control as the chat's Cast tab, on Personas (DESIGN §2.2). */}
          <div
            role="group"
            aria-label="Your persona"
            className={`flex flex-col gap-1 ${members === null ? "w-full" : "flex-1 sm:w-56 sm:flex-none"}`}
          >
            <span className="text-sm font-medium">Playing as</span>
            <CastContext value={pendingView}>
              <SpeakerSwitcher
                listCards={listCards}
                speaker={playing?.entityId ?? null}
                recent={[]}
                persona
                pending
                onPick={(picked) => {
                  changePendingCast((current) => ({ ...current, persona: picked.entityId }))
                  savePersona(picked.entityId)
                }}
                onNone={() => {
                  changePendingCast((current) => ({ ...current, persona: NONE }))
                  savePersona(NONE)
                }}
              />
            </CastContext>
          </div>
          {members !== null && (
            <Field label="Reply from" className="flex-1 sm:w-56 sm:flex-none">
              <Select
                items={repliers.map(({ card: member }) => ({
                  value: member.entityId as string,
                  label: `${member.name}${member.subtitle ? ` · ${member.subtitle}` : ""}`
                }))}
                value={replyId}
                onValueChange={setReplier}
              />
            </Field>
          )}
        </div>
      </header>
      <div className="chat-column flex flex-wrap items-center gap-2" aria-label="Pending cast">
        {greeters.map((item, at) => (
          <span key={item.card.entityId} className="flex items-center gap-1 text-sm">
            {item.card.name}
            {at > 0 && (
              <Button
                variant="ghost"
                aria-label={`Remove ${item.card.name} from pending cast`}
                hint="Leaves them out of the new chat, with their greeting."
                onClick={() => {
                  changePendingCast((current) => ({
                    ...current,
                    greeters: current.greeters.filter((greeter) => greeter.card.entityId !== item.card.entityId),
                    picks: current.picks.filter(
                      (_, index) => current.greeters[index]!.card.entityId !== item.card.entityId
                    )
                  }))
                }}
              >
                Remove
              </Button>
            )}
          </span>
        ))}
        <Field label="Add character" className="w-full sm:w-56">
          <Select
            value={null}
            items={availableCharacters
              .filter(
                (item) =>
                  item.entityId !== persona && !greeters.some((greeter) => greeter.card.entityId === item.entityId)
              )
              .map((item) => ({ value: item.entityId, label: item.name }))}
            placeholder="Add character"
            onValueChange={(id) => {
              void action
                .run((client) => client("GetCardForChat", { entityId: id as EntityId }))
                .then((result) => {
                  if (result.ok) {
                    changePendingCast((current) =>
                      current.persona === result.value.card.entityId ||
                      current.greeters.some((item) => item.card.entityId === result.value.card.entityId)
                        ? current
                        : { ...current, greeters: [...current.greeters, result.value], picks: [...current.picks, 0] }
                    )
                  }
                })
            }}
          />
        </Field>
      </div>
      {fallbackNote && (
        <p role="status" className="chat-column text-sm text-muted">
          {fallbackNote}
        </p>
      )}
      <div className="chat-column flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-2">
        {options.every((list) => list.length === 0) && (
          <p className="text-sm text-muted">
            {members === null ? `${name} has no greeting.` : "None of them has a greeting."} Your first message starts
            the chat.
          </p>
        )}
        {greeters.map((greeter, at) =>
          options[at]!.length === 0 ? (
            members !== null && (
              <p key={greeter.card.entityId} className="text-sm text-muted">
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
              onIndex={(index) => {
                setPendingCast((current) => ({
                  ...current,
                  fallbackNote: "",
                  picks: effectivePicks.map((pick, i) => (i === at ? options[at]![index]!.index : pick))
                }))
              }}
              text={expandGreeting(at, effectivePicks[at]!)}
            />
          )
        )}
      </div>
      <div ref={composerRef} className="chat-column flex flex-col gap-2 border-t border-border pt-2 pb-2">
        <PendingComposerControls placement="notes" context={controls} />
        <UserDraftStatus draft={durable} />
        {/* The chat's composer box: the text on its own row, who's speaking and the actions under it. */}
        <ComposerBox
          guidance={guidance}
          start={
            <CastContext value={speakerView}>
              <PendingComposerControls placement="speaker" context={controls} />
            </CastContext>
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
            placeholder={guidance ? "Direction for the next message…" : "Message…"}
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
              ? `Guidance: a one-turn direction for ${speakerName}'s first reply. It leaves the box when you submit it.`
              : "Generate doesn't use this text: turn guidance on to direct the reply with it."}
          </p>
        )}
        <ErrorAlert error={action.error} />
      </div>
    </>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="ghost" onClick={onRetry}>
      Try again
    </Button>
  )
}

/** /cards/$entityId/chat: a new chat with a card, made on its first send. */
export function StartChatPage() {
  const { entityId } = useParams({ strict: false }) as { entityId: EntityId }
  const action = useAction()
  const [loaded, setLoaded] = useState<{
    card: CardForChat
    personas: ReadonlyArray<CastCard>
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
          cards: client("ListCards", undefined)
        })
      )
      .then((result) => {
        if (result.ok) {
          const cards = result.value.cards.filter((c) => c.entityId !== entityId)
          setLoaded({ card: result.value.card, personas: cards.filter((c) => c.persona), cards })
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per card and attempt
  }, [entityId, attempt])
  return (
    <PendingLayout entityId={entityId}>
      <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-4">
        {loaded ? (
          <Pending key={entityId} card={loaded.card} personas={loaded.personas} cards={loaded.cards} />
        ) : action.error ? (
          <ErrorAlert error={action.error} actions={<RetryButton onRetry={retry} />} />
        ) : (
          <Loading label="Loading the card…" onRetry={retry} />
        )}
      </div>
    </PendingLayout>
  )
}

/** /groups/$chatId/new: a new chat with a group's characters, made on its first send. */
export function StartGroupChatPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const action = useAction()
  const [loaded, setLoaded] = useState<{
    group: ChatGroup
    cards: ReadonlyArray<CardForChat>
    personas: ReadonlyArray<CastCard>
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
          const { greeters, cards } = yield* Effect.all(
            {
              greeters: Effect.forEach(
                group.members,
                (member) => client("GetCardForChat", { entityId: member.entityId }),
                { concurrency: "unbounded" }
              ),
              cards: client("ListCards", undefined)
            },
            { concurrency: "unbounded" }
          )
          return { group, greeters, cards }
        })
      )
      .then((result) => {
        if (!result.ok) return
        const { group, greeters, cards } = result.value
        const inGroup = new Set<string>(group.members.map((member) => member.entityId))
        const all = cards.filter((c) => !inGroup.has(c.entityId))
        setLoaded({ group, cards: greeters, personas: all.filter((c) => c.persona), all })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per group and attempt
  }, [chatId, attempt])
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-4">
      {loaded ? (
        <Pending
          key={chatId}
          card={loaded.cards[0]!}
          personas={loaded.personas}
          cards={loaded.all}
          group={{ group: loaded.group, chatId, cards: loaded.cards }}
        />
      ) : action.error ? (
        <ErrorAlert error={action.error} actions={<RetryButton onRetry={retry} />} />
      ) : (
        <Loading label="Loading the group…" onRetry={retry} />
      )}
    </div>
  )
}

function PendingLayout({ entityId, children }: { entityId: EntityId; children: ReactNode }) {
  const search = useSearch({ strict: false }) as { panel?: string }
  const navigate = useNavigate()
  const wide = useWide()
  const open = search.panel?.startsWith("card:") ?? false
  const userId = useSession().user.id
  const close = () => {
    rememberPanel(userId, null)
    void navigate({ to: ".", search: ({ panel: _panel, ...prev }: Record<string, unknown>) => prev, replace: true })
  }
  const body = (
    <>
      <Button variant="ghost" onClick={close}>
        Close the panel
      </Button>
      <CharacterPanel entityId={entityId} />
    </>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {children}
      {open &&
        (wide ? (
          <aside
            aria-label="Character panel"
            className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface p-4"
          >
            {body}
          </aside>
        ) : (
          <Sheet open onOpenChange={(v) => !v && close()} title="Character">
            {body}
          </Sheet>
        ))}
    </div>
  )
}
