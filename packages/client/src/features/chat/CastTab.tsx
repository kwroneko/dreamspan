// The chat's Cast tab (DESIGN §2.1, §2.2, §3.5, §4): everyone in the chat, as ST's group panel
// and character panel show them. Each can be made to speak now, written as, set absent
// (ST's mute), have their card shown or edited, here only or everywhere, and be removed;
// and any card can be added. Changes to who's here are state events at the leaf shown, so
// they apply from the latest message on, on this branch.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CastChange, ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useId, useMemo, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Input } from "../../ui/Field.tsx"
import { ActionMenu } from "../../ui/Menu.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useOpenCharacter } from "../characters/shellData.tsx"
import { castView } from "./cast.ts"
import { MoreIcon, PlusIcon } from "./icons.tsx"
import type { ChatSession } from "./session.ts"
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
  info.usesOverride
    ? "This chat's own version of the card."
    : info.binding === "revision"
      ? "This chat uses an earlier saved version of the card here, not the library's latest."
      : info.binding === "ref"
        ? "This chat uses another version of the card here (a variant), not the library entry."
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

/** "Only in this chat" or "Everywhere" (DESIGN §4), with how many chats the card is in. */
function EditScope({
  session,
  card,
  info,
  onClose
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  onClose: () => void
}) {
  const navigate = useNavigate()
  const action = useAction()
  const open = (refId: RefId) => void navigate({ to: "/library/$refId", params: { refId } })
  // Where the chat reads another version (a variant or an earlier one), its own version
  // starts from that one and is used instead, from the latest message on.
  const pinned = info !== undefined && info.binding !== "default" && !info.usesOverride
  const here = async () => {
    if (info?.usesOverride && info.overrideRefId) return open(info.overrideRefId)
    const made = await action.run(
      (client) =>
        client("EditCardForChat", {
          chatId: session.id,
          slotId: session.snapshot().leafSlotId,
          entityId: card.entityId
        }),
      [`chat-cards:${session.id}`]
    )
    if (made.ok) open(made.value.ref.id)
  }
  const option =
    "flex w-full flex-col items-start gap-0.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
  const chats = info ? plural(info.usedByChats, "chat", "chats") : null
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Edit ${card.name}`}
      description="Where should the change apply?"
    >
      <div className="flex flex-col gap-2">
        <button type="button" className={option} disabled={action.pending || !info} onClick={() => void here()}>
          <span className="font-medium">Only in this chat</span>
          <span className="text-sm text-muted">
            {pinned
              ? info.overrideRefId
                ? "This chat uses another version of the card here. Its own version, edited before, is used instead from the latest message on."
                : "This chat uses another version of the card here. Makes this chat's own version from that one, used from the latest message on. Other chats keep theirs."
              : info?.overrideRefId
                ? "Opens this chat's own version of the card, edited before."
                : "Makes a version of the card for this chat. Other chats keep the original."}
          </span>
        </button>
        <button
          type="button"
          className={option}
          disabled={!info}
          aria-label={chats ? `Everywhere (used by ${chats})` : "Everywhere"}
          onClick={() => info && open(info.refId)}
        >
          <span className="font-medium">Everywhere{chats && ` (used by ${chats})`}</span>
          <span className="text-sm text-muted">
            Changes the card in your library, for every chat it's in
            {info?.usesOverride
              ? "; this chat's own version takes the change where you haven't edited it."
              : pinned
                ? "; this chat uses another version of it here."
                : "."}
          </span>
        </button>
      </div>
      {action.error && (
        <p role="alert" className="text-sm text-danger">
          {action.error.message}
        </p>
      )}
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
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
      (needle === "" || card.name.toLowerCase().includes(needle) || card.label.toLowerCase().includes(needle))
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
                  {card.label !== card.name && <span className="truncate text-xs text-muted">{card.label}</span>}
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
  present,
  played,
  writing,
  onChange,
  onPlayed,
  onEdit,
  onError
}: {
  session: ChatSession
  card: CastCard
  info: ChatCard | undefined
  present: boolean
  played: boolean
  /** The model is writing their turn at the end of the chat. */
  writing: boolean
  onChange: (change: CastChange) => void
  onPlayed: (on: boolean) => void
  onEdit: () => void
  onError: (error: AppError | null) => void
}) {
  const [showCard, setShowCard] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const name = card.name
  const openCharacter = useOpenCharacter()
  const edited = info?.usesOverride === true && info.overrideRefId !== null
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
      <div className={`flex items-start gap-3 ${present ? "" : "opacity-60"}`}>
        <Avatar id={card.entityId} name={name} mediaId={card.avatarMediaId} size="lg" preview />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            onClick={() => openCharacter(card.entityId)}
            className="truncate text-left font-medium text-accent"
          >
            {name}
          </button>
          {card.label !== name && <span className="truncate text-xs text-muted">{card.label}</span>}
          <span className="flex flex-wrap items-center gap-1">
            {played && <Badge tone="accent">played by you</Badge>}
            {writing && <Badge tone="success">writing…</Badge>}
            {!present && <Badge tone="warning">absent</Badge>}
            {edited && (
              <Link
                to="/library/$refId"
                params={{ refId: info.overrideRefId! }}
                className="text-xs text-accent underline-offset-4 hover:underline"
              >
                Edited for this chat
              </Link>
            )}
            {card.inBin && <Badge tone="danger">in the bin</Badge>}
          </span>
        </div>
        <Switch
          checked={present}
          onCheckedChange={(next) => onChange({ _tag: "Presence", entityId: card.entityId, present: next })}
        >
          <span className="sr-only">{name} is </span>Present
        </Switch>
        <span className="-mt-1 -mr-2">
          <ActionMenu
            label={`More for ${name}`}
            trigger={<MoreIcon />}
            items={[
              {
                label: "I play them",
                checked: played,
                onCheckedChange: onPlayed
              },
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
        <Button variant="ghost" className={small} aria-label={`Edit ${name}`} onClick={onEdit}>
          Edit
        </Button>
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
  // Cards in the bin, or purged, have no definition to read.
  const key = participants.filter((id) => view.cards.get(id)?.inBin === false).join(" ")
  // The library entry, "used by N chats", this chat's own version and the definition the
  // next request reads; read again at a new leaf, after any library change (an editor
  // save), or an override made here.
  const infoAtom = useMemo(
    () =>
      AppClient.query(
        "ListChatCards",
        { chatId, slotId: leafSlotId, entityIds: key === "" ? [] : (key.split(" ") as Array<EntityId>) },
        { reactivityKeys: ["library", `chat-cards:${chatId}`] }
      ),
    [chatId, leafSlotId, key]
  )
  const infoResult = useAtomValue(infoAtom)
  const info = useMemo(
    () =>
      new Map(AsyncResult.isSuccess(infoResult) ? infoResult.value.map((card) => [card.entityId as string, card]) : []),
    [infoResult]
  )
  const [error, setError] = useState<AppError | null>(null)
  const [editing, setEditing] = useState<EntityId | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const playedByMe = cast?.playedByMe ?? []
  const togglePlayed = (id: EntityId, on: boolean) =>
    change({ _tag: "PlayedByMe", entityIds: on ? [...playedByMe, id] : playedByMe.filter((x) => x !== id) })
  const absent = cast?.absent.length ?? 0
  const editingCard = editing === null ? undefined : view.cards.get(editing)

  if (cast === null) return <p className="text-sm text-muted">Loading who's here…</p>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">Changes here apply from the latest message on, on this branch.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {plural(participants.length, "character", "characters")}
          {absent > 0 && <span className="font-normal text-muted"> · {absent} absent</span>}
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
                present={!cast.absent.includes(id)}
                played={playedByMe.includes(id)}
                writing={writing === id}
                onChange={(next) => void change(next)}
                onPlayed={(on) => void togglePlayed(id, on)}
                onEdit={() => setEditing(id)}
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
      {editingCard && (
        <EditScope
          session={session}
          card={editingCard}
          info={info.get(editingCard.entityId)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
