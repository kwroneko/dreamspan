// A chat that doesn't exist yet (DESIGN §2.1): a card's greeting, with its alternates to
// pick from and `{{user}}` following the persona picked, and a composer. Nothing is saved
// until the first send, so opening cards never leaves greeting-only chats behind. What's
// typed is kept in this browser (editor/backup.ts) until that send makes the chat, whose
// own composer draft takes over: leaving and coming back finds it (DESIGN §6.2).
//
// A new chat of a group (`/groups/$chatId/new`) is the same, with the group's characters:
// its first character greets, as the first of ST's group greetings (ST adds each member's
// greeting in turn; one keeps the start short), the reply comes from the character picked,
// and the chat is titled with the group's name, so it's one of the group's chats.
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

/** A group the new chat is of: its name, its characters, and the chat that names it. */
interface PendingGroup {
  readonly group: ChatGroup
  readonly chatId: ChatId
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
  const [greeting, setGreeting] = useState(0)
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
  const shown = card.greetings[greeting]
  const name = card.card.name
  /** What the chat is with: the card, or the group. */
  const title = group?.group.name ?? name
  const replyId = (members === null ? entityId : replier) as EntityId
  const replyName = members?.find((member) => member.entityId === replyId)?.name ?? name
  const fields = { description: card.description, personality: card.personality, scenario: card.scenario }
  // What each greeting's random and time macros drew when first shown: the chat keeps them,
  // so a greeting reads the same after the send as before it (DESIGN §5.6).
  const [frozen] = useState(() => new Map<number, FrozenValues>())
  const expandGreeting = (index: number) => {
    const result = expandForDisplay(
      card.greetings[index]!,
      "template",
      { user: playing?.name ?? "User", char: name },
      fields,
      frozen.get(index) ?? {}
    )
    frozen.set(index, result.frozen)
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
    const shownFrozen = card.greetings.length > 0 ? frozen.get(greeting) : undefined
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const started = yield* client("StartChat", {
            // The greeting card leads; a group's chat has all its characters, under its name.
            cards: members === null ? [entityId] : members.map((member) => member.entityId),
            ...(group === null ? {} : { title: group.group.name }),
            persona: personaId,
            greeting: card.greetings.length > 0 ? greeting : null,
            // The picked greeting as it was shown; the server freezes the rest itself.
            ...(shownFrozen === undefined ? {} : { frozen: shownFrozen }),
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
          {members !== null && (
            <p className="text-sm text-muted [overflow-wrap:anywhere]">
              With {members.map((member) => member.name).join(", ")}. Saved when you send the first message.
            </p>
          )}
        </div>
        {/* A group's chat picks who replies too: both fields on a row of their own. */}
        <div className={`flex gap-3 ${members === null ? "w-full sm:w-56" : "w-full"}`}>
          <Field label="Playing as" className={members === null ? "w-full" : "flex-1 sm:w-56 sm:flex-none"}>
            <Select
              items={[
                ...personas.map((p) => ({ value: p.entityId as string, label: p.name })),
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
                items={members.map((member) => ({ value: member.entityId as string, label: member.name }))}
                value={replyId}
                onValueChange={setReplier}
              />
            </Field>
          )}
        </div>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 overflow-y-auto py-2">
        {shown === undefined ? (
          <p className="text-sm text-muted">{name} has no greeting. Your first message starts the chat.</p>
        ) : (
          <article
            aria-label="Greeting"
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3"
          >
            <header className="flex items-center gap-2 text-sm">
              <span className="font-medium">{name}</span>
              {members !== null && <span className="text-muted"> greets first</span>}
              {card.greetings.length > 1 && (
                <div className="ml-auto flex items-center gap-1" role="group" aria-label="Greetings">
                  <Button
                    variant="ghost"
                    aria-label="Previous greeting"
                    disabled={greeting === 0}
                    onClick={() => setGreeting(greeting - 1)}
                  >
                    ‹
                  </Button>
                  <span className="min-w-12 text-center text-muted tabular-nums">
                    {greeting + 1} / {card.greetings.length}
                  </span>
                  <Button
                    variant="ghost"
                    aria-label="Next greeting"
                    disabled={greeting === card.greetings.length - 1}
                    onClick={() => setGreeting(greeting + 1)}
                  >
                    ›
                  </Button>
                </div>
              )}
            </header>
            <Markdown text={expandGreeting(greeting)} streaming={false} />
          </article>
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
    <div data-fill className="flex min-h-0 flex-1 flex-col">
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
    card: CardForChat
    personas: ReadonlyArray<CastCard>
  } | null>(null)
  useTitle(loaded ? `New chat: ${loaded.group.name}` : "New chat")
  useEffect(() => {
    void action
      .run((client) =>
        Effect.gen(function* () {
          const { group } = yield* client("ListGroupChats", { chatId })
          const { card, cards } = yield* Effect.all(
            {
              card: client("GetCardForChat", { entityId: group.members[0]!.entityId }),
              cards: client("ListCards", undefined)
            },
            { concurrency: "unbounded" }
          )
          return { group, card, cards }
        })
      )
      .then((result) => {
        if (!result.ok) return
        const { group, card, cards } = result.value
        const inGroup = new Set<string>(group.members.map((member) => member.entityId))
        setLoaded({ group, card, personas: cards.filter((c) => c.persona && !inGroup.has(c.entityId)) })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per group
  }, [chatId])
  return (
    <div data-fill className="flex min-h-0 flex-1 flex-col">
      {loaded ? (
        <Pending key={chatId} card={loaded.card} personas={loaded.personas} group={{ group: loaded.group, chatId }} />
      ) : action.error ? (
        <ErrorAlert error={action.error} />
      ) : (
        <Loading label="Loading the group…" />
      )}
    </div>
  )
}
