import { useMediaPermit } from "./externalMedia.tsx"
import { messageEditorTools, messageTextEditor } from "./editorHistory.tsx"
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
import type { BinItem } from "@rp/shared/bin.ts"
import type { ForkId, PathEntry, SlotId, Version } from "@rp/shared/chat.ts"
import {
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
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
import { MessageBody, sourceOffsetAt } from "../../ui/messageCopy.tsx"
import { HtmlMessageContext } from "../../ui/html/messageHtml.ts"
import { Composition } from "./Composition.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { messageSide, useCast } from "./cast.ts"
import { invokeMessageAction, messageActions, MessageActions } from "./messageActions.tsx"
import { ReasoningPanels } from "./Reasoning.tsx"
import { useDisplayContext } from "./DisplaySettings.tsx"
import { type DisplayAt, useDisplayed } from "./useDisplayed.ts"
import { OFF, usePanelPermit } from "./panelPermits.ts"
import { MessageDetails, useMessageDetails } from "./messageDetails.tsx"
import type { MessageDraft, MessageEditorKey } from "./messageDraft.ts"
import { useMountedTracking, useRenderCount } from "./perf.ts"
import { type ChatSession, liveText, type Outcome, waitingCache } from "./session.ts"
import { stepVersion } from "./versionNavigation.ts"
import {
  availableCommands,
  chatCommands,
  invokeChatCommand,
  runCommandShortcut,
  type ChatCommandContext
} from "./commands.tsx"
import {
  messageDirections,
  messageHeaderDetails,
  messageVersions,
  messagePreviews,
  useVersionNavigation,
  versionFailureActions
} from "./presentation.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { popupOpen } from "../../ui/openPopups.ts"

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
      streaming,
      fromTip,
      media: current ? media : { ...media, scope: null, actions: [] },
      ...(permit ? { permit: current ? permit : OFF } : {})
    }),
    [version.slotId, streaming, fromTip, media, permit, current]
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

