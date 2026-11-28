import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDefaultPersona } from "../characters/defaultPersona.tsx"
import { isPendingChat } from "./chatStarted.ts"
import { CardVersion } from "./CardVersion.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useChatCards } from "./chatCards.ts"
// The chat's Cast tab (DESIGN §2.1, §2.2, §3.5, §4): who you play (the persona, who
// `{{user}}` is), then everyone in the chat, one quiet row each: portrait, name (which opens
// their tab, where the card is edited), Mute (never picked to reply; the card stays in the
// context: PHASE1 "Muting and presence"), Away (not in the scene: not picked to reply, and in
// separate contexts not seeing what's said meanwhile; spec/CHARACTER-CONTEXT.md §2.1, unit CU2;
// a narrator has none) and Speak now. Everything else is under each row's ⋯: write as them, the
// card's actions (`chatCardActions`, so a plugin's join them), Narrator (§6), make them the
// persona, remove them. Under them, Add characters (CastAdd.tsx, a `castSections` entry).
// Changes to who's here are state events at the leaf shown, so they apply from the latest
// message on, on this branch.
import type { CastCard } from "@dreamspan/shared/chat.ts"
import type { CastChange, ChatCard } from "@dreamspan/shared/chatSetupApi.ts"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Menu, MenuCheckboxItem, MenuItem } from "../../ui/Menu.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { castView } from "./cast.ts"
import { useShowPanel } from "./panels.tsx"
import { PendingPersonaSwitch, PersonaSwitch } from "./PersonaSwitch.tsx"
import type { ChatSession } from "./session.ts"
import type { ChatCardInfo } from "./CardForkDialogs.tsx"
import type { PendingChat } from "./pendingChat.ts"
import { usePendingCardInfo } from "./pendingCardInfo.ts"
import { castSections, castMemberNavigation, ChatCardActions, pendingCastSections } from "./presentation.tsx"
import { type ReactNode } from "react"
import { writeAs } from "./speaker.ts"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The row's ⋯: registered menu actions, kept mounted for the dialogs they open. */
function MemberMore({
  session,
  card,
  info,
  onChange,
  onPersona,
  persona = false,
  narrator = false
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  onChange: (change: CastChange) => void
  onPersona: () => void
  persona?: boolean
  /** Their role in this chat is the narrator (`cast.role`). */
  narrator?: boolean
}) {
  const showPanel = useShowPanel()
  const name = card.name
  return (
    <Menu trigger={<IconButton icon="more" label={`More for ${name}`} />} label={name} keepMounted>
      <MenuItem
        description={`The composer writes as ${name}: what you send is their message.`}
        onClick={() => writeAs(session, card.entityId)}
      >
        Write as {name}
      </MenuItem>
      <SlotOutlet slot={castMemberNavigation} props={{ session, card }} />
      <MenuItem description="Edit their card here." onClick={() => showPanel(`card:${card.entityId}`)}>
        Edit the card here
      </MenuItem>
      <ChatCardActions session={session} card={card} info={info} persona={persona} surface="cast" />
      {!persona && (
        <>
          <MenuCheckboxItem
            checked={narrator}
            description={
              narrator
                ? `${name} becomes a character again, in and out of the scene like the others.`
                : `${name} sees everything and is never in or out of the scene. With separate contexts, their replies see the whole chat, whoever was there.`
            }
            onCheckedChange={(on) => onChange({ _tag: "Role", entityId: card.entityId, role: on ? "narrator" : null })}
          >
            Narrator
          </MenuCheckboxItem>
          <MenuItem description={`You play ${name} in this chat: {{user}} is them.`} onClick={onPersona}>
            Use as my persona
          </MenuItem>
          <MenuItem
            tone="danger"
            description="They leave the chat. Earlier messages stay."
            onClick={() => onChange({ _tag: "Leave", entityId: card.entityId })}
          >
            Remove from chat
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

function Member({
  session,
  card,
  info,
  muted,
  away,
  narrator,
  writing,
  onChange,
  onPersona,
  onError
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  muted: boolean
  /** Not in the scene (`away.set`); never for a narrator. */
  away: boolean
  narrator: boolean
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
      <span className={muted || away ? "opacity-50" : ""}>
        <Avatar id={card.entityId} name={name} mediaId={card.avatarMediaId} crop={card.avatarCrop} size="lg" preview />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <Tooltip label="Opens this character’s card in the panel.">
          <button
            type="button"
            title={name}
            aria-label={`${name}: open their card`}
            onClick={() => showPanel(`card:${card.entityId}`)}
            className={`line-clamp-2 max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus ${muted || away ? "text-muted" : ""}`}
          >
            {name}
          </button>
        </Tooltip>
        <CardVersion card={card} />
        {(writing || muted || away || narrator || card.inBin) && (
          <span className="flex flex-wrap items-center gap-1">
            {writing && <Badge tone="success">writing…</Badge>}
            {narrator && <Badge tone="accent">Narrator</Badge>}
            {away && <Badge tone="warning">Away</Badge>}
            {muted && <Badge tone="warning">Muted</Badge>}
            {card.inBin && <Badge tone="danger">in the bin</Badge>}
          </span>
        )}
      </div>
      {/* Muting stops them being picked to reply (DESIGN §3.5); they can still be made to speak. */}
      <IconButton
        icon={muted ? "muted" : "volume"}
        label={muted ? `Unmute ${name}` : `Mute ${name}`}
        hint={
          muted
            ? "Click to allow this character to be picked to reply"
            : "Click to mute this character: never picked to reply"
        }
        className={muted ? "text-warning!" : ""}
        onClick={() => onChange({ _tag: "Presence", entityId: card.entityId, present: muted })}
      />
      {/* Away (spec/CHARACTER-CONTEXT.md §2.1): not in the scene, apart from Mute. A narrator is never away. */}
      {!narrator && (
        <IconButton
          icon={away ? "user-x" : "user"}
          label={away ? `Mark ${name} back` : `Mark ${name} away`}
          hint={
            away
              ? `Click when ${name} is back in the scene, from the latest message on: picked to reply again, and with separate contexts seeing what's said from here. The scene check can also mark ${name} back.`
              : `Click when ${name} leaves the scene, from the latest message on: not picked to reply, and with separate contexts ${name}'s replies leave out what's said meanwhile. Unlike Mute, which only stops replies, Away says ${name} isn't in the scene: the scene check can set or clear it too.`
          }
          className={away ? "text-warning!" : ""}
          onClick={() => onChange({ _tag: "Away", entityId: card.entityId, away: !away })}
        />
      )}
      <IconButton
        icon="play"
        label={`Speak now: ${name}`}
        hint={`${name} speaks now: the model writes their turn`}
        disabled={speaking || writing}
        onClick={() => void speak()}
      />
      <MemberMore
        session={session}
        card={card}
        info={info}
        onChange={onChange}
        onPersona={onPersona}
        narrator={narrator}
      />
    </li>
  )
}

/** Who you play: one row, apart from the characters, with no count of the chats it's in. */
function You({
  card,
  children,
  isDefault = false
}: {
  card: CastCard | undefined
  children: ReactNode
  isDefault?: boolean
}) {
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
        {card ? <PersonaBadge played /> : <span className="text-xs text-muted">You play</span>}
        {card ? (
          <Tooltip label="Opens your persona’s card in the panel.">
            <button
              type="button"
              title={card.name}
              aria-label={`${card.name}: open your persona`}
              onClick={() => showPanel(`card:${card.entityId}`)}
              className="line-clamp-2 max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            >
              {card.name}
              {isDefault ? " (default)" : ""}
            </button>
          </Tooltip>
        ) : (
          <span className="font-medium">No persona</span>
        )}
        {card && <CardVersion card={card} />}
      </div>
      {children}
    </div>
  )
}

/** The `castSections` entries Cast lays out in its reply settings row, in this order. */
const REPLY_SETTINGS = ["cast.reply-order", "cast.one-reply", "cast.auto-replies"]

/**
 * Cast's reply settings row (owner, 2026-11-03): Who replies, One reply at a time and Auto
 * replies side by side, wrapping below when they don't fit. Cast owns the row and mounts each
 * entry itself, so a plugin can replace or remove any of them and the others stay. Each entry
 * is a flex item here (an error takes a line of its own with `order-last basis-full`); with none
 * shown, the row is hidden.
 */
function ReplySettingsRow({ session }: { session: ChatSession }) {
  return (
    <section
      aria-label="Who replies"
      className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-border pt-3 empty:hidden"
    >
      {REPLY_SETTINGS.map((id) => (
        <SlotOutlet key={id} slot={castSections} only={id} props={{ session }} />
      ))}
    </section>
  )
}

export function CastTab({ session }: { session: ChatSession }) {
  // Only the cast: the tab doesn't re-render as messages arrive.
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const chat = useSyncExternalStore(session.subscribe, () => session.snapshot().chat)
  const defaultPersona = useDefaultPersona()
  const view = useMemo(() => castView(cast), [cast])
  // Who the model is writing as at the end of the chat, if anyone (after Speak now, say): no one
  // yet while the decision model is choosing who replies.
  const writing = useSyncExternalStore(session.subscribe, () => {
    const { entries, newer } = session.snapshot()
    const last = newer === null ? entries.at(-1) : undefined
    return last?.version.status === "generating" && last.version.speakerPick?.by !== "auto"
      ? last.version.speakerEntityId
      : null
  })
  const participants = useMemo(() => cast?.participants ?? [], [cast])
  const infoResult = useChatCards(session)
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
  // Who is away (`Cast.away`: narrators are never away), as the row and the header count show it.
  const awayIds = cast?.away ?? []
  const away = awayIds.filter((id) => characters.includes(id)).length
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
      <You
        card={persona === null ? undefined : view.cards.get(persona)}
        isDefault={isPendingChat(chat) && persona !== null && persona === defaultPersona}
      >
        <PersonaSwitch session={session} trigger="Switch" place="cast" />
        {persona !== null && view.cards.has(persona) && (
          <MemberMore
            session={session}
            card={view.cards.get(persona)!}
            info={info.get(persona)}
            onChange={change}
            onPersona={() => void choosePersona(view.cards.get(persona)!)}
            persona
          />
        )}
      </You>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <h2 className="text-sm font-semibold">
            {plural(characters.length, "character", "characters")}
            {muted > 0 && <span className="font-normal text-muted"> · {muted} muted</span>}
            {away > 0 && <span className="font-normal text-muted"> · {away} away</span>}
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
                  muted={cast.absent.includes(id)}
                  away={awayIds.includes(id)}
                  narrator={cast.roles?.[id] === "narrator"}
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
      <SlotOutlet
        slot={castSections}
        except={REPLY_SETTINGS}
        props={{ session }}
        insert={{ order: 5, element: <ReplySettingsRow session={session} /> }}
      />
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

/** A pending chat's character row: the same row, with what applies before the first send. */
function PendingMember({
  card,
  info,
  removable,
  onRemove
}: {
  card: CastCard
  info: ChatCardInfo | undefined
  /** Whether they can be left out: the chat keeps one character at least. */
  removable: boolean
  onRemove: () => void
}) {
  const showPanel = useShowPanel()
  const name = card.name
  return (
    <li aria-label={name} className="flex items-center gap-3 py-2">
      <Avatar id={card.entityId} name={name} mediaId={card.avatarMediaId} crop={card.avatarCrop} size="lg" preview />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <Tooltip label="Opens this character’s card in the panel.">
          <button
            type="button"
            title={name}
            aria-label={`${name}: open their card`}
            onClick={() => showPanel(`card:${card.entityId}`)}
            className="line-clamp-2 max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {name}
          </button>
        </Tooltip>
        <CardVersion card={card} />
      </div>
      <Menu trigger={<IconButton icon="more" label={`More for ${name}`} />} label={name} keepMounted>
        <MenuItem
          description="Opens their card's fields in this panel."
          onClick={() => showPanel(`card:${card.entityId}`)}
        >
          Edit the card here
        </MenuItem>
        <ChatCardActions session={null} card={card} info={info} />
        {removable && (
          <MenuItem
            tone="danger"
            description="Leaves them out of the new chat, with their greeting."
            onClick={onRemove}
          >
            Remove from chat
          </MenuItem>
        )}
      </Menu>
    </li>
  )
}

/**
 * The Cast tab of a chat not made yet: the same tab, changing the pending chat (pendingChat.ts)
 * rather than writing anything. Who you play, the characters (each can be left out but the
 * last), then its sections (`pendingCastSections`: who answers first, Add characters).
 */
export function PendingCastTab({ pending }: { pending: PendingChat }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const infoOf = usePendingCardInfo()
  const playing = pending.playing(state)
  const defaultPersona = useDefaultPersona()
  const characters = state.greeters.map((item) => item.card).filter((card) => card.entityId !== state.persona)
  return (
    <div className="flex flex-col gap-4">
      <You card={playing ?? undefined} isDefault={playing !== null && playing.entityId === defaultPersona}>
        <PendingPersonaSwitch pending={pending} trigger="Switch" />
      </You>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <h2 className="text-sm font-semibold">{plural(characters.length, "character", "characters")}</h2>
        </div>
        {characters.length === 0 ? (
          <p className="py-2 text-sm text-muted">No one is in this chat. Add a character below to start.</p>
        ) : (
          <ul
            aria-label="Characters in this chat"
            className="grid gap-x-6 @3xl:grid-cols-[repeat(auto-fill,minmax(22rem,1fr))]"
          >
            {characters.map((card) => (
              <PendingMember
                key={card.entityId}
                card={card}
                info={infoOf(card.entityId)}
                removable={characters.length > 1}
                onRemove={() => pending.remove(card.entityId)}
              />
            ))}
          </ul>
        )}
      </div>
      <SlotOutlet slot={pendingCastSections} props={{ pending }} />
      <p className="text-xs text-muted">The chat starts with this cast when you send the first message.</p>
    </div>
  )
}
