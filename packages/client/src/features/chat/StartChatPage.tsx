// A chat that doesn't exist yet (DESIGN §2.1): a card's greeting, with its alternates to
// pick from and `{{user}}` following the persona picked, and a composer. Nothing is saved
// until the first send, so opening cards never leaves greeting-only chats behind. What's
// typed is kept in this browser (editor/backup.ts) until that send makes the chat, whose
// own composer draft takes over: leaving and coming back finds it (DESIGN §6.2).
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CardForChat } from "@rp/shared/chatSetupApi.ts"
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import { useNavigate, useParams } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field } from "../../ui/Field.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Select } from "../../ui/Select.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useSession } from "../../session.ts"
import { copiesOf, type Copy, dropCopy, keepCopy, makeCopy, pendingChatCopy } from "../editor/backup.ts"
import { useTitle } from "../shell.tsx"
import { carryComposerText } from "./composerCarry.ts"
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

function Pending({ card, personas }: { card: CardForChat; personas: ReadonlyArray<CastCard> }) {
  const action = useAction()
  const navigate = useNavigate()
  const [persona, setPersona] = useState<string>(() => {
    const saved = savedPersona()
    return personas.find((p) => p.entityId === saved)?.entityId ?? personas[0]?.entityId ?? NONE
  })
  const [greeting, setGreeting] = useState(0)
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
  const copy = useRef<Copy | null>(null)
  const sending = useRef<string | null>(null)
  const keep = (content: string) => {
    const previous = copy.current
    copy.current = null
    if (content.trim() === "") {
      if (previous !== null) void dropCopy(previous)
      return
    }
    copy.current = makeCopy(
      userId,
      pendingChatCopy(entityId),
      "first message",
      { kind: "pendingChat", payload: { entityId, name: card.card.name, content } },
      Date.now()
    )
    void keepCopy(copy.current, previous)
  }
  // The text left here before, if nothing's been typed since; the newest of them, when
  // several tabs left one (the others stay in Browser recovery).
  useEffect(() => {
    let current = true
    void copiesOf(userId, pendingChatCopy(entityId)).then((copies) => {
      const newest = [...copies].sort((a, b) => b.at - a.at)[0]
      if (!current || newest === undefined || copy.current !== null || typed.current !== "") return
      copy.current = newest
      typed.current = newest.content
      setTextState(newest.content)
    })
    return () => {
      current = false
    }
  }, [userId, entityId])
  const playing = personas.find((p) => p.entityId === persona) ?? null
  const shown = card.greetings[greeting]
  const name = card.card.name
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
    if (action.pending) return
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
            cards: [card.card.entityId],
            persona: personaId,
            greeting: card.greetings.length > 0 ? greeting : null,
            // The picked greeting as it was shown; the server freezes the rest itself.
            ...(shownFrozen === undefined ? {} : { frozen: shownFrozen }),
            first:
              first === "send"
                ? { _tag: "Send", content: submitted, speakerEntityId: personaId }
                : { _tag: "Generate", speakerEntityId: card.card.entityId, direction: submitted }
          })
          // A message gets its reply, as after any send; a server without a generator still keeps the message.
          if (first === "send") {
            yield* Effect.ignore(
              client("Generate", {
                chatId: started.chat.id,
                parentSlotId: started.entry.slotId,
                branch: false,
                speakerEntityId: card.card.entityId
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
        keep(restored)
      }
      return
    }
    // The chat has the message now; what was typed since goes on in its composer.
    if (copy.current !== null) void dropCopy(copy.current)
    copy.current = null
    carryComposerText(result.value.chat.id, typed.current)
    void navigate({ to: "/chats/$chatId", params: { chatId: result.value.chat.id } })
  }

  return (
    <>
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3 pb-2">
        <Avatar id={card.card.entityId} name={name} mediaId={card.card.avatarMediaId} />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{name}</h1>
        <Field label="Playing as" className="w-56">
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 border-t border-border pt-3 pb-3">
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          rows={3}
          value={text}
          placeholder={`Write to ${name}…`}
          onChange={(event) => {
            const value = event.currentTarget.value
            typed.current = value
            setText(value)
            // While the first send is out, the copy keeps both, as a failed send leaves them.
            const out = sending.current
            keep(out === null || out === "" ? value : value === "" ? out : `${out}\n\n${value}`)
          }}
          className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-base text-text outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 sm:text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            pending={action.pending}
            disabled={text.trim() === ""}
            onClick={() => void start("send")}
          >
            {playing ? `Send as ${playing.name}` : "Send"}
          </Button>
          <Button disabled={action.pending} onClick={() => void start("generate")}>
            Generate {name}
          </Button>
        </div>
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
