import { useMediaPermit } from "./externalMedia.tsx"
import { messageTextEditor } from "./editorHistory.tsx"
import { forgetThinking, messageEditorThinking, thinkingKey, useThinkingOpen } from "./editThinking.tsx"
import {
  EditControls,
  editKeys,
  editSelection,
  EditStatus,
  InPlaceText,
  saveEdit as runSave,
  useDraftLoaded,
  useEditSource
} from "./InPlaceEdit.tsx"
// One message: who wrote it (avatar and name, with the registered message details: time and
// model in the header, number, generation time and tokens under the portrait;
// messageDetails.tsx), its versions (swipe through them, pick one in the version picker, or
// generate another, on any message: DESIGN §3.1), its text, whether it's sent to the
// model and why not, and what can be done with it. The actions show on hover or focus on
// a wide screen, and on a tap of the message on a narrow one. Rows only re-render when
// their slot changes; the text of a generating version comes from its own atom, so a token
// re-renders the body.
import { positionOf } from "./position.ts"
import { useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { ForkId, PathEntry, SlotId, ThinkingPart, Version } from "@dreamspan/shared/chat.ts"
import {
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import type { AppError } from "../../errors.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { type CaretSpot, caretSpotAt, type EditCaret, locateEditCaret } from "../../ui/editCaret.ts"
import { MessageBody } from "../../ui/messageCopy.tsx"
import { HtmlMessageContext } from "../../ui/html/messageHtml.ts"
import { HtmlTextField } from "./htmlTextField.tsx"
import { Composition } from "./Composition.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { messageSide, useCast } from "./cast.ts"
import { deleteOffersFor, invokeMessageAction, messageActions, MessageActions } from "./messageActions.tsx"
import { ReasoningPanels } from "./Reasoning.tsx"
import { useDisplayContext } from "./DisplaySettings.tsx"
import { type DisplayAt, useDisplayed } from "./useDisplayed.ts"
import { OFF, usePanelPermit } from "./panelPermits.ts"
import { MessageDetails, useMessageDetails } from "./messageDetails.tsx"
import type { MessageDraft, MessageEditorKey } from "./messageDraft.ts"
import { useMountedTracking, useRenderCount } from "./perf.ts"
import { type ChatSession, liveText, type Outcome, resumeKind, waitingCache } from "./session.ts"
import { stepVersion } from "./versionNavigation.ts"
import {
  messageDirections,
  messageHeaderDetails,
  messageVersions,
  messagePreviews,
  messageSelect,
  useVersionNavigation,
  versionFailureActions
} from "./presentation.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { ChatDensityContext } from "./ChatDensity.tsx"

/** A horizontal drag this long on a message swipes to the next or previous version. */
const SWIPE_PX = 60

/** Why a message isn't sent to the model, as the list works it out (null: it is). */
export interface ContextMark {
  readonly kind: "dropped" | "summarized"
  readonly reason: string
}

/**
 * A message's text as it displays (useDisplayed.ts), live or finished: one component for both,
 * so a reply that just finished goes on showing its streamed display until the final one is
 * ready. Template text's macros resolve against the chat's state at its position (DESIGN
 * §5.6): a greeting's `{{user}}` is whoever the user played before it, so it follows a persona
 * change until a message is sent after it, and a later change doesn't rewrite it.
 */
function BodyText({
  version,
  session,
  parentSlotId,
  depth,
  placement,
  text,
  streaming
}: DisplayAt & { placement: 1 | 2; text: string; streaming: boolean }) {
  const shown = useDisplayed({ version, session, parentSlotId, depth }, text, placement, streaming)
  // A message body: its HTML's styles join the chat's, and its panels know their depth from the
  // tip, as display regex does (ui/html/messageHtml.ts).
  const { leafDepth } = useDisplayContext()
  const fromTip = leafDepth === null ? null : Math.max(0, leafDepth - depth)
  // Its panels run their scripts once its sources allowed them (panelPermits.ts).
  const permit = usePanelPermit(version.speakerEntityId, placement)
  const media = useMediaPermit(version.speakerEntityId, placement)
  // The permit is about the current sources: text a previous preset or card wrote, shown
  // while the display worker prepares the current text, runs no scripts under it.
  const current = shown.current
  const html = useMemo(
    () => ({
      key: version.slotId,
      slotId: version.slotId,
      streaming,
      fromTip,
      media: current ? media : { ...media, scope: null, actions: [] },
      ...(permit ? { permit: current ? permit : OFF } : {}),
      // What's typed into its HTML's text fields is kept per version (htmlTextField.tsx).
      versionId: version.id,
      TextField: HtmlTextField
    }),
    [version.slotId, version.id, streaming, fromTip, media, permit, current]
  )
  return (
    <HtmlMessageContext value={html}>
      <MessageBody text={text}>
        {shown.pending ? (
          // Its place kept, not shown, until the display scripts answer.
          <div className="invisible" aria-hidden>
            <Markdown text={shown.text ?? ""} sourceText={text} streaming={streaming} />
          </div>
        ) : (
          <Markdown text={shown.text ?? ""} sourceText={text} streaming={streaming} />
        )}
      </MessageBody>
      {shown.issues.map((issue, i) => (
        <p key={i} role="note" className="text-xs text-muted">
          {issue}
        </p>
      ))}
    </HtmlMessageContext>
  )
}

const RESUME_COPY = {
  resume: {
    label: "Resume",
    hint: "Carries this reply on from where it stopped, as a new version, with the model and settings the chat has now. Nothing new is written for you."
  },
  continue: {
    label: "Continue",
    hint: "Continues the text it stopped in, as a new version, with the model and settings the chat has now."
  },
  retry: {
    label: "Retry",
    hint: "Asks the model for this reply again, as a new version, with the model and settings the chat has now."
  }
} as const

/**
 * Stays visible beside every stopped, interrupted or failed reply, named for what it does
 * (`resumeKind`): Resume for an agent reply, Continue for plain text, Retry when there's none.
 */
function ResumeButton({ version, onResume }: { version: Version; onResume: () => void }) {
  const copy = RESUME_COPY[resumeKind(version)]
  return (
    <Button variant="secondary" className="ml-auto" hint={copy.hint} onClick={onResume}>
      {copy.label}
    </Button>
  )
}

/**
 * What happened to a reply, with its button on the right, centred on the text; where the
 * text needs the width, the button goes under it on the right.
 */
function StatusRow({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="min-w-[min(100%,16rem)] flex-1 [overflow-wrap:anywhere]">{text}</p>
      {action}
    </div>
  )
}

/** An edit open in a version's body. */
interface BodyEdit {
  /** Its text box once its saved text is read (null until then: the text stays), given the text's height as it opened. */
  readonly text: ((height: number | null) => ReactNode) | null
  /** Its thinking field (editThinking.tsx), above the text. */
  readonly thinking: ReactNode
  /** Whether that field stands in for the thinking panels now (opened, changed or removed). */
  readonly thinkingOpen: boolean
}

function VersionBody({
  version,
  session,
  hiddenThinking,
  parentSlotId,
  depth,
  placement,
  speakerName,
  onResume,
  edit
}: {
  version: Version
  session: ChatSession
  /** An edit open in its text's place (InPlaceEdit.tsx). */
  edit?: BodyEdit | undefined
  /** Who wrote it, for a pass's line ("Mira stays silent"). */
  speakerName: string
  /** Its thinking the user hid from the model here (SetThinkingHidden). */
  hiddenThinking?: ReadonlyArray<ThinkingPart> | undefined
  parentSlotId: SlotId | null
  depth: number
  placement: 1 | 2
  /** For a reply that failed or was interrupted: carries it on. */
  onResume?: (() => void) | undefined
}) {
  const live = useAtomValue(liveText(version.id))
  const waiting = useAtomValue(waitingCache(version.id))
  useRenderCount("bodyRenders", live !== null ? "liveBodyRenders" : undefined)
  useMountedTracking(version.id)
  const generating = version.status === "generating"
  const text = live ?? version.content
  // An edit in the text's place (InPlaceEdit.tsx) is as tall as the text was when it opened: its
  // height is read in the layout of the render that opens it, before the edit is drawn, and
  // the text stays mounted under it, hidden, to show again as it was when the edit closes.
  // Opened with the row (a reload, a row scrolled back), there was no text on screen to match.
  const textBox = useRef<HTMLDivElement>(null)
  const [held, setHeld] = useState<{ readonly height: number | null } | null>(() =>
    edit === undefined ? null : { height: null }
  )
  if (edit === undefined && held !== null) setHeld(null)
  useLayoutEffect(() => {
    if (edit !== undefined && held === null)
      setHeld({ height: textBox.current?.getBoundingClientRect().height ?? null })
  }, [edit, held])
  const editText = edit?.text && held !== null ? edit.text(held.height) : null
  return (
    <div className="flex flex-col gap-2 compact:gap-1">
      {/* Its thinking panels stay as they are in an edit, until its thinking field stands in for them. */}
      <div className="contents" hidden={edit?.thinkingOpen}>
        <ReasoningPanels
          version={version}
          session={session}
          hiddenThinking={hiddenThinking}
          parentSlotId={parentSlotId}
          depth={depth}
        />
      </div>
      {edit?.thinking}
      {editText}
      <div ref={textBox} className="flex flex-col gap-2 compact:gap-1" hidden={editText !== null}>
        {text === "" && generating ? (
          <p className="text-sm text-muted" aria-live="polite">
            {waiting ? "Waiting for the cache…" : "Writing…"}
          </p>
        ) : version.mark === "silent" && text === "" ? (
          // A pass (spec/REPLY-CONTRACT.md §3.1): never invisible, and another version is a reply.
          <p data-silent className="text-sm text-muted italic">
            {speakerName} stays silent
          </p>
        ) : (
          <BodyText
            version={version}
            session={session}
            parentSlotId={parentSlotId}
            depth={depth}
            placement={placement}
            text={text}
            streaming={generating}
          />
        )}
      </div>
      {version.mark === "refused" && (
        <p role="note" className="text-sm text-muted">
          {version.status === "failed"
            ? "A judge model read what was written instead of a reply and found it a refusal."
            : "A judge model found this reply a refusal. Its text is kept; › generates another version to try again."}
        </p>
      )}
      {version.status === "failed" && version.error && (
        <div
          role="note"
          className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <StatusRow
            text={`Failed (${version.error.class}): ${version.error.message}`}
            action={onResume && <ResumeButton version={version} onResume={onResume} />}
          />
          <SlotOutlet slot={versionFailureActions} props={{ version }} />
        </div>
      )}
      {(version.status === "interrupted" || version.status === "stopped") && onResume && (
        <div
          role="note"
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-text"
        >
          <StatusRow
            text={
              version.status === "stopped"
                ? "This reply was stopped."
                : "The app stopped while this reply was being written."
            }
            action={<ResumeButton version={version} onResume={onResume} />}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The editor of a version of the user's own, under the version shown (Composition.tsx). Its
 * text is a server draft kept by the session (messageDraft.ts), so scrolling the message away
 * or reloading the page doesn't lose it, and the editor opens again where it was. An edit of a
 * version opens in its text's place instead (InPlaceEdit.tsx).
 */
function WriteEditor({
  draft,
  session,
  entry,
  onScrollIntoView,
  onSave,
  onSaveWith,
  onCancel
}: {
  draft: MessageDraft
  session: ChatSession
  entry: PathEntry
  onScrollIntoView: () => void
  onSave: () => void
  onSaveWith: (after: (text: string) => Promise<void>) => void
  onCancel: () => void
}) {
  const { text, loading, error, added } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  // The editor opens where the message is: when its text takes focus the first time, Save
  // and Cancel under it come into view too, with the caret at the end just above them.
  const actions = useRef<HTMLDivElement>(null)
  const revealed = useRef(false)
  return (
    <form
      className="flex flex-col gap-2"
      onFocus={() => {
        if (revealed.current) return
        revealed.current = true
        if (actions.current) {
          actions.current.scrollIntoView({ block: "nearest" })
          onScrollIntoView()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        runSave(session, onSave)
      }}
      {...editKeys(session, onSave, onCancel)}
    >
      {loading ? (
        <p role="status">
          Loading saved text…{" "}
          {error && (
            <Button type="button" onClick={() => void draft.open()} hint="Loads the saved edit before you type.">
              Retry
            </Button>
          )}
        </p>
      ) : (
        <SlotOutlet
          slot={messageTextEditor}
          props={{
            label: "Your version",
            value: text,
            base: "",
            // Opened from the chat's other view, it leaves focus there (Composition.tsx).
            autoFocus: !draft.mirror,
            quietMarkers: true,
            // Text just added to your version: marked and scrolled to, focus left where it is.
            flash: added,
            // In place in the chat, already as wide as the message: no Open large.
            expand: false,
            onChange: (value) => draft.setText(value)
          }}
        />
      )}
      {!loading && <EditStatus draft={draft} base="" />}
      <div ref={actions}>
        <EditControls
          draft={draft}
          base={loading ? undefined : ""}
          source={undefined}
          session={session}
          entry={entry}
          saveLabel="Add as a new version"
          offerSaves={false}
          onSave={onSave}
          onSaveWith={onSaveWith}
          onCancel={onCancel}
          layout="row"
        />
      </div>
    </form>
  )
}

/** A slot's versions, read once it has more than one and again when they change. */
function useVersions(session: ChatSession, entry: PathEntry, report: (outcome: Outcome<unknown>) => void) {
  const [versions, setVersions] = useState<ReadonlyArray<Version> | null>(null)
  useEffect(
    () =>
      session.subscribeVersions((version) => {
        if (version.slotId === entry.slotId)
          setVersions((list) => list?.map((v) => (v.id === version.id ? version : v)) ?? list)
      }),
    [session, entry.slotId]
  )
  const multiple = entry.versionCount > 1
  // Refresh when the selected record changes, including a generation finishing in place.
  const position =
    versions !== null && versions.length === entry.versionCount
      ? versions.findIndex(
          (v) =>
            v.id === entry.version.id &&
            (entry.version.status === "generating" || v.rowVersion === entry.version.rowVersion) &&
            v.status === entry.version.status
        )
      : -1
  const stale = multiple && position < 0
  useEffect(() => {
    if (!stale) return
    let live = true
    void session.listVersions(entry.slotId).then((result) => {
      if (live && result.ok) setVersions(result.value)
    })
    return () => {
      live = false
    }
  }, [
    stale,
    session,
    entry.slotId,
    entry.versionCount,
    entry.version.id,
    entry.version.rowVersion,
    entry.version.status
  ])
  const load = async (fresh = false) => {
    if (position >= 0 && !fresh && versions!.every((version) => version.status !== "generating")) return versions
    const result = await session.listVersions(entry.slotId)
    if (!result.ok) {
      report(result)
      return null
    }
    setVersions(result.value)
    return result.value
  }
  /** A version as a write returned it, in its place in the list. */
  const replace = (version: Version) =>
    setVersions((list) => list?.map((v) => (v.id === version.id ? version : v)) ?? list)
  return { versions: position >= 0 ? versions : null, position, load, replace }
}

/** Where this message sits among the alternate branches of the story here (DESIGN §3.2). */
function Branches({ entry, onBranch }: { entry: PathEntry; onBranch: (entry: PathEntry, index: number) => void }) {
  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-border compact:sm:pointer-fine:[&_button]:size-6"
      role="group"
      aria-label={`Branches: ${entry.branchIndex + 1} of ${entry.branchCount}`}
      data-layout-audit-ignore="inset: Joined branch controls share a single outer border"
    >
      <IconButton
        label="Previous branch"
        icon="left"
        className="size-7"
        disabled={entry.branchIndex === 0}
        onClick={() => onBranch(entry, entry.branchIndex - 1)}
      />
      <Tooltip label={`Branch ${entry.branchIndex + 1} of ${entry.branchCount} at this message`}>
        <span tabIndex={0} className="flex items-center gap-1 px-0.5 text-xs text-muted tabular-nums outline-none">
          <Icon name="branch" size={13} />
          {entry.branchIndex + 1}/{entry.branchCount}
        </span>
      </Tooltip>
      <IconButton
        label="Next branch"
        icon="right"
        className="size-7"
        disabled={entry.branchIndex === entry.branchCount - 1}
        onClick={() => onBranch(entry, entry.branchIndex + 1)}
      />
    </div>
  )
}

/** A mark for whether the message is sent: an icon with its name, and why in a tooltip. */
function Mark({
  icon,
  name,
  label,
  reason,
  className = "",
  compact = false
}: {
  icon: IconName
  name: string
  label: string
  reason: string
  className?: string
  /** Only the icon: for a mark most messages of a long chat carry, which the edge already shows. */
  compact?: boolean
}) {
  return (
    <Tooltip label={reason}>
      <span
        tabIndex={0}
        className={`inline-flex shrink-0 items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
      >
        <span role="img" aria-label={name}>
          <Icon name={icon} size={14} />
        </span>
        <span className={compact ? "sr-only" : undefined}>{label}</span>
        <span className="sr-only">: {reason}</span>
      </span>
    </Tooltip>
  )
}

/** The session's editor at `key`; the row re-renders only when that one opens or closes. */
const useEditor = (session: ChatSession, key: MessageEditorKey) =>
  useSyncExternalStore(
    session.subscribeEditors,
    useCallback(() => session.editor(key), [session, key])
  )

/** Whether a double-click may open Edit here: not on a control, the version arrows or an image. */
const canEditFrom = (target: EventTarget | null) =>
  !onControl(target) &&
  !(target instanceof Element && target.closest("[role='group'][aria-label='Versions'], [data-text-tool], img, label"))

/** Whether a click or tap landed on something that acts on its own. */
const onControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest("button, a, input, textarea, select, summary, [role='menuitem']")

/** A double-click this close to its first press is on the spot pressed. */
const SAME_SPOT_PX = 8

/** A third click within this long of a double-click selects a paragraph instead of editing. */
const TRIPLE_CLICK_MS = 450

/**
 * Whether a touch starting at `target` may be a swipe: not on a control, and not in an editor
 * (a CodeMirror editor's contenteditable, any textbox), where a drag moves the caret or selects.
 */
const swipeCanStart = (target: EventTarget | null) =>
  !onControl(target) &&
  !(
    target instanceof Element &&
    target.closest("[contenteditable]:not([contenteditable='false']), [role='textbox'], .cm-editor, label")
  )

export const Message = memo(function Message({
  entry,
  session,
  context,
  revealed,
  onReveal,
  branchFork,
  onBranch,
  onScrollIntoView
}: {
  entry: PathEntry
  session: ChatSession
  /** Why it isn't sent to the model, when it was left out or summarized (not hidden). */
  context: ContextMark | null
  /** Its actions are shown on a narrow screen, after a tap. */
  revealed: boolean
  /** Shows its actions (or hides them, given null) on a narrow screen. */
  onReveal: (slotId: SlotId | null) => void
  /** The fork shown, when it isn't the chat's current one: links keep to it. */
  branchFork: ForkId | null
  /** Switches to another of the alternate branches at this message. */
  onBranch: (entry: PathEntry, index: number) => void
  /** Native scrolling precedes its scroll event; update the list before rows measure. */
  onScrollIntoView: () => void
}) {
  useRenderCount("rowRenders")
  const density = useContext(ChatDensityContext)
  const cast = useCast()
  const { version } = entry
  const [error, setError] = useState<AppError | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  /** The last touch was a swipe, so the click it ends in isn't a tap. */
  const swiped = useRef(false)
  const footer = useRef<HTMLDivElement>(null)
  const generating = version.status === "generating"
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)
  const { versions, position, load, replace } = useVersions(session, entry, report)
  const editEditor = useSyncExternalStore(
    session.subscribeEditors,
    useCallback(
      () => session.editForSlot(entry.slotId, versions ?? [version]),
      [session, entry.slotId, versions, version]
    )
  )
  // Drafts restored after reload learn their slot from the versions read above.
  // Keep that association while a later import's version list is still loading.
  useEffect(() => {
    if (editEditor !== undefined) session.bindEditor(editEditor, entry.slotId)
  }, [session, editEditor, entry.slotId])
  const writeEditor = useEditor(session, `write:${entry.slotId}`)
  const editor = writeEditor ?? editEditor
  const editing = writeEditor ? "write" : editEditor ? "edit" : null
  const editingAnotherVersion = editEditor?.target._tag === "Edit" && editEditor.target.versionId !== version.id
  /** The edit open in the text's place, if any (InPlaceEdit.tsx). */
  const inPlace = editing === "edit" ? editEditor : undefined
  const { source: editSource, base: editBase } = useEditSource(session, entry, inPlace, [version, ...(versions ?? [])])
  const editLoaded = useDraftLoaded(inPlace)
  const thinkingOpen = useThinkingOpen(session, inPlace, editSource)
  // A fresh one per edit, so an edit never starts with the last one's selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selection = useMemo(() => editSelection(), [inPlace])
  // Edits and versions the user writes keep the message's speaker; older ones may have none,
  // and then another version's names it, or the first version's, deleted or not, so deleting
  // the original never makes a character's message the model's.
  const speakerId =
    version.speakerEntityId ??
    versions?.find((v) => v.speakerEntityId !== null)?.speakerEntityId ??
    entry.firstSpeakerEntityId
  const speaker = speakerId === null ? undefined : cast.cards.get(speakerId)
  // Its side as the context reads it (stages.ts `sideOf`): a card the user plays speaks on
  // the user's side, another of the cast on the model's, else the message's own, which its
  // first version sets whichever versions are live (PathEntry.side).
  const side = messageSide(entry, cast.cast, speakerId)
  const model = side === "assistant"
  // A model writes its versions: a reply, or a turn on the user's side the model wrote (an
  // impersonation), so its › generates another, written as its speaker.
  const generated = model || version.writer === "model" || versions?.at(-1)?.writer === "model"
  const name = speaker?.name ?? (model ? "Model" : "You")
  // "Who replies next" (DESIGN §2.3): until the decision model has chosen, the reply names no one,
  // since the speaker it holds meanwhile is only Auto's fallback.
  const choosing = generating && version.speakerPick?.by === "auto"
  const deleted = useDeletedToast()
  /** A delete says so, with Undo (DESIGN §6.2). */
  const toast = (outcome: Outcome<BinItem>) => {
    report(outcome)
    if (outcome.ok)
      deleted(
        outcome.value,
        undefined,
        deleteOffersFor({ entry, session, deleted: (item) => deleted(item) }, outcome.value)
      )
  }

  const defaultStep = (step: -1 | 1) => stepVersion(entry, session, !!generated, report, step, load)
  const versionNavigation = useVersionNavigation()
  const swipe = (step: -1 | 1) => versionNavigation?.step?.({ entry, session, defaultStep }, step)
  const flag = async (target: Version, flags: { starred?: boolean; hidden?: boolean }) => {
    const outcome = await session.setVersionFlags(target, flags)
    report(outcome)
    if (outcome.ok) replace(outcome.value)
  }

  // The version picker, its sheet and its dialogs are portals: their events reach this
  // article through React, but a drag or a tap in them is no swipe or tap on the message.
  const outside = (event: PointerEvent | MouseEvent) => !event.currentTarget.contains(event.target as Node)
  // Never while the message is being edited, nor from an editor or a control in it; a text
  // selection made by the drag, or a cancelled pointer (the browser scrolled), is no swipe.
  const onPointerDown = (event: PointerEvent) => {
    swipeStart.current =
      // Writing your own version, the versions above it still swipe (Composition.tsx).
      event.pointerType === "touch" && editing !== "edit" && !outside(event) && swipeCanStart(event.target)
        ? { x: event.clientX, y: event.clientY }
        : null
  }
  const onPointerCancel = () => void (swipeStart.current = null)
  // A double-click opens Edit, with the caret where it landed. It waits out a triple-click,
  // which selects a paragraph, and a double-click drag, which selects words, to copy them.
  const pendingEdit = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [caretAt, setCaretAt] = useState<EditCaret | undefined>(undefined)
  // Only the edit it opened starts there: a later Edit opens with the caret at the end.
  const caretTaken = useCallback(() => setCaretAt(undefined), [])
  useEffect(() => () => clearTimeout(pendingEdit.current ?? undefined), [])
  // What the wait may have changed: the edit opens only on the version double-clicked, still
  // finished and not already being edited.
  const now = useRef({ editing, generating, versionId: version.id })
  useEffect(() => {
    now.current = { editing, generating, versionId: version.id }
  })
  // Where a press landed, read before its click can move the text (ui/editCaret.ts): a
  // double-click's caret is the spot its first click pressed.
  const pressed = useRef<{ x: number; y: number; spot: CaretSpot | null } | null>(null)
  // Any press after the double-click (a triple-click's third, or another action begun within
  // the wait) is the user doing something else.
  const onMouseDown = (event: MouseEvent) => {
    if (event.detail <= 1 && !editing)
      pressed.current = { x: event.clientX, y: event.clientY, spot: caretSpotAt(event.clientX, event.clientY) }
    if (pendingEdit.current === null) return
    clearTimeout(pendingEdit.current)
    pendingEdit.current = null
  }
  const onDoubleClick = (event: MouseEvent) => {
    if (editing || generating || outside(event) || !canEditFrom(event.target)) return
    const context = { entry, session, branchFork, generated, generating, hidden, report, toast }
    if (messageActions.get("message.edit")?.available?.(context) === false) return
    // The caret where it landed in the stored text (ui/editCaret.ts), else at the end.
    const first = pressed.current
    const spot =
      first?.spot?.point.node.isConnected &&
      Math.hypot(first.x - event.clientX, first.y - event.clientY) <= SAME_SPOT_PX
        ? first.spot
        : caretSpotAt(event.clientX, event.clientY)
    const caret = (spot && locateEditCaret(spot, version.content)) ?? undefined
    clearTimeout(pendingEdit.current ?? undefined)
    const versionId = version.id
    pendingEdit.current = setTimeout(() => {
      pendingEdit.current = null
      const current = now.current
      if (current.editing || current.generating || current.versionId !== versionId) return
      if (/\s/.test(window.getSelection()?.toString().trim() ?? "")) return
      setCaretAt(caret)
      void invokeMessageAction("message.edit", context, "button")
    }, TRIPLE_CLICK_MS)
  }
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start || editing === "edit" || window.getSelection()?.toString()) return
    const dx = event.clientX - start.x
    swiped.current = Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(event.clientY - start.y)
    if (swiped.current) void swipe(dx < 0 ? 1 : -1)
  }
  // On a narrow screen a tap on the message shows its actions; on a wide one they show on hover.
  const onClick = (event: MouseEvent) => {
    if (swiped.current) return void (swiped.current = false)
    if (editing || outside(event) || onControl(event.target) || !window.matchMedia("(max-width: 639px)").matches) return
    if (window.getSelection()?.toString()) return
    onReveal(revealed ? null : entry.slotId)
  }
  // A tap shows the actions at the end of the message, which may be past the screen's edge. A
  // double-click's first click is a tap too: the view waits for a second, and stays where it
  // is for the edit it opens.
  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => {
      if (!footer.current || pendingEdit.current !== null || now.current.editing) return
      footer.current.scrollIntoView({ block: "nearest" })
      onScrollIntoView()
    }, TRIPLE_CLICK_MS)
    return () => clearTimeout(timer)
  }, [revealed, onScrollIntoView])

  const latest = useSyncExternalStore(
    session.subscribe,
    useCallback(() => {
      const view = session.snapshot()
      return view.newer === null && view.entries.at(-1)?.slotId === entry.slotId
    }, [session, entry.slotId])
  )
  /** After an edit saved as a new version, its number, so the counter's jump says why. */
  const [savedAs, setSavedAs] = useState<number | null>(null)
  useEffect(() => {
    if (savedAs === null) return
    const timer = setTimeout(() => setSavedAs(null), 6000)
    return () => clearTimeout(timer)
  }, [savedAs])

  const hidden = entry.contextExcluded
  // Who hid it: the user here (SetMessageHidden), else it came hidden from an ST import.
  const hiddenReason = entry.hiddenByUser
    ? "Hidden: you hid it from the model, so it isn't sent. To send it again: More actions → Show to the model again."
    : `Hidden: not sent to the model.${version.origin === "imported" ? " It came hidden with the import." : ""}`
  const empty = !hidden && !entry.inContext && !generating && version.status !== "failed" && context === null
  const reason = hidden
    ? hiddenReason
    : context !== null
      ? context.reason
      : empty
        ? "Empty: there's no text to send to the model."
        : null

  const actionContext = { entry, session, branchFork, generated, generating, hidden, report, toast }
  const details = useMessageDetails()
  const detailProps = { entry, session, generating, reply: model }

  let marks: ReactNode = null
  if (hidden)
    marks = <Mark icon="ghost" name="Hidden from context" label="Hidden" reason={hiddenReason} className="text-muted" />
  else if (context?.kind === "summarized")
    marks = (
      <Mark
        icon="summary"
        name="Summarized: a summary stands in for this message"
        label="Summarized"
        reason={context.reason}
        className="text-accent"
        compact
      />
    )
  else if (context?.kind === "dropped")
    marks = (
      <Mark
        icon="dropped"
        name="Not in the context"
        label="Out of context"
        reason={context.reason}
        className="text-muted"
      />
    )
  else if (empty)
    marks = <Mark icon="dropped" name="Not in the context" label="Not sent" reason={reason!} className="text-muted" />

  const bodyEdit: BodyEdit | undefined = inPlace && {
    text:
      editLoaded && editBase !== undefined
        ? (height) => (
            <InPlaceText
              draft={inPlace}
              base={editBase}
              height={height}
              caret={caretAt}
              onCaretTaken={caretTaken}
              onCaretPlaced={onScrollIntoView}
              onFirstFocus={() => {
                // Opened by Edit: its controls under the text come into view with its end.
                footer.current?.scrollIntoView({ block: "nearest" })
                onScrollIntoView()
              }}
              selection={selection}
            />
          )
        : null,
    // An edit's thinking, above its text as the thinking panel is above the reply (editThinking.tsx).
    thinking: (
      <SlotOutlet slot={messageEditorThinking} props={{ session, entry, draft: inPlace, source: editSource }} />
    ),
    thinkingOpen
  }
  const versionBody = (
    <VersionBody
      version={version}
      session={session}
      edit={bodyEdit || undefined}
      hiddenThinking={entry.hiddenThinking}
      parentSlotId={entry.parentSlotId}
      depth={positionOf(entry)}
      placement={model ? 2 : 1}
      speakerName={name}
      onResume={
        version.writer === "model" &&
        (version.status === "failed" || version.status === "interrupted" || version.status === "stopped")
          ? () => void session.resumeReply(entry).then(report)
          : undefined
      }
    />
  )
  // The version controls: in the footer, or in the bar over the version shown while composing.
  const versionControls = (
    <SlotOutlet
      slot={messageVersions}
      props={{
        entry,
        generated,
        latest,
        versions,
        position,
        onStep: (step) => void swipe(step),
        onPick: async (picked) => report(await session.select(entry, picked)),
        onFlag: (target, flags) => void flag(target, flags),
        onOpen: () => void load(true)
      }}
    />
  )
  /** Saves the editor's text; then `after`, a save option's (messageSaveOptions), with that text. */
  const saveEdit = async (after?: (text: string) => Promise<void>) => {
    if (editor === undefined) return
    // Saving an open edit names its original source, even if an import
    // selected another version while its draft save was still in flight.
    // Its revision must be fresh: the version list can still be cached
    // after another tab amended a human version without changing the count.
    const target = editor.target
    const source =
      target._tag === "Edit" ? (await load(true))?.find((candidate) => candidate.id === target.versionId) : undefined
    if (target._tag === "Edit" && source === undefined) return
    // The edit's thinking field (editThinking.tsx), saved with its text.
    const thinkingEditor = target._tag === "Edit" ? session.editor(thinkingKey(target.versionId)) : undefined
    const submitted = await editor.ready()
    const thought = thinkingEditor === undefined ? undefined : await thinkingEditor.ready()
    const { text, draft, images } = submitted
    const outcome =
      editing === "edit"
        ? await session.edit(
            { ...entry, version: source! },
            text,
            draft,
            images,
            thought && { text: thought.text, draft: thought.draft }
          )
        : await session.writeVersion(entry, text, draft, images)
    report(outcome)
    if (!outcome.ok) return
    if (thinkingEditor !== undefined && thought !== undefined && thinkingEditor.committed(thought)) {
      if (thought.draft === null) await thinkingEditor.discard()
      session.closeEditor(thinkingEditor)
      if (target._tag === "Edit") forgetThinking(target.versionId)
    }
    await after?.(text)
    // An edit of a generated version, or of one being written, is saved as a new one; so is
    // your own version, which shows where it went among the many it was composed from.
    if (editing === "write" || source!.writer !== "human" || source!.status === "generating")
      setSavedAs((outcome.value as PathEntry).versionCount)
    // Text typed while it was being saved stays in the editor, which stays open.
    if (!editor.committed(submitted)) return
    // Saved without naming its draft (it didn't hold exactly this text): it's ended unsaved.
    if (draft === null) await editor.discard()
    session.closeEditor(editor)
  }

  const cancelEdit = async () => {
    if (editor === undefined) return
    // Its text goes to the bin's recovered texts, never nowhere (DESIGN §6.2).
    const target = editor.target
    const thinkingEditor = target._tag === "Edit" ? session.editor(thinkingKey(target.versionId)) : undefined
    const thought = thinkingEditor === undefined ? undefined : await thinkingEditor.discard()
    if (thought !== undefined && !thought.ok) return report(thought)
    const outcome = await editor.discard()
    report(outcome)
    if (!outcome.ok) return
    if (thinkingEditor !== undefined) session.closeEditor(thinkingEditor)
    if (target._tag === "Edit") forgetThinking(target.versionId)
    session.closeEditor(editor)
  }
  const onSave = () => void saveEdit()
  const onCancel = () => void cancelEdit()
  const onSaveWith = (after: (text: string) => Promise<void>) => void saveEdit(after)

  // An edit in its text's place (InPlaceEdit.tsx): its text box in the body, its controls in the footer row.
  const editControls = inPlace && (
    <EditControls
      draft={inPlace}
      base={editBase}
      source={editSource}
      session={session}
      entry={entry}
      saveLabel="Save"
      offerSaves
      onSave={onSave}
      onSaveWith={onSaveWith}
      onCancel={onCancel}
      selection={selection}
      layout="footer"
    />
  )
  const writeView = editing === "write" && writeEditor !== undefined && (
    <WriteEditor
      draft={writeEditor}
      session={session}
      entry={entry}
      onScrollIntoView={onScrollIntoView}
      onSave={onSave}
      onSaveWith={onSaveWith}
      onCancel={onCancel}
    />
  )

  // In a compact list an edit's footer stays where the footer lies (over the message's corner), taking no room.
  const keepFooter = latest || generating || revealed || editing === "write" || savedAs !== null

  return (
    <article
      onFocusCapture={(event) => {
        if (
          density === "compact" &&
          !revealed &&
          window.matchMedia("(max-width: 639px)").matches &&
          event.target.matches(":focus-visible")
        )
          onReveal(entry.slotId)
      }}
      aria-label={model ? "Reply" : "Your message"}
      data-slot={entry.slotId}
      data-summarized={context?.kind === "summarized" || undefined}
      data-out-of-context={context?.kind === "dropped" || undefined}
      data-hidden={hidden || undefined}
      className={`group flex touch-pan-y gap-3 rounded-lg border px-3 py-2.5 max-sm:gap-2.5 max-sm:px-2.5 compact:relative compact:py-2 ${
        context?.kind === "dropped" ? "text-muted border-dashed " : ""
      }${context?.kind === "summarized" ? "border-l-4 border-l-accent/50 " : ""}${
        context?.kind === "dropped"
          ? "border-border"
          : model
            ? "border-transparent hover:bg-surface-raised/40"
            : "border-transparent bg-surface-raised"
      }`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {/* Its tick while messages are selected to delete together (selection/). */}
      <SlotOutlet slot={messageSelect} props={{ entry, session }} />
      {/* The portrait, with its number, generation time and tokens under it, as in ST. */}
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        {choosing ? (
          <Avatar id="" name="?" size="chat" className="mt-0.5" />
        ) : (
          <Avatar
            id={speakerId ?? (model ? "model" : "you")}
            name={name}
            mediaId={speaker?.avatarMediaId ?? null}
            crop={speaker?.avatarCrop}
            size="chat"
            preview
            className={`mt-0.5 ${hidden ? "opacity-50 grayscale" : ""}`}
          />
        )}
        <div
          data-portrait-details
          className={`flex w-(--chat-portrait-width,60px) flex-col items-center gap-0.5 text-center text-[11px] leading-tight text-muted tabular-nums empty:hidden [overflow-wrap:anywhere] ${
            hidden ? "opacity-60" : ""
          }`}
        >
          <MessageDetails details={details.portrait} {...detailProps} />
        </div>
      </div>
      <div
        className={`message-content flex min-w-0 flex-1 flex-col gap-1 compact:gap-0.5 ${hidden ? "opacity-60" : ""}`}
        // An edit in place: its keys, and an image pasted or dropped on it is the edit's (images.tsx).
        data-message-edit={inPlace ? "" : undefined}
        {...(inPlace ? editKeys(session, onSave, onCancel) : {})}
      >
        {/* A chat in a narrow column (the workshop in a story's panel, `@container/chat`) wraps as a phone's does. */}
        <header className="flex min-h-8 min-w-0 items-center compact:min-h-6 gap-x-2 text-sm max-sm:flex-wrap max-sm:gap-y-1 @max-[30rem]/chat:flex-wrap @max-[30rem]/chat:gap-y-1">
          {choosing ? (
            <span
              data-choosing-speaker
              className="min-w-0 text-muted italic max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:shrink-0"
            >
              Choosing who replies…
            </span>
          ) : (
            <span
              data-layout-name
              className="min-w-0 font-semibold max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:max-w-48 sm:shrink-0 sm:truncate"
            >
              {name}
            </span>
          )}
          {/* Its time and model (messageDetails.tsx), as the user chose to show them. */}
          <MessageDetails details={details.header} {...detailProps} />
          {
            // A turn on the user's side the model wrote says so, as a reply the user wrote does.
            version.writer === "model" && version.model === null && !model && (
              <span className="shrink-0 text-xs text-muted">generated</span>
            )
          }
          {version.origin === "edited" && <span className="shrink-0 text-xs text-muted">edited</span>}
          {version.origin === "user_written" && model && (
            <span className="shrink-0 text-xs text-muted">written by you</span>
          )}
          <SlotOutlet slot={messageHeaderDetails} props={{ entry, session, generating }} />
          {(version.status === "stopped" || version.status === "interrupted") && (
            <Badge tone="warning">{version.status}</Badge>
          )}
          {version.status === "failed" && <Badge tone="danger">failed</Badge>}
          {generating && <Badge tone="accent">generating</Badge>}
          {version.mark === "refused" && <Badge tone="warning">refused</Badge>}
          {marks}
          {editing === "write" ? (
            <span className="flex-1" />
          ) : (
            // The rest of the header's width: the pinned buttons that fit, then More actions. While
            // the message is edited they keep their room, unseen, so the header stays as it was.
            <MessageActions
              context={actionContext}
              // In a narrow column it keeps room for More actions, on a line of its own if need be.
              // Compact, with a mouse: the buttons are as tall as the slimmer name row (24 px).
              className={`hidden justify-end transition-opacity duration-100 sm:flex @max-[30rem]/chat:min-w-8 compact:sm:pointer-fine:[&_a]:size-6 compact:sm:pointer-fine:[&_button]:size-6 ${
                inPlace
                  ? "invisible"
                  : revealed
                    ? "opacity-100"
                    : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:opacity-100"
              }`}
            />
          )}
          {entry.branchCount > 1 && <Branches entry={entry} onBranch={onBranch} />}
        </header>
        {editingAnotherVersion && (
          <p role="note" className="text-sm text-muted">
            Another version is selected. Your edit still belongs to the version you opened.
          </p>
        )}
        <SlotOutlet slot={messagePreviews} props={{ entry, session }} />
        {writeView ? (
          // Writing your own version: the version shown stays above it (DESIGN §3.1).
          <Composition
            entry={entry}
            draft={writeEditor!}
            text={version.content}
            versions={versionControls}
            source={versionBody}
          >
            {writeView}
          </Composition>
        ) : (
          versionBody
        )}
        {inPlace && <EditStatus draft={inPlace} base={editBase} />}
        {version.context !== null && version.context.issues.length > 0 && (
          // What the user should know about the context it was generated from (ARCHITECTURE §15).
          <details className="text-xs text-warning">
            <Tooltip label="Shows context warnings for this reply.">
              <summary className="cursor-pointer">
                {version.context.issues.length === 1 ? "1 note" : `${version.context.issues.length} notes`} on its
                context
              </summary>
            </Tooltip>
            <ul className="mt-1 list-disc pl-5">
              {version.context.issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </details>
        )}
        <SlotOutlet slot={messageDirections} props={{ entry, session }} />
        {generating && (
          // The version's Stop (DESIGN §3.1: it belongs to the version), at the end of what's
          // being written and held at the bottom of the view while any of the reply shows, so a
          // reply longer than the screen never takes it out of reach.
          <div
            data-layout-overlay="Stop stays over the reply while the timeline scrolls"
            className="pointer-events-none sticky bottom-2 z-10 flex justify-end"
          >
            <Tooltip label="Stop writing this reply; what it wrote is kept. A round after it stops too: Continue round goes on with it.">
              <Button
                variant="secondary"
                className="pointer-events-auto h-8 shrink-0 px-3 shadow-sm max-sm:h-10"
                onClick={async () => report(await session.stop(version.id))}
              >
                <Icon name="stop" size={12} />
                Stop
              </Button>
            </Tooltip>
          </div>
        )}
        {/*
          Version controls keep their room even before a second version exists. Compact spacing
          (styles.css `.message-footer`) takes that room back: the controls lie over the message's
          corner while it's pointed at or holds focus, and on a phone come with its actions after a
          tap. `data-keep` leaves them in place where they're in use or would be missed.
        */}
        <div
          ref={footer}
          className="message-footer flex flex-col gap-1"
          data-keep={keepFooter || undefined}
          data-editing={inPlace ? "" : undefined}
          data-layout-overlay={
            density === "compact" && !keepFooter
              ? "Compact version controls occupy the message's reserved lower corner"
              : undefined
          }
          data-layout-audit-ignore={
            density === "compact" && !keepFooter
              ? "inset: Joined compact version controls share their backing border"
              : undefined
          }
        >
          {revealed && editing !== "write" && reason !== null && (
            <p className="text-xs text-muted sm:hidden">{reason}</p>
          )}
          <footer className="flex min-h-8 items-center">
            {editControls ? (
              // An edit's Save, Cancel and tools, where the message's actions are on a phone (InPlaceEdit.tsx).
              editControls
            ) : revealed && !editing ? (
              // The footer's width before the versions: the pinned buttons that fit, then More actions.
              <MessageActions context={actionContext} className="-ml-1.5 flex sm:hidden" />
            ) : (
              <span className="flex-1" />
            )}
            {savedAs !== null && (
              <span role="status" className="mx-1 text-xs text-muted">
                Saved as version {savedAs}
              </span>
            )}
            {editing !== "write" && (
              // On a phone an edit's controls take the row: its version can't change while it's edited there.
              <div className={`contents ${inPlace ? "max-sm:hidden" : ""}`}>{versionControls}</div>
            )}
          </footer>
        </div>
        {error && (
          <div role="alert" className="flex flex-col gap-2 text-sm text-danger">
            <p>{error.message}</p>
            {error.tag === "NotResumable" && error.reason === "saved_request" && (
              <Button
                variant="secondary"
                className="self-start"
                hint="Sends the request this reply stopped with, unchanged: the context, model and tools it had then, not the chat's settings now."
                onClick={() => void session.resumeVersion(entry, { saved: true }).then(report)}
              >
                Send the saved request
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  )
})
