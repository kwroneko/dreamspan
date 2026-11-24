import { Tooltip } from "../../ui/Tooltip.tsx"
import { composerWorkspace } from "./composerWorkspace.ts"
import {
  ComposerControls,
  invokeComposerControl,
  type ComposerControlContext,
  useSendRoute
} from "./composerControls.tsx"
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
// so typing re-renders nothing else. Its box is the message editor's (the `message.text-editor`
// slot): a message is typed styled as it will render, guidance plain.
import type { CastCard, EntityId, MessageImages } from "@dreamspan/shared/chat.ts"
import type { DraftState } from "@dreamspan/shared/drafts.ts"
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useSession } from "../../session.ts"
import type { AppError } from "../../errors.ts"
import { restedText } from "./restedText.ts"
import { composerKeyDown, composerSubmitHint, composerSubmitKey } from "./composerKeys.ts"
import { SlotOutlet } from "../../slots.tsx"
import { loadMessageTextEditor } from "../../ui/messageTextLoader.ts"
import { buttonClass } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { defaultSpeaker, listNames, nameOf, recentSpeakers, replyFaces, useCast } from "./cast.ts"
import { planReply } from "./replyPolicy.ts"
import { HistoryIcon } from "./icons.tsx"
import { composerChoice, useComposerChoice } from "./speaker.ts"
import { useComposerTurn } from "./composerTurn.ts"
import { StripRow } from "./nextReplyStrip.tsx"
import { NO_ONE } from "./ReplyFrom.tsx"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { type ComposerDraft, type ComposerSource, type Sent } from "./composerDraft.ts"
import { composerGuidance, editStillShown, guidanceEditor, useGuidanceEdit } from "./guidanceEdit.tsx"
import { messageTextEditor } from "./editorHistory.tsx"
import { FILE_PATH_MIME } from "./fileAttachments.ts"
import type { ChatSession, ChatView, Outcome } from "./session.ts"
import { requestCastAdd } from "./castAddState.ts"
import { useDecisionPointOn } from "../decisions/index.tsx"

// The text box's code, fetched as soon as the composer's is (the chat page waits for it too).
void loadMessageTextEditor().catch(() => undefined)

/** A pasted or dropped file, or a file dragged from the Files tab: an attachment, not text. */
const attachmentData = (data: DataTransfer) => data.files.length > 0 || data.types.includes(FILE_PATH_MIME)

/** A phone's width, the composers' compact layout's breakpoint. */
const COMPACT_WIDTH = 640
/**
 * The narrowest composer whose control row holds the speaker's name and Generate's word beside
 * the tools and Send. A desktop chat between both panels at their widest is narrower.
 */
const FULL_ROW_WIDTH = 480

const subscribePhone = (notify: () => void) => {
  const media = matchMedia(`(max-width: ${COMPACT_WIDTH - 1}px)`)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}

/**
 * The composers' compact layout: on a phone, and wherever the composer is too narrow for the full bar,
 * as between a wide sidebar and a wide chat panel. `ref` goes on the composer's own box.
 */
