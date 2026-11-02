// The chat's Cast tab (DESIGN §2.1, §2.2, §3.5, §4): who you play (the persona, who
// `{{user}}` is), then everyone in the chat, one quiet row each: portrait, name (which opens
// their tab, where the card is edited), Mute (never picked to reply; the card stays in the
// context: PHASE1 "Muting and presence") and Speak now. Everything else is under each row's ⋯:
// write as them, the card's actions (`chatCardActions`, so a plugin's join them), make them the
// persona, remove them. Under them, Add characters (CastAdd.tsx, a `castSections` entry).
// Changes to who's here are state events at the leaf shown, so they apply from the latest
// message on, on this branch.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CastChange, ChatCard } from "@rp/shared/chatSetupApi.ts"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton, iconButtonClass } from "../../ui/Tooltip.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { castView } from "./cast.ts"
import { useShowPanel } from "./panels.tsx"
import { PersonaSwitch } from "./PersonaSwitch.tsx"
import type { ChatSession } from "./session.ts"
import { castSections, ChatCardActions } from "./presentation.tsx"
import { writeAs } from "./speaker.ts"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The row's ⋯: what's used less, each a button in a panel that stays mounted for the dialogs they open. */
function MemberMore({
  session,
  card,
  info,
  onChange,
  onPersona
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  onChange: (change: CastChange) => void
  onPersona: () => void
}) {
  const [open, setOpen] = useState(false)
  const showPanel = useShowPanel()
  const name = card.name
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<Icon name="more" />}
      triggerLabel={`More for ${name}`}
      hint={`More for ${name}`}
      triggerClassName={iconButtonClass()}
      title={name}
      side="bottom"
      align="end"
      keepMounted
    >
      <div
        className="flex flex-col items-stretch gap-0.5 [&_button]:h-auto! [&_button]:min-h-8 [&_button]:w-full [&_button]:justify-start [&_button]:px-2! [&_button]:py-1.5 [&_button]:text-left [&_button]:whitespace-normal"
        onClickCapture={() => setOpen(false)}
      >
        <Button
          variant="ghost"
          hint={`The composer writes as ${name}: what you send is their message.`}
          onClick={() => writeAs(session, card.entityId)}
        >
          Write as {name}
        </Button>
        <Button variant="ghost" hint="Edit their card here." onClick={() => showPanel(`card:${card.entityId}`)}>
          Edit the card here
        </Button>
        <ChatCardActions session={session} card={card} info={info} />
        <Button variant="ghost" hint={`You play ${name} in this chat: {{user}} is them.`} onClick={onPersona}>
          Use as my persona
        </Button>
        <Button
          variant="ghost"
          className="text-danger!"
          hint="They leave the chat. Earlier messages stay."
          onClick={() => onChange({ _tag: "Leave", entityId: card.entityId })}
        >
          Remove from chat
        </Button>
      </div>
    </Popover>
  )
}

function Member({
  session,
  card,
  info,
  version,
  muted,
  writing,
  onChange,
  onPersona,
  onError
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  /** Its version, shown only to tell it from another of the same name. */
  version: string
  muted: boolean
  /** The model is writing their turn at the end of the chat. */
  writing: boolean
  onChange: (change: CastChange) => void
  onPersona: () => void
  onError: (error: AppError | null) => void
}) {
  const [speaking, setSpeaking] = useState(false)
  const showPanel = useShowPanel()
  const name = card.name
  const speak = async () => {
    setSpeaking(true)
    // The composer's Generate for this speaker, without a direction: the model writes their turn.
    const outcome = await session.generate(undefined, card.entityId)
    setSpeaking(false)
    onError(outcome.ok ? null : outcome.error)
  }
  return (
    <li aria-label={name} className="flex items-center gap-3 py-2">
      <span className={muted ? "opacity-50" : ""}>
        <Avatar id={card.entityId} name={name} mediaId={card.avatarMediaId} crop={card.avatarCrop} size="lg" preview />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <button
          type="button"
          title={name}
          aria-label={`${name}: open their card`}
          onClick={() => showPanel(`card:${card.entityId}`)}
          className={`line-clamp-2 max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus ${muted ? "text-muted" : ""}`}
        >
          {name}
        </button>
        {version && <span className="max-w-full truncate text-xs text-muted">{version}</span>}
        {(writing || muted || card.inBin) && (
          <span className="flex flex-wrap items-center gap-1">
            {writing && <Badge tone="success">writing…</Badge>}
            {muted && <Badge tone="warning">Muted</Badge>}
            {card.inBin && <Badge tone="danger">in the bin</Badge>}
          </span>
        )}
      </div>
      {/* Muting stops them being picked to reply (DESIGN §3.5); they can still be made to speak. */}
      <IconButton
        icon={muted ? "muted" : "volume"}
        label={muted ? `Unmute ${name}` : `Mute ${name}`}
        hint={muted ? "Muted: never picked to reply. Unmute" : "Mute: never picked to reply"}
        className={muted ? "text-warning!" : ""}
        onClick={() => onChange({ _tag: "Presence", entityId: card.entityId, present: muted })}
      />
      <IconButton
        icon="play"
        label={`Speak now: ${name}`}
        hint={`${name} speaks now: the model writes their turn`}
        disabled={speaking || writing}
        onClick={() => void speak()}
      />
      <MemberMore session={session} card={card} info={info} onChange={onChange} onPersona={onPersona} />
    </li>
  )
}

