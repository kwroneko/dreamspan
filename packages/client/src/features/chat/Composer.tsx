// The composer (DESIGN §2.2): who's speaking, always visible, with a switcher and the
// speakers used most recently; Send as them, or Generate their turn, the text then being a
// one-turn direction. A send while a reply is still being written is queued by the
// server and shows here, pending, until it posts; it can be edited or taken back.
//
// The text is a server draft per branch tip (composerDraft.ts), held in a store of its own,
// so typing re-renders nothing else.
import type { CastCard, EntityId, QueuedMessage } from "@rp/shared/chat.ts"
import type { DraftState } from "@rp/shared/drafts.ts"
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { useSession } from "../../session.ts"
import type { AppError } from "../../errors.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Textarea } from "../../ui/Field.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { nameOf, recentSpeakers, replySpeaker, useCast } from "./cast.ts"
import { carriedComposerText, dropCarriedComposerText } from "./composerCarry.ts"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { ComposerDraft, type ComposerSource, type Sent } from "./composerDraft.ts"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

/** A send whose text was typed on a branch the chat view has left since. */
const BRANCH_CHANGED: AppError = {
  tag: "BranchChanged",
  message: "The branch changed before this was sent, so it wasn't. It's back in that branch's composer.",
  problems: [],
  reason: null
}

const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches

type SwitcherTab = "members" | "personas" | "all"
const TAB_KEY = "rp.speakerSwitcherTab"

/** The tab the switcher opened on last time; storage can be unavailable, which is fine. */
const savedTab = (): SwitcherTab => {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return value === "personas" || value === "all" ? value : "members"
  } catch {
    return "members"
  }
}
const saveTab = (tab: SwitcherTab) => {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Not remembered, then.
  }
}