export const useCompactComposer = () => {
  const phone = useSyncExternalStore(subscribePhone, () => matchMedia(`(max-width: ${COMPACT_WIDTH - 1}px)`).matches)
  const [narrow, setNarrow] = useState(false)
  const ref = useCallback((node: HTMLElement | null) => {
    if (node === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < FULL_ROW_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { compact: phone || narrow, ref }
}

/**
 * The composers' box (owner 2026-11-01: the input is the composer's main part): the text on a
 * row of its own, the whole box's width, with everything about it inside the same border. On
 * top, `header`, what says how the box stands (editing a reply's guidance, replayed or restored
 * text), shown only while it has something; then what's attached (owner, 2026-11-23: above
 * the text, as other chat apps, so the caret never moves), the text; then one row of
 * controls, `start` (who speaks, tools) at its left and `end` (guidance, generate, send) at its
 * right, wrapping rather than ever narrowing the text.
 */
export function ComposerBox({
  guidance,
  header,
  attachments,
  start,
  end,
  children
}: {
  guidance: boolean
  header?: ReactNode
  attachments?: ReactNode
  start: ReactNode
  end: ReactNode
  children: ReactNode
}) {
  return (
    <div
      data-testid="composer-box"
      data-guidance={guidance || undefined}
      className={`flex min-w-0 flex-col rounded-lg border focus-within:ring-2 ${
        guidance
          ? "border-guidance bg-guidance-surface focus-within:ring-guidance/40"
          : "border-border bg-surface focus-within:border-focus focus-within:ring-focus/40"
      }`}
    >
      {header !== undefined && (
        <div
          data-testid="composer-header"
          className={`flex flex-col gap-1.5 border-b p-2 empty:hidden ${guidance ? "border-guidance/40" : "border-border"}`}
        >
          {header}
        </div>
      )}
      {/* Above the text: attaching grows the box upward, and the text and controls stay put. */}
      {attachments && <div className="px-2 pt-1">{attachments}</div>}
      <div className="grid min-w-0 p-2">{children}</div>
      <div data-testid="composer-controls" className="flex min-w-0 flex-wrap items-center gap-1.5 p-2">
        <div className="flex min-w-0 items-center gap-1.5">{start}</div>
        {/* Its gap is a variable: Generate in guidance mode takes Send's width and this gap too (WIDE_GENERATE). */}
        <div className="ml-auto flex shrink-0 items-center gap-(--composer-actions-gap) [--composer-actions-gap:--spacing(1.5)]">
          {end}
        </div>
      </div>
    </div>
  )
}

/** A send whose text was typed on a branch the chat view has left since. */
const BRANCH_CHANGED: AppError = {
  tag: "BranchChanged",
  message: "The branch changed before this was sent, so it wasn't. It's back in that branch's composer.",
  problems: [],
  reason: null
}

/** Undo from the server's history of the composer's text (DESIGN §6.2): any earlier state, back. */
function History({ draft, disabled = false }: { draft: ComposerDraft; disabled?: boolean }) {
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
      triggerDisabled={disabled}
      onOpenChange={openChange}
      triggerLabel="Earlier text in this box"
      hint={
        disabled
          ? "Finish editing this reply’s guidance to browse composer history."
          : "Shows earlier text you typed in this box."
      }
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
              <Tooltip label="Loads this earlier composer text.">
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
              </Tooltip>
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
  onSettings: (tab: "model" | "preset" | "cast") => void
  attachmentInput?: AttachmentInput
}) {
  const { compact: phone, ref: composerRef } = useCompactComposer()
  const castView = useCast()
  const { cast } = castView
  const userId = useSession().user.id
  // The text is a server draft per branch tip (composerDraft.ts). Text typed on the card's
  // page while this chat was being made comes along (composerCarry.ts).
  const [workspace] = useState(() => composerWorkspace(session, userId))
  const { draft, setBusy, setError, syncFork } = workspace
  const { busy, error } = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const {
    text: draftText,
    guidance: draftGuidance,
    ready: textReady,
    conflict,
    error: saveError,
    draftId
  } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  // The text once typing pauses, for the strip's context chip: keystrokes don't reach it.
  const [typed] = useState(() => restedText(draft.subscribe, () => draft.snapshot().text))
  // A reply's guidance being edited: the box is still the composer draft (one box, one draft),
  // only aimed at a new version of that reply; the reply's guidance, if any, is typed into it.
  const editor = guidanceEditor(session)
  const editing = useGuidanceEdit(session)
  const text = draftText
  // A new version of a reply is not a send: who replies next follows the draft only for new turns.
  const sendText = editing === null ? draftText : ""
  useEffect(() => {
    if (editing === null || !textReady) return
    const pending = editor.takePending()
    const before = draft.snapshot().text
    if (pending === null || before === pending) return
    if (before === "") {
      draft.type(pending)
      return
    }
    // The text there first reaches the server, so replacing it leaves it one step back in the
    // history (a whole-text replacement is its own entry). Not saved, it stays in the box.
    void draft.flush().then(() => {
      if (draft.snapshot().text === before && !draft.isUnsaved()) draft.type(pending)
    })
  }, [editor, editing, textReady, draft])
  const choices = composerChoice(session)
  const choice = useComposerChoice(session)
  // The guidance toggle belongs to this composer, shown on while a reply's guidance is
  // edited, and as it was after. New versions and Continue ask the session for their guidance
  // as they're asked for: a new version reuses its reply's own, except the reply edited here.
  const viewPrefs = useViewPrefs()
  const submitHint = composerSubmitHint(viewPrefs.prefs.enterSends)
  // At the end of the hover of the one button Enter triggers: Generate with guidance on, else Send.
  const submitKey = ` (${composerSubmitKey(viewPrefs.prefs.enterSends)})`
  const mode = choice.draftId === draftId ? choice.guidance : draftGuidance
  const guidance = mode || editing !== null
  const choicesReady =
    choice.loaded &&
    choice.draftId === draftId &&
    draftId !== null &&
    draft.draftIdFor(view.forkId) === draftId &&
    !view.loading
  useEffect(
    () =>
      session.provideGuidance(
        composerGuidance(
          editor,
          () => {
            const current = choices.snapshot()
            const opened = draft.snapshot()
            return (
              draft.draftIdFor(session.snapshot().forkId) !== null &&
              (current.draftId === opened.draftId ? current.guidance : opened.guidance)
            )
          },
          () => draft.snapshot().text
        )
      ),
    [session, draft, editor, choices]
  )
  // Said once per preset when writing for a card the user plays (DESIGN §2.2).
  // The speaker and the reply picked here or with "Write as" in the Cast tab, kept on the
  // server with this tip's draft (speaker.ts). Nothing is sent until they're read.
  useEffect(() => choices.bind(draftId, draftGuidance), [choices, draftId, draftGuidance])
  const turnEntries = useComposerTurn(session, view, cast)
  // Revising an existing reply needs its slot/fork, not the new turn's speaker choice or
  // reply order. Waiting for those reads would disable the visible button while Enter works.
  const ready =
    viewPrefs.ready &&
    (editing !== null
      ? !view.loading && editStillShown(editing, view)
      : !attachmentInput?.busy && textReady && choicesReady && !choice.saving && turnEntries !== null)
  const speaker = choice.speaker ?? defaultSpeaker(cast)
  const setPicked = (id: EntityId) => void choices.change({ speaker: id }).then(report)
  const name = nameOf(castView, speaker)
  const speakerPlayed = speaker !== null && (cast?.playedByMe.includes(speaker) ?? false)
  // Who replies to the next send: the face picked for it, else Auto's pick (ReplyFrom.tsx).
  // A muted character is never Auto's pick, but can be picked for one reply. The text in the box
  // counts, as Send passes it: naming a character there makes them the one to reply.
  const faces = useMemo(() => replyFaces(cast, speaker), [cast, speaker])
  const pickedReply = choice.replyFrom !== null && faces.includes(choice.replyFrom) ? choice.replyFrom : null
  const hasImages = (attachmentInput?.count ?? 0) > 0
  const replyPlan = useMemo(
    () => planReply(cast, turnEntries, speaker, pickedReply, sendText, hasImages, choice.noReplies),
    [cast, turnEntries, speaker, pickedReply, sendText, hasImages, choice.noReplies]
  )
  const { next, replier } = replyPlan
  const replierName = nameOf(castView, replier)
  // Everyone the send's round has reply, in turn (DESIGN §2.3): "Mira", "Mira and Tobin", "Mira, Tobin and Wren".
  const roundNames =
    replier === null ? null : listNames([replier, ...replyPlan.round].map((id) => nameOf(castView, id) ?? "?"))
  // Only known when the window reaches the leaf; otherwise the server takes the message anyway.
  const leaf = view.newer === null ? view.entries.at(-1) : undefined
  const leafGenerating = leaf?.version.status === "generating"
  // "Who replies next" (DESIGN §2.3): with it on, the decision model picks Auto's replies when it
  // has two or more present characters to choose from, but whoever spoke last (the server's rule).
  const nextDecisionOn = useDecisionPointOn("next")
  const lastSpeaker = sendText.trim() !== "" || hasImages ? speaker : (leaf?.version.speakerEntityId ?? null)
  const decides =
    nextDecisionOn &&
    replyPlan.auto &&
    (cast?.participants.filter(
      (id) =>
        !cast.playedByMe.includes(id) &&
        !cast.absent.includes(id) &&
        !(cast.away ?? []).includes(id) &&
        id !== lastSpeaker
    ).length ?? 0) >= 2
  const leafPick = leaf?.version.speakerPick
  const lastPick = leafPick?.by === "decision" ? { name: leafPick.name, confidence: leafPick.confidence } : undefined
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
  // Another way to send, while one takes it (threads' "To 2 threads", composerSendRoutes).
  const { route: sendRoute, hint: routeHint } = useSendRoute(session, view)

  /** The composer belongs to the fork shown (DESIGN §6.2). */
  useEffect(syncFork, [syncFork, view.forkId, view.leafSlotId, view.loading, view.opened])

  // The reply kept with the draft (a reload, another tab or device) opens the bar here too.
  useEffect(() => {
    if (!choice.loaded || draftId === null || choice.draftId !== draftId || view.loading) return
    editor.follow(choice.guidanceSlot, view)
  }, [editor, choice.loaded, choice.draftId, choice.guidanceSlot, draftId, view])

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
    [choices, setError]
  )

  /**
   * Who `{{user}}` is from here on (DESIGN §2.2), the Cast tab's one write: definitions swap,
   * the history keeps its names. Speaking as the persona went on speaking as them, it goes on
   * speaking as the new one.
   */
  const choosePersona = useCallback(
    async (card: CastCard) => {
      const before = cast?.playedByMe[0] ?? null
      if (card.entityId === before) return
      const outcome = await session.changeCast({ _tag: "Persona", entityId: card.entityId })
      setError(outcome.ok ? null : outcome.error)
      if (outcome.ok && choice.speaker !== null && choice.speaker === before)
        void choices.change({ speaker: card.entityId }).then((picked) => setError(picked.ok ? null : picked.error))
    },
    [cast, session, choice.speaker, choices, setError]
  )
  const listCards = useCallback(() => session.listCards(), [session])
  const persona = cast?.playedByMe[0] ?? null
  const personas = useMemo(
    () => ({ current: persona, listCards, onPick: (card: CastCard) => void choosePersona(card) }),
    [persona, listCards, choosePersona]
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
      // The text submitted decides, should it differ from the box the preview read.
      const plan = planReply(
        cast,
        turnEntries,
        speaker,
        pickedReply,
        from.text,
        (captured?.images.length ?? 0) > 0,
        choice.noReplies
      )
      try {
        // For the decision model to choose (the server asks it only if two or more can reply).
        const autoPick = nextDecisionOn && plan.auto
        const { sent, outcome, draft, recovered } =
          sendRoute !== null
            ? await sendRoute.send({
                session,
                view: session.snapshot(),
                text: from.text,
                speaker,
                plan,
                autoPick,
                decides: nextDecisionOn,
                composer: from,
                images: captured?.images,
                imageDraftIds: captured?.ids
              })
            : await session.send(
                from.text,
                speaker,
                plan.replier,
                from,
                plan.reply,
                captured?.images,
                captured?.ids,
                plan.round,
                autoPick
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
    const outcome = await session.generate(
      session.snapshot().leafSlotId,
      replier,
      "",
      undefined,
      replyPlan.round,
      nextDecisionOn && replyPlan.auto
    )
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
  const replies = replyPlan.round.length > 0 ? "reply" : "replies"
  // With the decision model choosing (DESIGN §2.3), Auto's plan is only its fallback: not named.
  const sendLabel = hasText
    ? name
      ? `Send as ${name}`
      : "Send"
    : decides
      ? "Get a reply"
      : replierName
        ? `${roundNames ?? replierName} ${replies}`
        : "Send"
  // Send shows only with guidance off, so Enter is always its key.
  const sendHint = hasText
    ? `${sendLabel}${routeHint}${
        decides
          ? ", then the decision model chooses who replies"
          : roundNames
            ? `, then ${roundNames} ${replies}`
            : choice.noReplies
              ? ", with no reply"
              : ""
      }.${submitKey}`
    : decides
      ? `Pass the turn: the decision model chooses who replies next.${submitKey}`
      : roundNames
        ? `Pass the turn: ${roundNames} ${replies} next.${submitKey}`
        : "Type a message to send."
  // Generate writes the speaker's turn: for a card the user plays, the model writes it for them.
  const editedName = editing === null ? null : nameOf(castView, editing.speakerEntityId)
  // Keep the action named while the cast is loading; the full name includes its speaker.
  const generateText =
    editing !== null ? "New swipe" : name ? `Generate ${name}` : cast === null ? "Generate …" : "Generate"
  // "For you" only for the user's own card: another character's turn is theirs (owner, 2026-11-23).
  const generateHint =
    editing !== null
      ? `Generate a new swipe of ${editedName ? `${editedName}'s` : "this"} reply following this guidance. This swipe isn't affected.${submitKey}`
      : `Let the model write ${name === null ? "the" : `${name}'s`} next turn${speakerPlayed ? " for you" : ""}${
          guidance && hasText ? ", following your guidance" : ""
        }.${guidance ? submitKey : ""}`
  const shownError = error ?? saveError ?? viewPrefs.error

  const controls: ComposerControlContext = {
    draft: {
      append: (text) => draft.type(draft.snapshot().text + text)
    },
    typed,
    compact: phone,
    recoverQueued: (withdrawn, images) => {
      if (images?.length) attachmentInput?.restore(images)
      const current = draft.snapshot().text
      draft.type(current === "" ? withdrawn : withdrawn === "" ? current : `${current}\n\n${withdrawn}`)
    },
    session,
    view,
    onSettings,
    speaker: {
      speaker,
      recent: switcherRecent,
      onPick,
      personas,
      onAddToChat: () => {
        // The Cast tab, its Add characters open with the search focused (castAddState.ts).
        requestCastAdd()
        onSettings("cast")
      }
    },
    recent: recent.map((id) => ({
      id,
      name: nameOf(castView, id) ?? "?",
      mediaId: castView.cards.get(id)?.avatarMediaId ?? null,
      crop: castView.cards.get(id)?.avatarCrop
    })),
    onRecent: setPicked,
    guidance,
    speakerName: name,
    editingGuidance: editing !== null,
    // While a reply's guidance is edited, the box is guidance whatever the toggle says.
    prefsReady: viewPrefs.ready && textReady && editing === null,
    changeGuidance: (next) => {
      void choices.change({ guidance: next }).then((result) => setError(result.ok ? null : result.error))
    },
    hint:
      editing !== null
        ? `Guidance for ${editedName ? `${editedName}'s` : "this"} reply: each submit (${submitHint}) makes a new swipe of it with this text, and so does its › past the last swipe; the swipes it has keep their own. ✕ above goes back to your draft.`
        : guidance
          ? `One-turn guidance for ${name ? `${name}'s` : "the"} next message (${submitHint}) or Continue. It leaves the box when you submit it; a new swipe of a reply uses that reply's own guidance.`
          : "What you type is sent as your message. Turn guidance on to have it guide the model's next message instead.",
    reply: {
      candidates: faces,
      muted: cast?.absent ?? [],
      away: cast?.away ?? [],
      next,
      round: replyPlan.round,
      picked: pickedReply,
      noReplies: choice.noReplies,
      loading: turnEntries === null,
      decides,
      ...(lastPick ? { lastPick } : {}),
      // Auto and No one stay until another choice; a character is picked for one reply on top.
      onPick: (pick) =>
        void choices
          .change(
            pick === NO_ONE
              ? { replyFrom: null, noReplies: true }
              : pick === null
                ? { replyFrom: null, noReplies: false }
                : { replyFrom: pick }
          )
          .then(report)
    },
    leaf,
    leafGenerating,
    busy,
    ready,
    hasText,
    replier,
    round: replyPlan.round,
    generateText,
    generateWord: editing !== null ? "New swipe" : "Generate",
    generateHint,
    sendLabel,
    sendHint,
    generate,
    send,
    replyNow,
    history: <History draft={draft} disabled={editing !== null} />,
    report
  }
  const onKeyDown = composerKeyDown(
    () => invokeComposerControl(guidance ? "composer.generate" : "composer.send", controls, "keyboard"),
    viewPrefs.prefs.enterSends
  )
  const placeholder =
    editing !== null
      ? "Guidance for this reply…"
      : !textReady
        ? "Loading…"
        : guidance
          ? "Guidance for the next message…"
          : leafGenerating
            ? "Queue…"
            : "Message…"
  const hasAttachments = !!attachmentInput?.count
  const empty = text === ""
  // Compared by value, so typing reconfigures nothing: `data-empty` changes only as the box empties or fills.
  const contentAttributes: Record<string, string> = {
    "data-testid": "composer",
    "aria-busy": String(!textReady),
    // What the text is for, read with the box (a description by id can't reach into the editor's
    // shadow root); the guidance switch's tooltip shows it.
    "aria-description": controls.hint,
    ...(hasAttachments ? { "data-has-attachments": "true" } : {}),
    ...(empty ? { "data-empty": "true" } : {})
  }

  return (
    <div
      ref={composerRef}
      className="@container chat-column flex flex-col gap-1.5 border-t border-border pt-2 pb-2 max-sm:px-2"
    >
      {/* Sent while a reply is written, posting after it: between the messages and the box. */}
      <ComposerControls placement="queue" context={controls} />
      <ComposerBox
        guidance={guidance}
        header={
          <>
            <ComposerControls placement="banner" context={controls} />
            {conflict && (
              <ReplayNotice
                conflict={conflict}
                acknowledge={() => draft.acknowledgeConflict()}
                switchText={() => draft.switchConflict()}
              />
            )}
          </>
        }
        attachments={attachmentInput?.editor}
        start={
          <>
            {/* Who's speaking, and the speakers used last: one tap each (DESIGN §2.2). */}
            <ComposerControls placement="speaker" context={controls} />
            <ComposerControls placement="tools" context={controls} />
            {attachmentInput?.action}
          </>
        }
        end={<ComposerControls placement="actions" context={controls} />}
      >
        {/* The message editor's box (`message.text-editor`), named on itself: two frames can each
            show a composer. Guidance is plain; only the styling changes with it, nothing else. */}
        <div data-composer-text className="grid min-w-0">
          <SlotOutlet
            key={draftId}
            slot={messageTextEditor}
            props={{
              label: guidance ? "Guidance" : "Message",
              value: text,
              base: "",
              bare: true,
              plain: guidance,
              textActions: false,
              readOnly: !textReady,
              placeholder,
              contentAttributes,
              surfaceClass: `composer-text text-base sm:text-sm${guidance ? "" : " composer-message"}`,
              onKeyDown,
              onBlur: typed.flush,
              hostFiles: attachmentData,
              onChange: (value) => draft.type(value)
            }}
          />
        </div>
      </ComposerBox>
      {shownError && (
        <p role="alert" className="text-sm text-danger">
          {shownError.message}
        </p>
      )}
      {/* The next reply, which follows what's typed: what it uses and who writes it, as chips;
          one row, scrolled sideways on a phone. */}
      <StripRow scroll={phone}>
        <ComposerControls placement="strip" context={controls} />
      </StripRow>
    </div>
  )
}