function VersionBody({
  version,
  session,
  parentSlotId,
  depth,
  placement
}: {
  version: Version
  session: ChatSession
  parentSlotId: SlotId | null
  depth: number
  placement: 1 | 2
}) {
  const live = useAtomValue(liveText(version.id))
  const waiting = useAtomValue(waitingCache(version.id))
  useRenderCount("bodyRenders", live !== null ? "liveBodyRenders" : undefined)
  useMountedTracking(version.id)
  const generating = version.status === "generating"
  const text = live ?? version.content
  return (
    <div className="flex flex-col gap-2">
      <ReasoningPanels version={version} session={session} parentSlotId={parentSlotId} depth={depth} />
      {text === "" && generating ? (
        <p className="text-sm text-muted" aria-live="polite">
          {waiting ? "Waiting for the cache…" : "Writing…"}
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
      {version.mark === "refused" && (
        <p role="note" className="text-sm text-muted">
          A judge model found this reply a refusal. Its text is kept; › generates another version to try again.
        </p>
      )}
      {version.status === "failed" && version.error && (
        <div role="note" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          <p>
            Failed ({version.error.class}): {version.error.message}
          </p>
          <SlotOutlet slot={versionFailureActions} props={{ version }} />
        </div>
      )}
    </div>
  )
}

/**
 * A message's editor: an edit of its original source, or a version of the user's own. Its
 * text is a server draft kept by the session (messageDraft.ts), so scrolling the message
 * away or reloading the page doesn't lose it, and the editor opens again where it was.
 */
function Editor({
  draft,
  label,
  saveLabel,
  source,
  session,
  entry,
  caret,
  onCaretTaken,
  onScrollIntoView,
  onSave,
  onCancel
}: {
  draft: MessageDraft
  label: string
  saveLabel: string
  source: Version | undefined
  session: ChatSession
  entry: PathEntry
  /** Where the caret opens (a double-click's place in the text), else at the end. */
  caret?: number | undefined
  onCaretTaken: () => void
  onScrollIntoView: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const { text, loading, error, conflict, imagesBusy, added } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  // The editor may mount after the saved text loads: it still opens at the first caret.
  const [initialCaret] = useState(caret)
  useEffect(() => {
    if (initialCaret !== undefined) onCaretTaken()
  }, [initialCaret, onCaretTaken])
  const [original, setOriginal] = useState<Version | undefined>(source)
  useEffect(() => {
    if (draft.target._tag !== "Edit" || source) return
    let live = true
    const id = draft.target.versionId
    void session.listVersions(entry.slotId).then((result) => {
      if (live && result.ok) setOriginal(result.value.find((version) => version.id === id))
    })
    return () => {
      live = false
    }
  }, [session, entry.slotId, draft, source])
  const base =
    draft.target._tag === "Edit"
      ? (source ?? (original?.id === draft.target.versionId ? original : undefined))?.content
      : ""

  const commandSnapshot = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot, chatCommands.snapshot)
  // The editor opens where the message is: when its text takes focus the first time, Save
  // and Cancel under it come into view too, with the caret at the end just above them.
  const actions = useRef<HTMLDivElement>(null)
  const revealed = useRef(false)
  const commands: ChatCommandContext = {
    session,
    view: session.snapshot(),
    onHistory: () => {},
    onJump: () => {},
    saveMessageEdit: onSave
  }
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
        invokeChatCommand("message.save", commands)
      }}
      onKeyDownCapture={(event) => {
        // Handle Save before CodeMirror's Mod+Enter binding inserts a blank line.
        if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          runCommandShortcut(event.nativeEvent, commands)
        ) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onKeyDown={(event) => {
        // A modal can open before its focus effect moves focus off this form's
        // trigger. Escape belongs to that modal, even when its target is here.
        if (
          event.key === "Escape" &&
          event.currentTarget.contains(event.target as Node) &&
          !event.defaultPrevented &&
          !popupOpen()
        )
          onCancel()
      }}
    >
      {loading || base === undefined ? (
        <p role="status">
          Loading saved text…{" "}
          {loading && error && (
            <Button type="button" onClick={() => void draft.open()} hint="Loads the saved edit before you type.">
              Retry
            </Button>
          )}
        </p>
      ) : (
        <SlotOutlet
          slot={messageTextEditor}
          props={{
            label,
            value: text,
            base,
            // Opened from the chat's other view, it leaves focus there (Composition.tsx).
            autoFocus: !draft.mirror,
            caret: initialCaret,
            quietMarkers: true,
            // Text just added to your version: marked and scrolled to, focus left where it is.
            flash: added,
            // In place in the chat, already as wide as the message: no Open large.
            expand: false,
            onChange: (value) => draft.setText(value)
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          The text isn’t saved as a draft yet: {error.message}
        </p>
      )}
      {conflict && (
        <ReplayNotice
          conflict={conflict}
          acknowledge={() => draft.acknowledgeConflict()}
          switchText={() => draft.switchConflict()}
        />
      )}
      <div ref={actions} className="flex flex-wrap items-center gap-2">
        <Tooltip label={`${saveLabel} (Ctrl+Enter)`}>
          <Button
            type="submit"
            variant="primary"
            disabled={
              imagesBusy ||
              !availableCommands(commands, commandSnapshot).some((command) => command.id === "message.save")
            }
          >
            <Icon name="check" />
            {saveLabel}
          </Button>
        </Tooltip>
        <Button
          onClick={onCancel}
          hint={
            draft.target._tag === "Write"
              ? "Closes the editor without adding a message version."
              : "Closes the message editor without saving."
          }
        >
          <Icon name="close" />
          Cancel
        </Button>
        <span className="flex-1" />
        {base !== undefined && (
          <SlotOutlet
            slot={messageEditorTools}
            props={{
              draft,
              base,
              images:
                (draft.target._tag === "Edit"
                  ? (source ?? (original?.id === draft.target.versionId ? original : undefined))?.images
                  : entry.version.images) ?? []
            }}
          />
        )}
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
      className="flex shrink-0 items-center rounded-md border border-border"
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

/** The browser's caret at a point, as a text position. */
const caretFromPoint = (x: number, y: number): { node: Node; offset: number } | null => {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

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
  const cast = useCast()
  const { version } = entry
  const [error, setError] = useState<AppError | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  /** The last touch was a swipe, so the click it ends in isn't a tap. */
  const swiped = useRef(false)
  const footer = useRef<HTMLDivElement>(null)
  // A tap shows the actions at the end of the message, which may be past the screen's edge.
  useEffect(() => {
    if (revealed && footer.current) {
      footer.current.scrollIntoView({ block: "nearest" })
      onScrollIntoView()
    }
  }, [revealed, onScrollIntoView])
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
    if (outcome.ok) deleted(outcome.value)
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
  const [caretAt, setCaretAt] = useState<number | undefined>(undefined)
  // Only the edit it opened starts there: a later Edit opens with the caret at the end.
  const caretTaken = useCallback(() => setCaretAt(undefined), [])
  useEffect(() => () => clearTimeout(pendingEdit.current ?? undefined), [])
  // What the wait may have changed: the edit opens only on the version double-clicked, still
  // finished and not already being edited.
  const now = useRef({ editing, generating, versionId: version.id })
  useEffect(() => {
    now.current = { editing, generating, versionId: version.id }
  })
  // Any press after the double-click (a triple-click's third, or another action begun within
  // the wait) is the user doing something else.
  const onMouseDown = () => {
    if (pendingEdit.current === null) return
    clearTimeout(pendingEdit.current)
    pendingEdit.current = null
  }
  const onDoubleClick = (event: MouseEvent) => {
    if (editing || generating || outside(event) || !canEditFrom(event.target)) return
    const context = { entry, session, branchFork, generated, generating, hidden, report, toast }
    if (messageActions.get("message.edit")?.available?.(context) === false) return
    const point = caretFromPoint(event.clientX, event.clientY)
    const mapped = point && sourceOffsetAt(point.node, point.offset)
    const offset = mapped?.text === version.content ? mapped.offset : undefined
    clearTimeout(pendingEdit.current ?? undefined)
    const versionId = version.id
    pendingEdit.current = setTimeout(() => {
      pendingEdit.current = null
      const current = now.current
      if (current.editing || current.generating || current.versionId !== versionId) return
      if (/\s/.test(window.getSelection()?.toString().trim() ?? "")) return
      setCaretAt(offset)
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

  const versionBody = (
    <VersionBody
      version={version}
      session={session}
      parentSlotId={entry.parentSlotId}
      depth={positionOf(entry)}
      placement={model ? 2 : 1}
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
  const editorView = editor !== undefined && (
    <Editor
      key={editing}
      draft={editor}
      session={session}
      entry={entry}
      caret={editing === "edit" ? caretAt : undefined}
      onCaretTaken={caretTaken}
      onScrollIntoView={onScrollIntoView}
      source={
        editor.target._tag === "Edit"
          ? [version, ...(versions ?? [])].find(
              (item) => item.id === (editor.target._tag === "Edit" ? editor.target.versionId : null)
            )
          : undefined
      }
      {...(editing === "edit"
        ? { label: "Message text", saveLabel: "Save" }
        : {
            label: "Your version",
            saveLabel: "Add as a new version"
          })}
      onCancel={async () => {
        // Its text goes to the bin's recovered texts, never nowhere (DESIGN §6.2).
        const outcome = await editor.discard()
        report(outcome)
        if (outcome.ok) session.closeEditor(editor)
      }}
      onSave={async () => {
        // Saving an open edit names its original source, even if an import
        // selected another version while its draft save was still in flight.
        // Its revision must be fresh: the version list can still be cached
        // after another tab amended a human version without changing the count.
        const target = editor.target
        const source =
          target._tag === "Edit"
            ? (await load(true))?.find((candidate) => candidate.id === target.versionId)
            : undefined
        if (target._tag === "Edit" && source === undefined) return
        const submitted = await editor.ready()
        const { text, draft, images } = submitted
        const outcome =
          editing === "edit"
            ? await session.edit({ ...entry, version: source! }, text, draft, images)
            : await session.writeVersion(entry, text, draft, images)
        report(outcome)
        if (!outcome.ok) return
        // An edit of a generated version, or of one being written, is saved as a new one; so is
        // your own version, which shows where it went among the many it was composed from.
        if (editing === "write" || source!.writer !== "human" || source!.status === "generating")
          setSavedAs((outcome.value as PathEntry).versionCount)
        // Text typed while it was being saved stays in the editor, which stays open.
        if (!editor.committed(submitted)) return
        // Saved without naming its draft (it didn't hold exactly this text): it's ended unsaved.
        if (draft === null) await editor.discard()
        session.closeEditor(editor)
      }}
    />
  )

  return (
    <article
      aria-label={model ? "Reply" : "Your message"}
      data-slot={entry.slotId}
      data-summarized={context?.kind === "summarized" || undefined}
      data-out-of-context={context?.kind === "dropped" || undefined}
      data-hidden={hidden || undefined}
      className={`group flex touch-pan-y gap-3 rounded-lg border px-3 py-2.5 max-sm:gap-2.5 max-sm:px-2.5 ${
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
      <div className={`flex min-w-0 flex-1 flex-col gap-1 ${hidden ? "opacity-60" : ""}`}>
        {/* A chat in a narrow column (the workshop in a story's panel, `@container/chat`) wraps as a phone's does. */}
        <header className="flex min-h-8 min-w-0 items-center gap-x-2 text-sm max-sm:flex-wrap max-sm:gap-y-1 @max-[30rem]/chat:flex-wrap @max-[30rem]/chat:gap-y-1">
          {choosing ? (
            <span
              data-choosing-speaker
              className="min-w-0 text-muted italic max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:shrink-0"
            >
              Choosing who replies…
            </span>
          ) : (
            <span className="min-w-0 font-semibold max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:max-w-48 sm:shrink-0 sm:truncate">
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
          {editing ? (
            <span className="flex-1" />
          ) : (
            // The rest of the header's width: the pinned buttons that fit, then More actions.
            <MessageActions
              context={actionContext}
              // In a narrow column it keeps room for More actions, on a line of its own if need be.
              className={`hidden justify-end transition-opacity duration-100 sm:flex @max-[30rem]/chat:min-w-8 ${
                revealed
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
        {editor === undefined ? (
          versionBody
        ) : editing === "write" ? (
          // Writing your own version: the version shown stays above it (DESIGN §3.1).
          <Composition
            entry={entry}
            draft={editor}
            text={version.content}
            versions={versionControls}
            source={versionBody}
          >
            {editorView}
          </Composition>
        ) : (
          editorView
        )}
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
        {/* Version controls keep their room even before a second version exists. */}
        <div ref={footer} className="flex flex-col gap-1">
          {revealed && !editing && reason !== null && <p className="text-xs text-muted sm:hidden">{reason}</p>}
          <footer className="flex min-h-8 items-center">
            {revealed && !editing ? (
              // The footer's width before the versions: the pinned buttons that fit, then More actions.
              <MessageActions context={actionContext} className="-ml-1.5 flex sm:hidden" />
            ) : (
              <span className="flex-1" />
            )}
            {savedAs !== null && (
              <span role="status" className="mr-1 text-xs text-muted">
                Saved as version {savedAs}
              </span>
            )}
            {editing !== "write" && versionControls}
          </footer>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error.message}
          </p>
        )}
      </div>
    </article>
  )
})
