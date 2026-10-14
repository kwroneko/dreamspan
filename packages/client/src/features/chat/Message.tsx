// One message: who wrote it (avatar, name, time, its number on the path), its versions
// (swipe through them, pick one, or generate another), its text, whether it's sent to the
// model and why not, and what can be done with it. The actions show on hover or focus on
// a wide screen, and on a tap of the message on a narrow one. Rows only re-render when
// their slot changes; the text of a generating version comes from its own atom, so a token
// re-renders the body.
import { useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { PathEntry, SlotId, Version } from "@rp/shared/chat.ts"
import { Link } from "@tanstack/react-router"
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
import { Textarea } from "../../ui/Field.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Menu, MenuItem, MenuLinkItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { castView, nameOf, useCast } from "./cast.ts"
import { ContinueAction } from "./ContinueAction.tsx"
import { Reasoning } from "./Reasoning.tsx"
import { formatWhen } from "./chatTitle.ts"
import { displayText } from "./macros.ts"
import { parseModelValue, useModelChoices } from "./modelChoices.ts"
import type { MessageDraft, MessageEditorKey } from "./messageDraft.ts"
import { useMountedTracking, useRenderCount } from "./perf.ts"
import { type ChatSession, liveText, type Outcome, waitingCache } from "./session.ts"

/** A horizontal drag this long on a message swipes to the next or previous version. */
const SWIPE_PX = 60

const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" })

/** Why a message isn't sent to the model, as the list works it out (null: it is). */
export interface ContextMark {
  readonly kind: "dropped" | "summarized"
  readonly reason: string
}

/**
 * Text whose macros resolve against the chat's state at its position (DESIGN §5.6): a
 * greeting's `{{user}}` is whoever the user played before it, so it follows a persona
 * change until a message is sent after it, and a later change doesn't rewrite it. Only
 * such text reads the cast there; other messages render as before.
 */
function TemplateText({
  version,
  session,
  parentSlotId
}: {
  version: Version
  session: ChatSession
  parentSlotId: SlotId | null
}) {
  const cast = useCast()
  const read = useCallback(() => session.castAfter(parentSlotId), [session, parentSlotId])
  const positionCast = useSyncExternalStore(session.subscribePositions, read)
  // The speaker card's own fields, for `{{description}}` and the like, as the preview had them.
  const readFields = useCallback(
    () => (version.speakerEntityId === null ? undefined : session.cardFields(version.speakerEntityId)),
    [session, version.speakerEntityId]
  )
  const fields = useSyncExternalStore(session.subscribePositions, readFields)
  const here = useMemo(
    () => (positionCast ? castView(positionCast, [...cast.cards.values()]) : cast),
    [positionCast, cast]
  )
  // Random and time macros show what they drew when the greeting was first shown.
  const text = displayText(
    version.content,
    version.macroMode,
    { user: here.user, char: nameOf(here, version.speakerEntityId) ?? here.char },
    fields ?? {},
    version.frozenMacros ?? {}
  )
  return <Markdown text={text} streaming={false} />
}

/** "Retry with…" another model, for a reply that was refused. */
function RetryWith({ onPick }: { onPick: (model: ReturnType<typeof parseModelValue>) => void | Promise<void> }) {
  const models = useModelChoices(true)
  return (
    <div className="w-56">
      <Select
        items={models}
        value={null}
        placeholder="Retry with…"
        onValueChange={(value) => void onPick(parseModelValue(value))}
      />
    </div>
  )
}

function VersionBody({
  version,
  session,
  parentSlotId
}: {
  version: Version
  session: ChatSession
  parentSlotId: SlotId | null
}) {
  const live = useAtomValue(liveText(version.id))
  const waiting = useAtomValue(waitingCache(version.id))
  useRenderCount("bodyRenders", live !== null ? "liveBodyRenders" : undefined)
  useMountedTracking(version.id)
  const generating = version.status === "generating"
  const text = live ?? version.content
  return (
    <div className="flex flex-col gap-2">
      <Reasoning version={version} />
      {text === "" && generating ? (
        <p className="text-sm text-muted" aria-live="polite">
          {waiting ? "Waiting for the cache…" : "Writing…"}
        </p>
      ) : live === null && version.macroMode === "template" ? (
        <TemplateText version={version} session={session} parentSlotId={parentSlotId} />
      ) : (
        <Markdown text={text} streaming={generating} />
      )}
      {version.mark === "refused" && (
        <p role="note" className="text-sm text-muted">
          A judge model found this reply a refusal. Its text is kept; Regenerate to try again.
        </p>
      )}
      {version.status === "failed" && version.error && (
        <p role="note" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          Failed ({version.error.class}): {version.error.message}
        </p>
      )}
    </div>
  )
}

/**
 * A message's editor: an edit of the version shown, or a version of the user's own. Its
 * text is a server draft kept by the session (messageDraft.ts), so scrolling the message
 * away or reloading the page doesn't lose it, and the editor opens again where it was.
 */
function Editor({
  draft,
  label,
  saveLabel,
  placeholder,
  onSave,
  onCancel
}: {
  draft: MessageDraft
  label: string
  saveLabel: string
  placeholder?: string
  onSave: () => void
  onCancel: () => void
}) {
  const { text, error, conflict } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel()
      }}
    >
      <Textarea
        aria-label={label}
        value={text}
        placeholder={placeholder}
        className="max-h-[60vh] [field-sizing:content]"
        autoFocus
        onChange={(event) => draft.setText(event.currentTarget.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          The text isn’t saved as a draft yet: {error.message}
        </p>
      )}
      {conflict && (
        // No history to switch back from here: the other text stays one step back, and goes to
        // the recovered texts when the edit is saved or cancelled.
        <ReplayNotice conflict={conflict} acknowledge={() => draft.acknowledgeConflict()} />
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          <Icon name="check" />
          {saveLabel}
        </Button>
        <Button onClick={onCancel}>
          <Icon name="close" />
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** A slot's versions, read once it has more than one and again when they change. */
function useVersions(session: ChatSession, entry: PathEntry, report: (outcome: Outcome<unknown>) => void) {
  const [versions, setVersions] = useState<ReadonlyArray<Version> | null>(null)
  const multiple = entry.versionCount > 1
  // The list as read is current while it has as many versions as the slot, this one among them.
  const position =
    versions !== null && versions.length === entry.versionCount
      ? versions.findIndex((v) => v.id === entry.version.id)
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
  }, [stale, session, entry.slotId, entry.versionCount, entry.version.id])
  const load = async () => {
    if (position >= 0) return versions
    const result = await session.listVersions(entry.slotId)
    if (!result.ok) {
      report(result)
      return null
    }
    setVersions(result.value)
    return result.value
  }
  return { versions: position >= 0 ? versions : null, position, load }
}

