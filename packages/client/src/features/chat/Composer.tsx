import { ComposerControls, invokeComposerControl, type ComposerControlContext } from "./composerControls.tsx"
// The composer (DESIGN §2.2): who's speaking, always visible, with a switcher and the
// speakers used most recently; Send as them, or Generate a turn. With the guidance toggle
// on, the text is guidance instead: a one-turn direction for Generate or Continue, never sent
// as a message, and it leaves the box as it's submitted. While a reply's guidance is being
// edited (guidanceEdit.tsx), the box holds that instead, and any submit makes a new version
// of the reply; the draft stays as it was underneath. A send while a reply is still being
// written is queued by the server and shows here, pending, until it posts; it can be edited
// or taken back.
//
// The text is a server draft per branch tip (composerDraft.ts), held in a store of its own,
// so typing re-renders nothing else.
import type { CastCard, EntityId, MessageImages } from "@rp/shared/chat.ts"
import type { DraftState } from "@rp/shared/drafts.ts"
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useSession } from "../../session.ts"
import type { AppError } from "../../errors.ts"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { composerKeyDown } from "./composerKeys.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { defaultSpeaker, nameOf, recentSpeakers, replyFaces, useCast } from "./cast.ts"
import { planReply } from "./replyPolicy.ts"
import { HistoryIcon } from "./icons.tsx"
import { composerChoice, useComposerChoice } from "./speaker.ts"
import { useComposerTurn } from "./composerTurn.ts"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { ComposerDraft, type ComposerSource, type Sent } from "./composerDraft.ts"
import { composerGuidance, editStillShown, guidanceEditor, useGuidanceEdit } from "./guidanceEdit.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

const subscribePhone = (notify: () => void) => {
  const media = matchMedia("(max-width: 639px)")
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}