/** Who you play: one row, apart from the characters, with no count of the chats it's in. */
function You({ session, card }: { session: ChatSession; card: CastCard | undefined }) {
  const showPanel = useShowPanel()
  return (
    <div role="group" aria-label="Your persona" className="flex max-w-controls items-center gap-3">
      {card && (
        <Avatar
          id={card.entityId}
          name={card.name}
          mediaId={card.avatarMediaId}
          crop={card.avatarCrop}
          size="lg"
          preview
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="text-xs text-muted">You play</span>
        {card ? (
          <button
            type="button"
            title={card.name}
            aria-label={`${card.name}: open your persona`}
            onClick={() => showPanel(`card:${card.entityId}`)}
            className="line-clamp-2 max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {card.name}
          </button>
        ) : (
          <span className="font-medium">No persona</span>
        )}
      </div>
      <PersonaSwitch session={session} trigger="Switch" />
    </div>
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
  // The library entry each card's actions need (the ref to edit or fork); read again at a new
  // leaf, after any library change (an editor save), or a card fork made here.
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
  // The characters: everyone in the chat but who you play (PHASE1 26, 27).
  const characters = participants.filter((id) => !playedByMe.includes(id))
  const muted = cast?.absent.filter((id) => characters.includes(id)).length ?? 0
  const sameName = (card: CastCard) =>
    characters.filter((id) => id !== card.entityId && view.cards.get(id)?.name === card.name).length > 0
  /**
   * Who `{{user}}` is from here on (DESIGN §2.2): one persona, in one write. A card not in the
   * chat joins; a persona-folder card played until now leaves, since it isn't one of the characters.
   */
  const choosePersona = async (card: CastCard) => {
    if (cast === null || (playedByMe.length === 1 && playedByMe[0] === card.entityId)) return
    await change({ _tag: "Persona", entityId: card.entityId })
  }
  const persona = playedByMe[0] ?? null

  if (cast === null) return <p className="text-sm text-muted">Loading who's here…</p>
  return (
    <div className="flex flex-col gap-4">
      <You session={session} card={persona === null ? undefined : view.cards.get(persona)} />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <h2 className="text-sm font-semibold">
            {plural(characters.length, "character", "characters")}
            {muted > 0 && <span className="font-normal text-muted"> · {muted} muted</span>}
          </h2>
        </div>
        {characters.length === 0 ? (
          <p className="py-2 text-sm text-muted">No one is in this chat. Add a character below to start.</p>
        ) : (
          <ul
            aria-label="Characters in this chat"
            className="grid gap-x-6 @3xl:grid-cols-[repeat(auto-fill,minmax(22rem,1fr))]"
          >
            {characters.map((id) => {
              const card = view.cards.get(id)
              if (card === undefined) return null
              return (
                <Member
                  key={id}
                  session={session}
                  card={card}
                  info={info.get(id)}
                  version={sameName(card) ? (card.subtitle ?? "") : ""}
                  muted={cast.absent.includes(id)}
                  writing={writing === id}
                  onChange={(next) => void change(next)}
                  onPersona={() => void choosePersona(card)}
                  onError={setError}
                />
              )
            })}
          </ul>
        )}
      </div>
      {/* Add characters, and what a plugin adds (castSections). */}
      <SlotOutlet slot={castSections} props={{ session }} />
      {AsyncResult.isFailure(infoResult) && (
        <p className="text-sm text-muted">The cards' details couldn't be read; editing them may not work.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </div>
  )
}
