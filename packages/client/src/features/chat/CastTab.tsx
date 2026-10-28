// The chat's Cast tab (DESIGN §2.1, §2.2, §3.5, §4): who the user plays (the persona, who
// `{{user}}` is), then everyone in the chat, as ST's group panel and character panel show
// them. Each can be made to speak now, written as, muted (never picked to reply; its card
// stays in the context), have their card shown, edited or forked, be made
// the persona, and be removed; and any card can be added. Changes to who's here are state
// events at the leaf shown, so they apply from the latest message on, on this branch.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CastChange, ChatCard } from "@rp/shared/chatSetupApi.ts"
import { AsyncResult } from "effect/reactivity"
import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { ActionMenu } from "../../ui/Menu.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useOpenCharacter } from "../characters/shellData.tsx"
import { castView, CastContext } from "./cast.ts"
import { MoreIcon, PlusIcon } from "./icons.tsx"
import type { ChatSession } from "./session.ts"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { ChatCardActions } from "./CardForkDialogs.tsx"
import { writeAs } from "./speaker.ts"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Longer than this, a field shows its start and "Show more". */
const LONG = 320

function DefinitionField({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const long = text.length > LONG || text.split("\n").length > 6
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd
        id={id}
        className={`text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${long && !open ? "line-clamp-6" : ""}`}
      >
        {text}
      </dd>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="self-start text-xs text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

/** Which version a chat reads, in words, when it isn't simply the library's latest. */
const versionNote = (info: ChatCard) =>
  info.binding === "revision"
    ? "This chat uses an earlier saved version of the card here, not the library's latest."
    : null

/** The card's definition as this chat uses it, read-only (ST's character panel). */
function Definition({ name, info }: { name: string; info: ChatCard }) {
  const { definition } = info
  const note = versionNote(info)
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Description", definition.description],
    ["Personality", definition.personality],
    ["Scenario", definition.scenario],
    ["First message", definition.firstMessage],
    ["Example dialogue", definition.exampleDialogue],
    ["Creator's notes", definition.creatorNotes]
  ]
  const shown = fields.filter(([, text]) => text.trim() !== "")
  const empty = fields.filter(([, text]) => text.trim() === "").map(([label]) => label.toLowerCase())
  return (
    <section
      aria-label={`${name}'s card`}
      className="flex flex-col gap-3 rounded-md border border-border bg-canvas p-3"
    >
      {note && <p className="text-xs text-muted">{note}</p>}
      {shown.length > 0 && (
        <dl className="flex flex-col gap-3">
          {shown.map(([label, text]) => (
            <DefinitionField key={label} label={label} text={text} />
          ))}
        </dl>
      )}
      <p className="text-xs text-muted">
        {[
          definition.alternateGreetings > 0
            ? `${plural(definition.alternateGreetings, "alternate greeting", "alternate greetings")}.`
            : "",
          empty.length > 0 ? `Empty: ${empty.join(", ")}.` : ""
        ]
          .filter((part) => part !== "")
          .join(" ")}
      </p>
    </section>
  )
}

/** A searchable list of the user's cards not in the chat; the one picked joins it (DESIGN §2.1). */
function AddCharacter({
  session,
  participants,
  onJoin
}: {
  session: ChatSession
  participants: ReadonlyArray<EntityId>
  onJoin: (card: CastCard) => void
}) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<ReadonlyArray<CastCard> | null>(null)
  const [query, setQuery] = useState("")
  const openChange = (next: boolean) => {
    setOpen(next)
    if (!next) return setQuery("")
    void session.listCards().then((result) => setAll(result.ok ? result.value : []))
  }
  const needle = query.trim().toLowerCase()
  const addable = (all ?? []).filter(
    (card) =>
      !participants.includes(card.entityId) &&
      (needle === "" ||
        card.name.toLowerCase().includes(needle) ||
        (card.subtitle ?? "").toLowerCase().includes(needle))
  )
  return (
    <Popover
      open={open}
      onOpenChange={openChange}
      triggerLabel="Add character"
      title="Add a character to this chat"
      side="bottom"
      align="end"
      trigger={
        <>
          <PlusIcon />
          Add character
        </>
      }
    >
      <Input
        type="search"
        aria-label="Search your cards"
        placeholder="Search your cards"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {all === null ? (
        <p className="px-1 py-2 text-sm text-muted">Loading…</p>
      ) : addable.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted">
          {needle === "" ? "Every card you have is in this chat." : "No card matches."}
        </p>
      ) : (
        <ul aria-label="Cards to add" className="flex min-h-0 flex-col overflow-y-auto">
          {addable.map((card) => (
            <li key={card.entityId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setQuery("")
                  onJoin(card)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Avatar id={card.entityId} name={card.name} mediaId={card.avatarMediaId} size="md" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{card.name}</span>
                  {card.subtitle && <span className="truncate text-xs text-muted">{card.subtitle}</span>}
                </span>
                {card.persona && <Badge>persona</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

function Member({
  session,
  card,
  info,
  muted,
  played,
  writing,
  onChange,
  onPersona,
  onError
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  muted: boolean
  played: boolean
  /** The model is writing their turn at the end of the chat. */
  writing: boolean
  onChange: (change: CastChange) => void
  onPersona: () => void
  onError: (error: AppError | null) => void
}) {
  const [showCard, setShowCard] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const name = card.name
  const openCharacter = useOpenCharacter()
  const speak = async () => {
    setSpeaking(true)
    // The composer's Generate for this speaker, without a direction: the model writes their turn.
    const outcome = await session.generate(undefined, card.entityId)
    setSpeaking(false)
    onError(outcome.ok ? null : outcome.error)
  }
  const small = "h-8! px-2!"
  return (
    <li aria-label={name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className={`flex items-start gap-3 ${muted ? "opacity-60" : ""}`}>
        <Avatar id={card.entityId} name={name} mediaId={card.avatarMediaId} size="lg" preview />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            onClick={() => openCharacter(card.entityId)}
            className="truncate text-left font-medium text-accent"
          >
            {name}
          </button>
          {card.subtitle && <span className="truncate text-xs text-muted">{card.subtitle}</span>}
          {info && <span className="text-xs text-muted">used by {plural(info.usedByChats, "chat", "chats")}</span>}
          <span className="flex flex-wrap items-center gap-1">
            {played && <Badge tone="accent">your persona</Badge>}
            {writing && <Badge tone="success">writing…</Badge>}
            {muted && !played && <Badge tone="warning">muted</Badge>}
            {card.inBin && <Badge tone="danger">in the bin</Badge>}
          </span>
        </div>
        {/* Muting stops them being picked to reply (DESIGN §3.5); they can still be made to speak. */}
        {/* Not on the card you play: the model never writes it, so muting means nothing. */}
        {!played && (
          <Switch
            checked={muted}
            onCheckedChange={(next) => onChange({ _tag: "Presence", entityId: card.entityId, present: !next })}
          >
            <span className="sr-only">{name} is </span>Muted
          </Switch>
        )}
        <span className="-mt-1 -mr-2">
          <ActionMenu
            label={`More for ${name}`}
            trigger={<MoreIcon />}
            items={[
              ...(played ? [] : [{ label: "Use as my persona", onSelect: onPersona }]),
              {
                label: "Remove from chat",
                tone: "danger",
                onSelect: () => onChange({ _tag: "Leave", entityId: card.entityId })
              }
            ]}
          />
        </span>
      </div>
      <div className="-ml-2 flex flex-wrap items-center gap-0.5">
        <Tooltip label={`The model writes ${name}'s turn now`}>
          <Button
            variant="ghost"
            className={small}
            aria-label={`Speak now: ${name}`}
            pending={speaking}
            onClick={() => void speak()}
          >
            Speak now
          </Button>
        </Tooltip>
        <Tooltip label={`Your next message is sent as ${name}`}>
          <Button
            variant="ghost"
            className={small}
            aria-label={`Write as ${name}`}
            onClick={() => writeAs(session, card.entityId)}
          >
            Write as
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          className={small}
          aria-label={`${showCard ? "Hide" : "Show"} card: ${name}`}
          aria-expanded={showCard}
          onClick={() => setShowCard(!showCard)}
        >
          {showCard ? "Hide card" : "Show card"}
        </Button>
        <ChatCardActions session={session} card={card} info={info} />
      </div>
      {showCard &&
        (info ? <Definition name={name} info={info} /> : <p className="text-sm text-muted">Loading the card…</p>)}
    </li>
  )
}

export function CastTab({ session }: { session: ChatSession }) {
  // Only the cast: the tab doesn't re-render as messages arrive.
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const view = useMemo(() => castView(cast), [cast])
  // Who the model is writing as at the end of the chat, if anyone (after Speak now, say).
  const writing = useSyncExternalStore(session.subscribe, () => {
    const { entries, newer } = session.snapshot()
    const last = newer === null ? entries.at(-1) : undefined
    return last?.version.status === "generating" ? last.version.speakerEntityId : null
  })
  const participants = useMemo(() => cast?.participants ?? [], [cast])
  const chatId = session.id
  // The leaf shown: what the next request reads depends on the state there.
  const leafSlotId = useSyncExternalStore(session.subscribe, () => session.snapshot().leafSlotId)
  const forkId = useSyncExternalStore(session.subscribe, () => session.snapshot().forkId)
  // Cards in the bin, or purged, have no definition to read.
  const key = participants.filter((id) => view.cards.get(id)?.inBin === false).join(" ")
  // The library entry, "used by N chats", and the definition the
  // next request reads; read again at a new leaf, after any library change (an editor
  // save), or a card fork made here.
  const infoAtom = useMemo(
    () =>
      AppClient.query(
        "ListChatCards",
        {
          chatId,
          forkId,
          slotId: leafSlotId,
          entityIds: key === "" ? [] : (key.split(" ") as Array<EntityId>)
        },
        { reactivityKeys: ["library", `chat-cards:${chatId}`] }
      ),
    [chatId, leafSlotId, forkId, key]
  )
  const infoResult = useAtomValue(infoAtom)
  const info = useMemo(
    () =>
      new Map(AsyncResult.isSuccess(infoResult) ? infoResult.value.map((card) => [card.entityId as string, card]) : []),
    [infoResult]
  )
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const playedByMe = cast?.playedByMe ?? []
  const muted = cast?.absent.filter((id) => participants.includes(id) && !playedByMe.includes(id)).length ?? 0
  /**
   * Who `{{user}}` is from here on (DESIGN §2.2): one persona, in one write. A card not in the
   * chat joins; a persona-folder card played until now leaves, since it isn't one of the characters.
   */
  const choosePersona = async (card: CastCard) => {
    if (cast === null || (playedByMe.length === 1 && playedByMe[0] === card.entityId)) return
    await change({ _tag: "Persona", entityId: card.entityId })
  }
  const listCards = useCallback(() => session.listCards(), [session])
  const persona = playedByMe[0] ?? null

  if (cast === null) return <p className="text-sm text-muted">Loading who's here…</p>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">Changes here apply from the latest message on, on this branch.</p>
      {/* Who you are ({{user}}): set here, not by who you write as (DESIGN §2.2). */}
      <div className="flex flex-wrap items-center gap-2" aria-label="Your persona" role="group">
        <span className="text-sm font-medium">You:</span>
        <CastContext value={view}>
          <SpeakerSwitcher
            listCards={listCards}
            speaker={persona}
            recent={[]}
            persona
            onPick={(card) => void choosePersona(card)}
          />
        </CastContext>
        <span className="text-xs text-muted">{"{{user}}"} in prompts. Writing as someone else doesn't change it.</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {plural(
            participants.length - playedByMe.filter((id) => participants.includes(id)).length,
            "character",
            "characters"
          )}
          {muted > 0 && <span className="font-normal text-muted"> · {muted} muted</span>}
        </h2>
        <AddCharacter
          session={session}
          participants={participants}
          onJoin={(card) => void change({ _tag: "Join", entityId: card.entityId })}
        />
      </div>
      {participants.length === 0 ? (
        <p className="text-sm text-muted">No one is in this chat. Add a character to start.</p>
      ) : (
        <ul aria-label="Characters in this chat" className="flex flex-col divide-y divide-border">
          {participants.map((id) => {
            const card = view.cards.get(id)
            if (card === undefined) return null
            return (
              <Member
                key={id}
                session={session}
                card={card}
                info={info.get(id)}
                muted={cast.absent.includes(id)}
                played={playedByMe.includes(id)}
                writing={writing === id}
                onChange={(next) => void change(next)}
                onPersona={() => void choosePersona(card)}
                onError={setError}
              />
            )
          })}
        </ul>
      )}
      {AsyncResult.isFailure(infoResult) && (
        <p className="text-sm text-muted">
          The cards' details couldn't be read; showing and editing them may not work.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </div>
  )
}
