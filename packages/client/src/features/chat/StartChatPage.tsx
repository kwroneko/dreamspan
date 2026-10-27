// A chat that doesn't exist yet (DESIGN §2.1): a card's greeting, with its alternates to
// pick from and `{{user}}` following the persona picked, and a composer. Nothing is saved
// until the first send, so opening cards never leaves greeting-only chats behind. What's
// typed is kept in this browser (editor/backup.ts) until that send makes the chat, whose
// own composer draft takes over: leaving and coming back finds it (DESIGN §6.2).
//
// A new chat of a group (`/groups/$chatId/new`) is the same, with the group's characters:
// each member greets in turn, as ST starts a group chat (`getGroupChat` in its
// group-chats.js: the group's members in order, a member without a greeting skipped), each
// greeting with its card's alternates to pick from; the reply comes from the character
// picked, and the chat is titled with the group's name, so it's one of the group's chats.
import type { CastCard, ChatId, EntityId } from "@rp/shared/chat.ts"
import type { CardForChat, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import { useNavigate, useParams } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { composerKeyDown } from "./composerKeys.ts"
import { SendIcon } from "./icons.tsx"
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

/** One greeting of the chat not made yet, with its card's alternates to pick from. */
function Greeting({
  card,
  index,
  onIndex,
  text
}: {
  card: CardForChat
  index: number
  onIndex: (index: number) => void
  /** The greeting shown, its macros expanded. */
  text: string
}) {
  const name = card.card.name
  const count = card.greetings.length
  return (
    <article
      aria-label={`Greeting from ${name}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <header className="flex items-center gap-2 text-sm">
        <Avatar id={card.card.entityId} name={name} mediaId={card.card.avatarMediaId} size="sm" />
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
      <Markdown text={text} streaming={false} />
    </article>
  )
}

function Pending({
  card,
  personas,
  group = null
}: {
  /** The card that greets: the chat's card, or the group's first character. */
  card: CardForChat
  personas: ReadonlyArray<CastCard>
  group?: PendingGroup | null
}) {
  const action = useAction()
  const navigate = useNavigate()
  const [persona, setPersona] = useState<string>(() => {
    const saved = savedPersona()
    return personas.find((p) => p.entityId === saved)?.entityId ?? personas[0]?.entityId ?? NONE
  })
  // Who greets: the card, or each of the group's characters in turn; the greeting picked of each.
  const greeters = group?.cards ?? [card]
  const [picks, setPicks] = useState<ReadonlyArray<number>>(() =>
    greeters.map((greeter) => (group === null ? 0 : Math.floor(Math.random() * Math.max(1, greeter.greetings.length))))
  )
  const greeting = picks[0] ?? 0
  const members = group?.group.members ?? null
  // Who replies: in a group, the character picked (its first, as the chat's default speaker).
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
  const copy = useRef<Copy | null>(null)
  const sending = useRef<string | null>(null)
  const destination = useRef<string | null>(null)
  const keep = (content: string) => {
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
            Date.now()
          )
    return keepCopy(copy.current, previous)
  }
  // The text left here before, if nothing's been typed since; the newest of them, when
  // several tabs left one (the others stay in Browser recovery).
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
  const playing = personas.find((p) => p.entityId === persona) ?? null
  const name = card.card.name
  /** What the chat is with: the card, or the group. */
  const title = group?.group.name ?? name
  const replyId = (members === null ? entityId : replier) as EntityId
  const replyName = members?.find((member) => member.entityId === replyId)?.name ?? name
  // What each greeting's random and time macros drew when first shown, by greeter and
  // greeting: the chat keeps them, so a greeting reads the same after the send (DESIGN §5.6).
  const [frozen] = useState(() => greeters.map(() => new Map<number, FrozenValues>()))
  const expandGreeting = (at: number, index: number) => {
    const greeter = greeters[at]!
    const fields = {
      description: greeter.description,
      personality: greeter.personality,
      scenario: greeter.scenario
    }
    const result = expandForDisplay(
      greeter.greetings[index]!,
      "template",
      { user: playing?.modelName ?? playing?.name ?? "User", char: greeter.card.modelName ?? greeter.card.name },
      fields,
      frozen[at]!.get(index) ?? {}
    )
    frozen[at]!.set(index, result.frozen)
    return result.text
  }

  const start = async (first: "send" | "generate") => {
    if (action.pending || (first === "send" && text.trim() === "")) return
    const personaId = playing?.entityId ?? null
    // The text leaves the box as it's sent; whatever is typed while the chat is being made
    // goes along to its composer, and a failure puts the sent text back.
    const submitted = text
    sending.current = submitted
    setText("")
    const shownFrozen = card.greetings.length > 0 ? frozen[0]!.get(greeting) : undefined
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const started = yield* client("StartChat", {
            // The greeting card leads; a group's chat has all its characters, under its name.
            cards: members === null ? [entityId] : members.map((member) => member.entityId),
            persona: personaId,
            ...(group === null
              ? {
                  greeting: card.greetings.length > 0 ? greeting : null,
                  // The picked greeting as it was shown; the server freezes the rest itself.
                  ...(shownFrozen === undefined ? {} : { frozen: shownFrozen })
                }
              : {
                  title: group.group.name,
                  greeting: null,
                  // Each member greets in turn, with the greeting picked as it was shown.
                  greeters: group.cards.map((greeter, at) => {
                    const shown = frozen[at]!.get(picks[at] ?? 0)
                    return {
                      entityId: greeter.card.entityId,
                      greeting: picks[at] ?? 0,
                      ...(shown === undefined ? {} : { frozen: shown })
                    }
                  })
                }),
            first:
              first === "send"
                ? { _tag: "Send", content: submitted, speakerEntityId: personaId }
                : { _tag: "Generate", speakerEntityId: replyId, direction: submitted }
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
      if (submitted !== "") {
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
    void navigate({ to: "/chats/$chatId", params: { chatId: result.value.chat.id } })
  }

  return (
    <>
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3 pb-2">
        {members === null ? (
          <Avatar id={card.card.entityId} name={name} mediaId={card.card.avatarMediaId} />
        ) : (
          <span className="block size-12 shrink-0 overflow-hidden rounded-lg">
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
          <Field label="Playing as" className={members === null ? "w-full" : "flex-1 sm:w-56 sm:flex-none"}>
            <Select
              items={[
                ...personas.map((p) => ({
                  value: p.entityId as string,
                  label: `${p.name}${p.subtitle ? ` · ${p.subtitle}` : ""}`
                })),
                { value: NONE, label: "No persona" }
              ]}
              value={persona}
              onValueChange={(next) => {
                setPersona(next)
                savePersona(next)
              }}
            />
          </Field>
          {members !== null && (
            <Field label="Reply from" className="flex-1 sm:w-56 sm:flex-none">
              <Select
                items={members.map((member) => ({
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
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 overflow-y-auto py-2">
        {greeters.every((greeter) => greeter.greetings.length === 0) && (
          <p className="text-sm text-muted">
            {members === null ? `${name} has no greeting.` : "None of them has a greeting."} Your first message starts
            the chat.
          </p>
        )}
        {greeters.map((greeter, at) =>
          greeter.greetings.length === 0 ? (
            members !== null && (
              <p key={greeter.card.entityId} className="text-sm text-muted">
                {greeter.card.name} has no greeting.
              </p>
            )
          ) : (
            <Greeting
              key={greeter.card.entityId}
              card={greeter}
              index={picks[at] ?? 0}
              onIndex={(index) => setPicks((current) => current.map((pick, i) => (i === at ? index : pick)))}
              text={expandGreeting(at, picks[at] ?? 0)}
            />
          )
        )}
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 border-t border-border pt-2 pb-2">
        <div className="flex min-w-0 items-end gap-1 rounded-lg border border-border bg-surface p-1 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/40">
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <AutoGrowTextarea
            id="composer"
            value={text}
            // Short, so it fits one line on a phone, as the chat's composer does.
            placeholder="Write a message…"
            aria-describedby={text.trim() !== "" ? "composer-hint" : undefined}
            onKeyDown={(event) => composerKeyDown(() => start("send"))(event)}
            onChange={(event) => {
              const value = event.currentTarget.value
              typed.current = value
              setText(value)
              // While the first send is out, the copy keeps both, as a failed send leaves them.
              const out = sending.current
              void keep(out === null || out === "" ? value : value === "" ? out : `${out}\n\n${value}`)
            }}
          />
          <Tooltip
            label={
              text.trim() !== ""
                ? `${replyName} writes the next turn, with your text as a one-turn direction`
                : `${replyName} writes the next turn`
            }
          >
            <Button
              aria-label={`Generate ${replyName}`}
              disabled={action.pending}
              onClick={() => void start("generate")}
            >
              Generate
            </Button>
          </Tooltip>
          <SquareIconButton
            label={playing ? `Send as ${playing.name}` : "Send"}
            hint={`${playing ? `Send as ${playing.name}` : "Send"} (Enter; Shift+Enter for a new line)`}
            variant="primary"
            pending={action.pending}
            disabled={text.trim() === ""}
            onClick={() => void start("send")}
          >
            {!action.pending && <SendIcon />}
          </SquareIconButton>
        </div>
        {text.trim() !== "" && (
          <p id="composer-hint" className="text-xs text-muted">
            Generate instead makes this text a one-turn direction for {replyName}'s turn.
          </p>
        )}
        <ErrorAlert error={action.error} />
      </div>
    </>
  )
}

/** /cards/$entityId/chat: a new chat with a card, made on its first send. */
export function StartChatPage() {
  const { entityId } = useParams({ strict: false }) as { entityId: EntityId }
  const action = useAction()
  const [loaded, setLoaded] = useState<{ card: CardForChat; personas: ReadonlyArray<CastCard> } | null>(null)
  useTitle(loaded ? loaded.card.card.name : "New chat")
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
          const personas = result.value.cards.filter((c) => c.persona && c.entityId !== entityId)
          setLoaded({ card: result.value.card, personas })
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per card
  }, [entityId])
  return (
    <div data-fill className="flex min-h-0 flex-1 flex-col px-4 pt-4">
      {loaded ? (
        <Pending key={entityId} card={loaded.card} personas={loaded.personas} />
      ) : action.error ? (
        <ErrorAlert error={action.error} />
      ) : (
        <Loading label="Loading the card…" />
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
    cards: ReadonlyArray<CardForChat>
    personas: ReadonlyArray<CastCard>
  } | null>(null)
  useTitle(loaded ? `New chat: ${loaded.group.name}` : "New chat")
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
        setLoaded({ group, cards: greeters, personas: cards.filter((c) => c.persona && !inGroup.has(c.entityId)) })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per group
  }, [chatId])
  return (
    <div data-fill className="flex min-h-0 flex-1 flex-col px-4 pt-4">
      {loaded ? (
        <Pending
          key={chatId}
          card={loaded.cards[0]!}
          personas={loaded.personas}
          group={{ group: loaded.group, chatId, cards: loaded.cards }}
        />
      ) : action.error ? (
        <ErrorAlert error={action.error} />
      ) : (
        <Loading label="Loading the group…" />
      )}
    </div>
  )
}