/** A send whose text was typed on a branch the chat view has left since. */
const BRANCH_CHANGED: AppError = {
  tag: "BranchChanged",
  message: "The branch changed before this was sent, so it wasn't. It's back in that branch's composer.",
  problems: [],
  reason: null
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
      hint="Earlier text of this message"
      triggerClassName={`${buttonClass("ghost")} w-9 px-0!`}
      side="top"
      align="end"
      title="Earlier text"
      trigger={<HistoryIcon />}
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

export interface AttachmentInput {
  readonly count: number
  readonly busy: boolean
  /** What's attached, under the composer: shown only when there's something to show. */
  readonly editor: ReactNode
  /** The control that attaches (a paperclip), in the composer's action row. */
  readonly action?: ReactNode
  readonly restore: (images: MessageImages) => void
  readonly capture: () => {
    readonly images: MessageImages
    readonly ids: readonly string[]
    readonly begin: (from: ComposerSource) => Promise<void>
    readonly finish: (sent: boolean) => Promise<void>
  }
}

export function Composer({
  session,
  view,
  onSettings,
  attachmentInput
}: {
  session: ChatSession
  view: ChatView
  onSettings: (tab: "model" | "preset") => void
  attachmentInput?: AttachmentInput
}) {
  const phone = useSyncExternalStore(subscribePhone, () => matchMedia("(max-width: 639px)").matches)
  const [secondaryOpen, setSecondaryOpen] = useState(false)
  const castView = useCast()
  const { cast } = castView
  const userId = useSession().user.id
  // The text is a server draft per branch tip (composerDraft.ts). Text typed on the card's
  // page while this chat was being made comes along (composerCarry.ts).
  const [draft] = useState(() => new ComposerDraft(session, userId))
  const {
    text: draftText,
    ready: textReady,
    restored,
    conflict,
    recovered,
    error: saveError,
    draftId
  } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  // A reply's guidance being edited: the box shows it, and typing changes it, not the draft,
  // so the draft (and a reload) still has what was typed before Edit.
  const editor = guidanceEditor(session)
  const editing = useGuidanceEdit(session)
  const text = editing === null ? draftText : editing.text
  // The guidance toggle, per account (DESIGN §2.2), shown on while a reply's guidance is
  // edited, and as it was after. New versions and Continue ask the session for their guidance
  // as they're asked for: a new version reuses its reply's own, except the reply edited here.
  const viewPrefs = useViewPrefs()
  const guidance = viewPrefs.prefs.guidance || editing !== null
  const toggleOn = viewPrefs.prefs.guidance
  useEffect(
    () =>
      session.provideGuidance(
        composerGuidance(
          editor,
          () => toggleOn,
          () => draft.snapshot().text
        )
      ),
    [session, draft, editor, toggleOn]
  )
  // Said once per preset when writing for a card the user plays (DESIGN §2.2).
  const [impersonationNotice, setImpersonationNotice] = useState(false)
  // The speaker and the reply picked here or with "Write as" in the Cast tab, kept on the
  // server with this tip's draft (speaker.ts). Nothing is sent until they're read.
  const choices = composerChoice(session)
  const choice = useComposerChoice(session)
  useEffect(() => choices.bind(draftId), [choices, draftId])
  const turnEntries = useComposerTurn(session, view, cast)
  // Revising an existing reply needs its slot/fork, not the new turn's speaker choice or
  // reply order. Waiting for those reads would disable the visible button while Enter works.
  const ready =
    editing !== null
      ? !view.loading && editStillShown(editing, view)
      : !attachmentInput?.busy &&
        textReady &&
        choice.loaded &&
        !choice.saving &&
        choice.draftId === draftId &&
        turnEntries !== null
  const speaker = choice.speaker ?? defaultSpeaker(cast)
  const setPicked = (id: EntityId) => void choices.change({ speaker: id }).then(report)
  const name = nameOf(castView, speaker)
  const speakerPlayed = speaker !== null && (cast?.playedByMe.includes(speaker) ?? false)
  // Who replies to the next send: the face picked for it, else the next in turn (ReplyFrom.tsx).
  // A muted character is never next in turn, but can be picked for one reply.
  const faces = useMemo(() => replyFaces(cast, speaker), [cast, speaker])
  const pickedReply = choice.replyFrom !== null && faces.includes(choice.replyFrom) ? choice.replyFrom : null
  const replyPlan = useMemo(
    () => planReply(cast, turnEntries, speaker, pickedReply),
    [cast, turnEntries, speaker, pickedReply]
  )
  const { next, replier } = replyPlan
  const replierName = nameOf(castView, replier)
  // Only known when the window reaches the leaf; otherwise the server takes the message anyway.
  const leaf = view.newer === null ? view.entries.at(-1) : undefined
  const leafGenerating = leaf?.version.status === "generating"
  const recent = useMemo(
    () =>
      recentSpeakers(view.entries, 4)
        // Only the chat's cast can speak (DESIGN §2.2): a card that left isn't offered.
        .filter((id) => id !== speaker && (cast?.participants.includes(id) || cast?.playedByMe.includes(id)))
        .slice(0, 3),
    [view.entries, speaker, cast]
  )
  // Listed first in the switcher, with nothing typed: who spoke last, the speaker too.
  const switcherRecent = useMemo(() => recentSpeakers(view.entries, 8), [view.entries])
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)

  /** The composer belongs to the fork shown (DESIGN §6.2). */
  const syncFork = useCallback(() => {
    const { loading, forkId } = session.snapshot()
    if (loading) return
    draft.setFork(forkId, session.takeBranchStart(forkId))
  }, [draft, session])
  useEffect(syncFork, [syncFork, view.forkId, view.leafSlotId, view.loading])

  // The bar closes when its reply is deleted, or the chat view goes to another fork.
  useEffect(() => {
    if (editing !== null && !view.loading && !editStillShown(editing, view)) editor.close()
  }, [editor, editing, view])

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

  /**
   * Picking a speaker only picks who writes, from the chat's cast (DESIGN §2.2): who `{{user}}`
   * is (the persona) stays as it is, so the cached prefix does.
   */
  const onPick = useCallback(
    (card: CastCard) =>
      void choices.change({ speaker: card.entityId }).then((picked) => setError(picked.ok ? null : picked.error)),
    [choices]
  )

  /**
   * The text leaves the box as it's submitted, so whatever is typed while the request is out
   * stays. It's sent from the draft it was typed into, in that draft's fork, which commits
   * it, so a reload never shows it; if the chat view went to another fork since, it isn't
   * sent. Text that isn't sent comes back, ahead of anything typed since (composerDraft.ts).
   */
  const submit = async (run: (from: ComposerSource) => Promise<Sent>) => {
    if (busy || !ready) return
    setBusy(true)
    await draft.submit((from) => {
      if (from.fork !== session.snapshot().forkId) {
        setError(BRANCH_CHANGED)
        return Promise.resolve({ sent: false })
      }
      return run(from)
    })
    setBusy(false)
  }

  /** A face picked for one reply goes back to the turn order once that reply is asked for. */
  const replied = (draftId: string) => {
    if (pickedReply !== null) void choices.consume(draftId, pickedReply).then(report)
  }

  const send = () => {
    if (text.trim() === "" && !attachmentInput?.count) return Promise.resolve()
    const captured = attachmentInput?.capture()
    return submit(async (from) => {
      await captured?.begin(from)
      let accepted = false
      try {
        const { sent, outcome, draft, recovered } = await session.send(
          from.text,
          speaker,
          replier,
          from,
          replyPlan.reply,
          captured?.images,
          captured?.ids
        )
        accepted = sent
        report(outcome)
        if (sent) replied(from.draftId)
        return sent ? { sent, draft, recovered } : { sent }
      } finally {
        await captured?.finish(accepted)
      }
    })
  }

  // With nothing typed, Send asks for the reply alone, as an empty send does in ST.
  const replyNow = async () => {
    if (busy || !ready || replier === null || choice.draftId === null) return
    setBusy(true)
    const outcome = await session.generate(session.snapshot().leafSlotId, replier)
    report(outcome)
    if (outcome.ok) replied(choice.draftId)
    setBusy(false)
  }

  /**
   * The model writes the speaker's turn (an impersonation when it's a card the user plays). With
   * guidance on, it's Enter and the primary action, and the text is its one-turn direction: it
   * leaves the box as a send's does, and the reply shows it; with guidance off, the text isn't
   * used and stays. Guidance changes who writes, never which character (DESIGN §2.2).
   */
  const generate = async () => {
    if (editing !== null) return reviseGuidance()
    if (busy || !ready) return
    let outcome: Outcome<unknown> | undefined
    if (guidance && text.trim() !== "") {
      await submit(async (from) => {
        const result = await session.generate(session.snapshot().leafSlotId, speaker, from.text, from)
        outcome = result
        return result.ok
          ? { sent: true, draft: result.value.draft, recovered: result.value.recovered }
          : { sent: false }
      })
      if (outcome === undefined) return
      report(outcome)
    } else {
      setBusy(true)
      outcome = await session.generate(session.snapshot().leafSlotId, speaker)
      report(outcome)
      setBusy(false)
    }
    if (outcome.ok && speaker !== null && cast?.playedByMe.includes(speaker)) {
      const notice = await session.impersonationNotice()
      if (notice.ok && notice.value.show) setImpersonationNotice(true)
    }
  }

  /**
   * While a reply's guidance is edited, every submit is a new version of that reply with the
   * box's text (none when it's empty), which stays in the box for the next one.
   */
  const reviseGuidance = async () => {
    const entry = editing === null ? undefined : view.entries.find((e) => e.slotId === editing.slotId)
    if (busy || !ready || entry === undefined) return
    setBusy(true)
    report(await session.regenerate(entry))
    setBusy(false)
  }

  const hasText = text.trim() !== "" || !!attachmentInput?.count
  const sendLabel = hasText ? (name ? `Send as ${name}` : "Send") : replierName ? `${replierName} replies` : "Send"
  const sendHint = hasText
    ? `${sendLabel}${replierName ? `, then ${replierName} replies` : ""} (Enter; Shift+Enter for a new line)`
    : replierName
      ? `${replierName} replies now, with nothing sent from you`
      : "Type a message to send"
  // Generate writes the speaker's turn: for a card the user plays, the model writes it for them.
  const editedName = editing === null ? null : nameOf(castView, editing.speakerEntityId)
  const generateText = editing !== null ? "New version" : name ? `Write for ${name}` : "Reply"
  const generateHint =
    editing !== null
      ? `A new version of ${editedName ? `${editedName}'s` : "this"} reply, following this guidance (Enter). The guidance stays here.`
      : `${
          name === null
            ? "The model writes the next turn"
            : speakerPlayed
              ? `The model writes ${name}'s turn for you`
              : `The model writes ${name}'s turn`
        }${guidance && hasText ? ", following the guidance" : ""}${guidance ? " (Enter)" : ""}`
  const shownError = error ?? saveError ?? viewPrefs.error
  // The draft's earlier text, while the box shows the draft.
  const history = editing === null && <History draft={draft} />

  const controls: ComposerControlContext = {
    compact: phone,
    recoverQueued: (withdrawn, images) => {
      if (images?.length) attachmentInput?.restore(images)
      const current = draft.snapshot().text
      draft.type(current === "" ? withdrawn : withdrawn === "" ? current : `${current}\n\n${withdrawn}`)
    },
    session,
    view,
    onSettings,
    speaker: { speaker, recent: switcherRecent, onPick },
    recent: recent.map((id) => ({
      id,
      name: nameOf(castView, id) ?? "?",
      mediaId: castView.cards.get(id)?.avatarMediaId ?? null
    })),
    onRecent: setPicked,
    guidance,
    // While a reply's guidance is edited, the box is guidance whatever the toggle says.
    prefsReady: viewPrefs.ready && editing === null,
    changeGuidance: (next) => {
      void viewPrefs.change({ guidance: next })
    },
    hint:
      editing !== null
        ? `Guidance for ${editedName ? `${editedName}'s` : "this"} reply: each submit (Enter) makes a new version of it with this text, and its regenerate uses it too. ✕ above goes back to your draft.`
        : guidance
          ? `A one-turn direction for ${name ? `${name}'s` : "the"} next message (Enter) or Continue. It leaves the box when you submit it; a new version of a reply uses that reply's own guidance.`
          : `${generateText} doesn't use this text: turn guidance on to direct the next message with it.`,
    reply: {
      candidates: faces,
      muted: cast?.absent ?? [],
      next,
      picked: pickedReply,
      disabled: !ready,
      onPick: (id) => void choices.change({ replyFrom: id }).then(report)
    },
    leaf,
    leafGenerating,
    busy,
    ready,
    hasText,
    replier,
    generateText,
    generateHint,
    sendLabel,
    sendHint,
    generate,
    send,
    replyNow,
    report
  }
  const onKeyDown = composerKeyDown(() =>
    invokeComposerControl(guidance ? "composer.generate" : "composer.send", controls, "keyboard")
  )

  return (
    <div className="@container mx-auto flex w-full max-w-3xl flex-col gap-2 border-t border-border pt-2 pb-2">
      {!phone && <ComposerControls placement="settings" context={controls} />}
      <ComposerControls placement="banner" context={controls} />
      <ComposerControls placement="queue" context={controls} />
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
      <div className="flex flex-col gap-1.5 @min-[640px]:flex-row @min-[640px]:items-end">
        {/* Who's speaking, and the speakers used last: one tap each (DESIGN §2.2). */}
        <div className="flex min-w-0 items-center gap-1 max-sm:[&>button]:max-w-32 @min-[640px]:h-11">
          <ComposerControls placement="speaker" context={controls} />
          {phone && (
            <>
              <ComposerControls placement="guidance" context={controls} />
              <Popover
                open={secondaryOpen}
                onOpenChange={setSecondaryOpen}
                triggerLabel="Composer options"
                trigger="Options"
                title="Next reply"
                triggerClassName={`${buttonClass("ghost")} ml-auto px-2! text-xs`}
              >
                <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
                  <ComposerControls placement="settings" context={controls} />
                  <ComposerControls placement="reply" context={controls} />
                  <ComposerControls placement="help" context={controls} />
                  {history}
                </div>
              </Popover>
            </>
          )}
          <span className={`${phone ? "hidden" : "ml-auto"} @min-[640px]:hidden`}>{history}</span>
        </div>
        <div
          data-guidance={guidance || undefined}
          className={`flex min-w-0 flex-1 flex-wrap items-end gap-1 rounded-lg border p-1 focus-within:ring-2 @min-[640px]:flex-nowrap ${
            guidance
              ? "border-guidance bg-guidance-surface focus-within:ring-guidance/40"
              : "border-border bg-surface focus-within:border-focus focus-within:ring-focus/40"
          }`}
        >
          <div className="grid w-full min-w-0 @min-[640px]:flex-1">
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
              readOnly={editing === null && !textReady}
              aria-busy={editing === null && !textReady}
              aria-describedby={(!phone || secondaryOpen) && (hasText || guidance) ? "composer-hint" : undefined}
              placeholder={
                editing !== null
                  ? "Guidance for this reply…"
                  : !textReady
                    ? "Loading…"
                    : guidance
                      ? "Direction for the next message…"
                      : leafGenerating
                        ? "Queue…"
                        : "Message…"
              }
              onChange={(event) =>
                editing === null ? draft.type(event.currentTarget.value) : editor.type(event.currentTarget.value)
              }
              onKeyDown={onKeyDown}
            />
          </div>
          {/* Under the text box when it's narrow, beside it otherwise. */}
          <div className="ml-auto flex items-end gap-1">
            <span className="hidden @min-[640px]:inline-flex">{history}</span>
            {attachmentInput?.action}
            <ComposerControls placement="actions" context={controls} />
          </div>
        </div>
      </div>
      {attachmentInput?.editor}
      {!phone && (
        <>
          <ComposerControls placement="guidance" context={controls} />
          <ComposerControls placement="reply" context={controls} />
        </>
      )}
      {impersonationNotice && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 basis-60 wrap-break-word">
            This preset's rules against writing for {"{{user}}"} may need “not when writing as {"{{user}}"}”: in the
            preset, set their condition to “When writing as a character”.
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              setImpersonationNotice(false)
              onSettings("preset")
            }}
          >
            Open the preset
          </Button>
          <Button variant="ghost" onClick={() => setImpersonationNotice(false)}>
            Dismiss
          </Button>
        </div>
      )}
      {shownError && (
        <p role="alert" className="text-sm text-danger">
          {shownError.message}
        </p>
      )}
    </div>
  )
}