const preview = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat === "" ? "(empty)" : flat.length > 90 ? `${flat.slice(0, 90)}…` : flat
}

/** `‹ 3/7 ›`: the versions of a message, with the list of them on the counter. */
function Versions({
  entry,
  model,
  versions,
  position,
  onStep,
  onPick,
  onOpen
}: {
  entry: PathEntry
  model: boolean
  versions: ReadonlyArray<Version> | null
  position: number
  onStep: (step: -1 | 1) => void
  onPick: (version: Version) => void
  onOpen: () => void
}) {
  const last = position === entry.versionCount - 1
  const counter = position >= 0 ? `${position + 1}/${entry.versionCount}` : `${entry.versionCount}`
  return (
    <div className="flex shrink-0 items-center" role="group" aria-label="Versions">
      <IconButton
        label="Previous version"
        icon="left"
        className="max-sm:size-7"
        disabled={entry.versionCount <= 1 || position === 0}
        onClick={() => onStep(-1)}
      />
      {entry.versionCount > 1 ? (
        <Menu
          align="end"
          label="Versions"
          trigger={
            <Tooltip label="Choose a version">
              <button
                type="button"
                aria-label={
                  position >= 0
                    ? `Version ${position + 1} of ${entry.versionCount}: choose a version`
                    : `${entry.versionCount} versions: choose one`
                }
                onPointerEnter={onOpen}
                onFocus={onOpen}
                className="h-8 min-w-9 rounded-md px-1 text-xs text-muted tabular-nums outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised"
              >
                {counter}
              </button>
            </Tooltip>
          }
        >
          {versions === null ? (
            <p className="px-2.5 py-1.5 text-sm text-muted">Loading the versions…</p>
          ) : (
            <MenuRadioGroup
              value={entry.version.id as string}
              onValueChange={(id) => {
                const picked = versions.find((v) => v.id === id)
                if (picked) onPick(picked)
              }}
            >
              {versions.map((v, i) => (
                <MenuRadioItem key={v.id} value={v.id as string}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs text-muted">
                      {i + 1}
                      {v.status !== "complete" ? ` · ${v.status}` : ""}
                      {v.origin === "edited" ? " · edited" : v.origin === "user_written" ? " · written by you" : ""}
                    </span>
                    <span className="line-clamp-2">{preview(v.content)}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </Menu>
      ) : (
        <span className="min-w-6 text-center text-xs text-muted tabular-nums">1/1</span>
      )}
      <IconButton
        label={model && (position === -1 || last) ? "Generate another version" : "Next version"}
        icon="right"
        className="max-sm:size-7"
        disabled={!model && (entry.versionCount <= 1 || last)}
        onClick={() => onStep(1)}
      />
    </div>
  )
}

/** Where this message sits among the alternate branches of the story here (DESIGN §3.2). */
function Branches({ entry, onBranch }: { entry: PathEntry; onBranch: (entry: PathEntry, index: number) => void }) {
  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-border"
      role="group"
      aria-label={`Branches: ${entry.branchIndex + 1} of ${entry.branchCount}`}
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
  className = ""
}: {
  icon: IconName
  name: string
  label: string
  reason: string
  className?: string
}) {
  return (
    <Tooltip label={reason}>
      <span tabIndex={0} className={`inline-flex shrink-0 items-center gap-1 text-xs outline-none ${className}`}>
        <span role="img" aria-label={name}>
          <Icon name={icon} size={14} />
        </span>
        <span>{label}</span>
        <span className="sr-only">: {reason}</span>
      </span>
    </Tooltip>
  )
}

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast({ title: `${what} copied` })
  } catch {
    showToast({ title: `Couldn't copy the ${what.toLowerCase()}`, description: "The browser didn't allow it." })
  }
}

/** The session's editor at `key`; the row re-renders only when that one opens or closes. */
const useEditor = (session: ChatSession, key: MessageEditorKey) =>
  useSyncExternalStore(
    session.subscribeEditors,
    useCallback(() => session.editor(key), [session, key])
  )

/** Whether a click or tap landed on something that acts on its own. */
const onControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest("button, a, input, textarea, select, summary, [role='menuitem']")

export const Message = memo(function Message({
  entry,
  session,
  highlighted,
  context,
  revealed,
  onReveal,
  branchLeaf,
  onBranch
}: {
  entry: PathEntry
  session: ChatSession
  highlighted: boolean
  /** Why it isn't sent to the model, when it was left out or summarized (not hidden). */
  context: ContextMark | null
  /** Its actions are shown on a narrow screen, after a tap. */
  revealed: boolean
  /** Shows its actions (or hides them, given null) on a narrow screen. */
  onReveal: (slotId: SlotId | null) => void
  /** The leaf of the branch shown, when it isn't the chat's active one: links keep to it. */
  branchLeaf: SlotId | null
  /** Switches to another of the alternate branches at this message. */
  onBranch: (entry: PathEntry, index: number) => void
}) {
  useRenderCount("rowRenders")
  const cast = useCast()
  const { version } = entry
  // An editor open on this message: one of the version shown, or one writing a version of its own.
  const editEditor = useEditor(session, `edit:${version.id}`)
  const writeEditor = useEditor(session, `write:${entry.slotId}`)
  const editor = writeEditor ?? editEditor
  const editing = writeEditor ? "write" : editEditor ? "edit" : null
  const [error, setError] = useState<AppError | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  /** The last touch was a swipe, so the click it ends in isn't a tap. */
  const swiped = useRef(false)
  const footer = useRef<HTMLDivElement>(null)
  // A tap shows the actions at the end of the message, which may be past the screen's edge.
  useEffect(() => {
    if (revealed) footer.current?.scrollIntoView({ block: "nearest" })
  }, [revealed])
  const generating = version.status === "generating"
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)
  const { versions, position, load } = useVersions(session, entry, report)
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
  const side =
    speakerId !== null && cast.cast?.playedByMe.includes(speakerId)
      ? "user"
      : speakerId !== null && cast.cast?.participants.includes(speakerId)
        ? "assistant"
        : entry.side
  const model = side === "assistant"
  const name = speaker?.name ?? (model ? "Model" : "You")
  const deleted = useDeletedToast()
  /** A delete says so, with Undo (DESIGN §6.2). */
  const toast = (outcome: Outcome<BinItem>) => {
    report(outcome)
    if (outcome.ok) deleted(outcome.value)
  }

  const swipe = async (step: -1 | 1) => {
    const all = entry.versionCount > 1 ? await load() : [version]
    if (all === null) return
    const index = all.findIndex((v) => v.id === version.id)
    const target = all[index + step]
    if (target) return report(await session.select(entry, target))
    // Past the last version of a reply, a swipe generates another, as in SillyTavern.
    if (step === 1 && model) report(await session.regenerate(entry))
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") swipeStart.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start) return
    const dx = event.clientX - start.x
    swiped.current = Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(event.clientY - start.y)
    if (swiped.current) void swipe(dx < 0 ? 1 : -1)
  }
  // On a narrow screen a tap on the message shows its actions; on a wide one they show on hover.
  const onClick = (event: MouseEvent) => {
    if (swiped.current) return void (swiped.current = false)
    if (editing || onControl(event.target) || !window.matchMedia("(max-width: 639px)").matches) return
    if (window.getSelection()?.toString()) return
    onReveal(revealed ? null : entry.slotId)
  }

  // Every reply has its arrows, to generate another; any message with versions, to step through them.
  const showVersions = model || entry.versionCount > 1
  const deleteLabel = entry.versionCount > 1 ? "Delete version" : "Delete message"
  const linkSearch = branchLeaf === null ? { slot: entry.slotId } : { leaf: branchLeaf, slot: entry.slotId }

  const hidden = entry.contextExcluded
  // Who hid it: the user here (SetMessageHidden), else it came hidden from an ST import.
  const hiddenReason = entry.hiddenByUser
    ? "Hidden: you hid it from the model, so it isn't sent. To send it again: More actions → Show to the model again."
    : `Hidden: not sent to the model.${version.origin === "imported" ? " It was hidden in SillyTavern." : ""}`
  const empty = !hidden && !entry.inContext && !generating && version.status !== "failed" && context === null
  const reason = hidden
    ? hiddenReason
    : context !== null
      ? context.reason
      : empty
        ? "Empty: there's no text to send to the model."
        : null

  const more = (
    <Menu
      align="end"
      label="More actions"
      trigger={
        <Tooltip label="More actions">
          <button type="button" aria-label="More actions" className={iconButtonClass()}>
            <Icon name="more" />
          </button>
        </Tooltip>
      }
    >
      <MenuItem icon="write" onClick={() => session.openEditor({ _tag: "Write", slotId: entry.slotId }, "")}>
        Write your own version
      </MenuItem>
      <MenuLinkItem
        icon="branch"
        render={<Link to="." search={{ leaf: entry.slotId }} onClick={() => session.startBranch(entry.slotId)} />}
      >
        Branch from here
      </MenuLinkItem>
      <MenuItem icon={hidden ? "eye" : "ghost"} onClick={async () => report(await session.setHidden(entry, !hidden))}>
        {hidden ? "Show to the model again" : "Hide from the model"}
      </MenuItem>
      <MenuItem icon="copy" onClick={() => void copy(session.textOf(version), "Text")}>
        Copy text
      </MenuItem>
      <MenuItem
        icon="link"
        onClick={() => {
          const url = new URL(`/chats/${session.id}`, window.location.origin)
          for (const [key, value] of Object.entries(linkSearch)) url.searchParams.set(key, value)
          void copy(url.toString(), "Link")
        }}
      >
        Copy link
      </MenuItem>
      {version.context !== null && (
        <MenuLinkItem
          icon="layers"
          render={
            <Link to="/chats/$chatId/context/$versionId" params={{ chatId: session.id, versionId: version.id }} />
          }
        >
          Context it was generated from
        </MenuLinkItem>
      )}
      {entry.versionCount > 1 && (
        <>
          <MenuSeparator />
          <MenuItem icon="trash" tone="danger" onClick={async () => toast(await session.deleteMessage(entry.slotId))}>
            Delete message (all {entry.versionCount} versions)
          </MenuItem>
        </>
      )}
    </Menu>
  )

  const actions = (
    <>
      {!generating && (
        <IconButton
          label="Edit"
          icon="edit"
          onClick={() => session.openEditor({ _tag: "Edit", versionId: version.id }, version.content)}
        />
      )}
      {model && (
        <IconButton
          label="Regenerate"
          icon="regenerate"
          onClick={async () => report(await session.regenerate(entry))}
        />
      )}
      <ContinueAction entry={entry} session={session} report={report} />
      <IconButton
        label={deleteLabel}
        icon="trash"
        tone="danger"
        onClick={async () =>
          toast(
            entry.versionCount > 1 ? await session.deleteVersion(version.id) : await session.deleteMessage(entry.slotId)
          )
        }
      />
      {more}
    </>
  )

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
        highlighted
          ? "border-accent bg-accent/5"
          : context?.kind === "dropped"
            ? "border-border"
            : model
              ? "border-transparent hover:bg-surface-raised/40"
              : "border-transparent bg-surface-raised"
      }`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <Avatar
        id={speakerId ?? (model ? "model" : "you")}
        name={name}
        mediaId={speaker?.avatarMediaId ?? null}
        size="lg"
        className={`mt-0.5 max-sm:size-8 ${hidden ? "opacity-50 grayscale" : ""}`}
      />
      <div className={`flex min-w-0 flex-1 flex-col gap-1 ${hidden ? "opacity-60" : ""}`}>
        <header className="flex min-h-8 min-w-0 items-center gap-x-2 text-sm max-sm:flex-wrap max-sm:gap-y-1">
          <span className="min-w-0 font-semibold max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:truncate">
            {name}
          </span>
          <Tooltip label={fullTime.format(version.createdAt)}>
            <time
              tabIndex={0}
              dateTime={new Date(version.createdAt).toISOString()}
              className="shrink-0 text-xs text-muted outline-none"
            >
              {formatWhen(version.createdAt)}
            </time>
          </Tooltip>
          <span className="shrink-0 text-xs text-muted tabular-nums">#{entry.depth + 1}</span>
          {version.origin === "edited" && <span className="shrink-0 text-xs text-muted">edited</span>}
          {version.origin === "user_written" && model && (
            <span className="shrink-0 text-xs text-muted">written by you</span>
          )}
          {(version.status === "stopped" || version.status === "interrupted") && (
            <Badge tone="warning">{version.status}</Badge>
          )}
          {version.status === "failed" && <Badge tone="danger">failed</Badge>}
          {generating && <Badge tone="accent">generating</Badge>}
          {version.mark === "refused" && <Badge tone="warning">refused</Badge>}
          {marks}
          <span className="flex-1" />
          {generating && (
            <Button
              variant="secondary"
              className="h-7 shrink-0 px-2"
              onClick={async () => report(await session.stop(version.id))}
            >
              <Icon name="stop" size={12} />
              Stop
            </Button>
          )}
          {!editing && (
            <div
              className={`hidden items-center transition-opacity duration-100 sm:flex ${
                revealed
                  ? "opacity-100"
                  : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:opacity-100"
              }`}
              role="toolbar"
              aria-label="Message actions"
            >
              {actions}
            </div>
          )}
          {entry.branchCount > 1 && <Branches entry={entry} onBranch={onBranch} />}
        </header>
        {editor !== undefined ? (
          <Editor
            key={editing}
            draft={editor}
            {...(editing === "edit"
              ? { label: "Message text", saveLabel: "Save" }
              : {
                  label: "Your version",
                  saveLabel: "Add as a new version",
                  placeholder: "Write your own version of this message…"
                })}
            onCancel={async () => {
              // Its text goes to the bin's recovered texts, never nowhere (DESIGN §6.2).
              const outcome = await editor.discard()
              report(outcome)
              if (outcome.ok) session.closeEditor(editor)
            }}
            onSave={async () => {
              const submitted = await editor.ready()
              const { text, draft } = submitted
              const outcome =
                editing === "edit"
                  ? await session.edit(entry, text, draft)
                  : await session.writeVersion(entry, text, draft)
              report(outcome)
              if (!outcome.ok) return
              // Text typed while it was being saved stays in the editor, which stays open.
              if (!editor.committed(submitted)) return
              // Saved without naming its draft (it didn't hold exactly this text): it's ended unsaved.
              if (draft === null) await editor.discard()
              session.closeEditor(editor)
            }}
          />
        ) : (
          <VersionBody version={version} session={session} parentSlotId={entry.parentSlotId} />
        )}
        {version.context !== null && version.context.issues.length > 0 && (
          // What the user should know about the context it was generated from (ARCHITECTURE §15).
          <details className="text-xs text-warning">
            <summary className="cursor-pointer">
              {version.context.issues.length === 1 ? "1 note" : `${version.context.issues.length} notes`} on its context
            </summary>
            <ul className="mt-1 list-disc pl-5">
              {version.context.issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </details>
        )}
        {model && version.direction && (
          <p className="text-xs text-muted">
            <span className="font-medium">Direction:</span> {version.direction}
          </p>
        )}
        {model &&
          (version.mark === "refused" || (version.status === "failed" && version.error?.class === "refused")) && (
            <RetryWith onPick={async (choice) => report(await session.regenerate(entry, choice))} />
          )}
        {(showVersions || (revealed && !editing)) && (
          // At the end of the message, as in ST: where reading it ends, and where a swipe
          // that changes its length leaves the arrows. A tap on a phone shows why it isn't
          // sent here too, beside the actions it reveals, so scrolling them into view never
          // scrolls the start of the reason away.
          <div ref={footer} className="flex flex-col gap-1">
            {revealed && !editing && reason !== null && <p className="text-xs text-muted sm:hidden">{reason}</p>}
            <footer className="-mb-1 flex min-h-8 items-center">
              {revealed && !editing && (
                <div className="-ml-1.5 flex items-center sm:hidden" role="toolbar" aria-label="Message actions">
                  {actions}
                </div>
              )}
              <span className="flex-1" />
              {showVersions && (
                <Versions
                  entry={entry}
                  model={model}
                  versions={versions}
                  position={position}
                  onStep={(step) => void swipe(step)}
                  onPick={async (picked) => report(await session.select(entry, picked))}
                  onOpen={() => void load()}
                />
              )}
            </footer>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error.message}
          </p>
        )}
      </div>
    </article>
  )
})