function CardList({
  cards,
  current,
  empty,
  onPick
}: {
  cards: ReadonlyArray<CastCard>
  current: EntityId | null
  empty: string
  onPick: (card: CastCard) => void
}) {
  if (cards.length === 0) return <p className="px-1 py-2 text-sm text-muted">{empty}</p>
  return (
    <ul className="flex flex-col">
      {cards.map((card) => (
        <li key={card.entityId}>
          <button
            type="button"
            onClick={() => onPick(card)}
            aria-current={card.entityId === current || undefined}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus aria-[current]:bg-surface-raised"
          >
            <Avatar id={card.entityId} name={card.name} size="sm" />
            <span className="min-w-0 flex-1 truncate">{card.name}</span>
            {card.label !== card.name && <span className="min-w-0 truncate text-xs text-muted">{card.label}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The speaker, always visible; opens Members / Personas / All cards (DESIGN §2.2). */
const SpeakerSwitcher = memo(function SpeakerSwitcher({
  session,
  speaker,
  onPick
}: {
  session: ChatSession
  speaker: EntityId | null
  onPick: (card: CastCard) => void
}) {
  const view = useCast()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SwitcherTab>(savedTab)
  const [all, setAll] = useState<ReadonlyArray<CastCard> | null>(null)
  const name = nameOf(view, speaker) ?? "You"
  const members = (view.cast?.participants ?? []).flatMap((id) => {
    const card = view.cards.get(id)
    return card ? [card] : []
  })
  const openChange = (next: boolean) => {
    setOpen(next)
    if (next && all === null) void session.listCards().then((result) => setAll(result.ok ? result.value : []))
  }
  const pick = (card: CastCard) => {
    setOpen(false)
    onPick(card)
  }
  const cards = all ?? []
  return (
    <Popover
      open={open}
      onOpenChange={openChange}
      triggerLabel={`Speaking as ${name}. Change the speaker`}
      title="Speak as"
      trigger={
        <>
          {speaker !== null && <Avatar id={speaker} name={name} size="sm" />}
          <span className="min-w-0 truncate">{name}</span>
        </>
      }
    >
      <Tabs
        label="Cards to speak as"
        value={tab}
        onValueChange={(next) => {
          setTab(next)
          saveTab(next)
        }}
        tabs={[
          {
            value: "members",
            label: "Members",
            panel: <CardList cards={members} current={speaker} empty="No one has joined yet." onPick={pick} />
          },
          {
            value: "personas",
            label: "Personas",
            panel: (
              <CardList
                cards={cards.filter((card) => card.persona)}
                current={speaker}
                empty={all === null ? "Loading…" : "No cards in the persona folder."}
                onPick={pick}
              />
            )
          },
          {
            value: "all",
            label: "All cards",
            panel: (
              <CardList
                cards={cards}
                current={speaker}
                empty={all === null ? "Loading…" : "No cards yet."}
                onPick={pick}
              />
            )
          }
        ]}
      />
    </Popover>
  )
})

function Queued({
  queued,
  session,
  onWithdrawn
}: {
  queued: QueuedMessage
  session: ChatSession
  onWithdrawn: (text: string) => void
}) {
  const view = useCast()
  // The text being edited, and the version of the entry it started from: saving over a
  // newer one from another tab is a conflict, never a silent overwrite.
  const [editing, setEditing] = useState<{
    readonly text: string
    readonly rowVersion: number
    readonly speakerEntityId: QueuedMessage["speakerEntityId"]
  } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [conflict, setConflict] = useState(false)
  const who = nameOf(view, queued.speakerEntityId)
  const message = queued.kind === "message"
  return (
    <li className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-2" aria-label="Queued">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="warning">queued</Badge>
        <span className="text-muted">
          {message ? `Posts as ${who ?? "you"} when the reply finishes` : `Generates ${who ?? "a reply"} next`}
        </span>
      </div>
      {editing !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            const outcome = await session.editQueued(queued, editing.text, editing)
            if (outcome.ok) {
              setEditing(null)
              setError(null)
              setConflict(false)
            } else if (outcome.error.tag === "StaleWrite") {
              // Keep this text; show theirs; saving again (deliberately) replaces it.
              setConflict(true)
              setError(null)
              setEditing({ ...editing, rowVersion: queued.rowVersion, speakerEntityId: queued.speakerEntityId })
            } else setError(outcome.error)
          }}
        >
          {conflict && (
            <div role="alert" className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              <p>Changed in another tab while you were editing. It now reads:</p>
              <p className="mt-1 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{queued.content}</p>
              <p className="mt-1">Save again to replace it with your text, or cancel to keep theirs.</p>
            </div>
          )}
          <Textarea
            aria-label="Queued message"
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.currentTarget.value })}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              Save
            </Button>
            <Button
              onClick={() => {
                setEditing(null)
                setConflict(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {message ? queued.content : queued.direction ? `Direction: ${queued.direction}` : null}
        </p>
      )}
      <div className="flex gap-1">
        {message && editing === null && (
          <Button
            variant="ghost"
            onClick={() =>
              setEditing({
                text: queued.content,
                rowVersion: queued.rowVersion,
                speakerEntityId: queued.speakerEntityId
              })
            }
          >
            Edit
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            const outcome = await session.withdrawQueued(queued)
            setError(outcome.ok ? null : outcome.error)
            if (outcome.ok)
              onWithdrawn(outcome.value.kind === "message" ? outcome.value.content : (outcome.value.direction ?? ""))
          }}
        >
          Withdraw
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </li>
  )
}

/** Undo from the server's history of the composer's text (DESIGN §6.2): any earlier state, back. */
function History({ draft }: { draft: ComposerDraft }) {
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<ReadonlyArray<DraftState> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const openChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    setStates(null)
    void draft.history().then((result) => {
      // No draft here yet is no history yet.
      if (result.ok || result.error.tag === "NotFound") setStates(result.ok ? result.value : [])
      else setError(result.error)
    })
  }
  const restore = async (seq: number) => {
    const result = await draft.restore(seq)
    if (result !== null && !result.ok) setError(result.error)
    else setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={openChange}
      triggerLabel="Earlier text of this message"
      title="Earlier text"
      trigger="History"
    >
      {states === null ? (
        <p className="px-1 py-2 text-sm text-muted">{error ? error.message : "Loading…"}</p>
      ) : states.length <= 1 ? (
        <p className="px-1 py-2 text-sm text-muted">Nothing earlier yet: the history starts when you type.</p>
      ) : (
        <ul className="flex min-h-0 flex-col overflow-y-auto">
          {states.slice(1).map((state) => (
            <li key={state.seq}>
              <button
                type="button"
                onClick={() => void restore(state.seq)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span>
                  {new Date(state.at).toLocaleTimeString(undefined, { timeStyle: "short" })} ·{" "}
                  {state.length === 1 ? "1 character" : `${state.length} characters`}
                </span>
                {state.kind !== "initial" && (
                  <span className="w-full truncate text-xs text-muted">
                    {state.removed && state.inserted
                      ? `then “${state.removed}” became “${state.inserted}”`
                      : state.removed
                        ? `then “${state.removed}” was removed`
                        : `then “${state.inserted}” was typed`}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && states !== null && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </Popover>
  )
}

export function Composer({ session, view }: { session: ChatSession; view: ChatView }) {
  const castView = useCast()
  const { cast } = castView
  const userId = useSession().user.id
  // The text is a server draft per branch tip (composerDraft.ts). Text typed on the card's
  // page while this chat was being made comes along (composerCarry.ts).
  const [draft] = useState(() => new ComposerDraft(session, userId, carriedComposerText(session.id)))
  useEffect(() => dropCarriedComposerText(session.id), [session])
  const {
    text,
    ready,
    restored,
    conflict,
    recovered,
    error: saveError
  } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  // The speaker picked here; until then, the first card the user plays.
  const [picked, setPicked] = useState<EntityId | null | undefined>(undefined)
  const speaker = picked !== undefined ? picked : (cast?.playedByMe[0] ?? null)
  const name = nameOf(castView, speaker)
  // Only known when the window reaches the leaf; otherwise the server takes the message anyway.
  const leaf = view.newer === null ? view.entries.at(-1) : undefined
  const leafGenerating = leaf?.version.status === "generating"
  const recent = useMemo(
    () =>
      recentSpeakers(view.entries, 4)
        .filter((id) => id !== speaker && castView.cards.has(id))
        .slice(0, 3),
    [view.entries, speaker, castView.cards]
  )
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)

  /** The composer belongs to the tip of the path shown (DESIGN §6.2). */
  const syncTip = useCallback(() => {
    const { loading, leafSlotId } = session.snapshot()
    if (loading) return
    draft.setTip(leafSlotId, session.movedByAppend(draft.tip ?? null, leafSlotId), session.takeBranchStart(leafSlotId))
  }, [draft, session])
  useEffect(syncTip, [syncTip, view.leafSlotId, view.loading])

  // Leaving the chat saves what's typed; closing or reloading the tab with text not on the
  // server asks first, and sends it as the page goes (the editors' rules, editor/store.ts).
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!draft.isUnsaved()) return
      event.preventDefault()
      event.returnValue = ""
    }
    const leave = () => draft.beacon()
    const hidden = () => {
      if (document.visibilityState === "hidden") void draft.flush()
    }
    addEventListener("beforeunload", warn)
    addEventListener("pagehide", leave)
    document.addEventListener("visibilitychange", hidden)
    return () => {
      removeEventListener("beforeunload", warn)
      removeEventListener("pagehide", leave)
      document.removeEventListener("visibilitychange", hidden)
      void draft.flush()
    }
  }, [draft])

  /** A card that isn't in the chat joins it from here on (DESIGN §2.2). */
  const pick = useCallback(
    async (card: CastCard) => {
      setPicked(card.entityId)
      if (cast !== null && !cast.participants.includes(card.entityId)) {
        const outcome = await session.changeCast({ _tag: "Join", entityId: card.entityId })
        setError(outcome.ok ? null : outcome.error)
      }
    },
    [cast, session]
  )
  const onPick = useCallback((card: CastCard) => void pick(card), [pick])

  /**
   * The text leaves the box as it's submitted, so whatever is typed while the request is out
   * stays. It's sent from the draft it was typed into, at that draft's tip, which commits it,
   * so a reload never shows it; if the chat view went to another branch since, it isn't
   * sent. Text that isn't sent comes back, ahead of anything typed since (composerDraft.ts).
   */
  const submit = async (run: (from: ComposerSource) => Promise<Sent>) => {
    if (busy) return
    setBusy(true)
    await draft.submit((from) => {
      if (from.tip !== session.snapshot().leafSlotId) {
        setError(BRANCH_CHANGED)
        return Promise.resolve({ sent: false })
      }
      return run(from)
    })
    setBusy(false)
  }

  const send = () =>
    text.trim() === ""
      ? Promise.resolve()
      : submit(async (from) => {
          const { sent, outcome, draft, recovered } = await session.send(
            from.text,
            speaker,
            replySpeaker(cast, speaker),
            from
          )
          report(outcome)
          // A message that was sent (or queued) is gone from the box, even if its reply failed.
          return sent ? { sent, draft, recovered } : { sent }
        })

  // The text is this turn's direction (DESIGN §2.2): once asked for, it's on the reply.
  const generate = () =>
    submit(async (from) => {
      const outcome = await session.generate(from.tip, speaker, from.text, from)
      report(outcome)
      return outcome.ok
        ? { sent: true, draft: outcome.value.draft, recovered: outcome.value.recovered }
        : { sent: false }
    })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    if (event.ctrlKey || event.metaKey || (!event.shiftKey && !coarsePointer())) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 border-t border-border pt-3 pb-3">
      {view.queue.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Queued messages">
          {view.queue.map((queued) => (
            <Queued
              key={queued.id}
              queued={queued}
              session={session}
              // Withdrawn text never just disappears: it comes back to the box, after what's there.
              onWithdrawn={(withdrawn) => {
                const current = draft.snapshot().text
                draft.type(current === "" ? withdrawn : withdrawn === "" ? current : `${current}\n\n${withdrawn}`)
              }}
            />
          ))}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SpeakerSwitcher session={session} speaker={speaker} onPick={onPick} />
        {recent.map((id) => (
          <button
            key={id}
            type="button"
            aria-label={`Speak as ${nameOf(castView, id)}`}
            onClick={() => setPicked(id)}
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Avatar id={id} name={nameOf(castView, id) ?? "?"} size="sm" />
          </button>
        ))}
      </div>
      {conflict && (
        <ReplayNotice
          conflict={conflict}
          acknowledge={() => draft.acknowledgeConflict()}
          switchText={() => draft.switchConflict()}
        />
      )}
      {restored && !conflict && (
        <p role="status" className="text-sm text-muted">
          Text this browser kept when the page closed before the server had it is back in the box.
        </p>
      )}
      {recovered && (
        <p role="status" className="text-sm text-muted">
          Some text from this composer is in the{" "}
          <Link to="/bin" search={{ section: "recovered" }}>
            bin, under recovered text
          </Link>
          : text typed in this browser while offline whose session ended elsewhere, or earlier text another tab's typing
          went over.
        </p>
      )}
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        data-testid="composer"
        rows={3}
        value={text}
        readOnly={!ready}
        aria-busy={!ready}
        placeholder={
          !ready
            ? "Loading what you typed here…"
            : leafGenerating
              ? "Write a message: it posts when the reply finishes…"
              : "Write a message…"
        }
        onChange={(event) => draft.type(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-base text-text outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 sm:text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" pending={busy} disabled={text.trim() === "" || !ready} onClick={send}>
          {name ? `Send as ${name}` : "Send"}
        </Button>
        <Button
          disabled={busy || !ready}
          title={text.trim() === "" ? undefined : "The text becomes this turn's direction"}
          onClick={generate}
        >
          {name ? `Generate ${name}` : "Reply"}
        </Button>
        {leaf?.version.writer === "model" && (
          <Button variant="ghost" onClick={async () => report(await session.regenerate(leaf))}>
            Regenerate
          </Button>
        )}
        {leafGenerating && (
          <Button variant="secondary" onClick={async () => report(await session.stop(leaf.version.id))}>
            Stop
          </Button>
        )}
        <History draft={draft} />
        {(error ?? saveError) && (
          <p role="alert" className="text-sm text-danger">
            {(error ?? saveError)!.message}
          </p>
        )}
      </div>
    </div>
  )
}
