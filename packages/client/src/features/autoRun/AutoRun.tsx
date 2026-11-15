// Auto replies in the composer (run.ts): the strip's chip opens a dialog that asks how many
// replies and says what will be sent; while a run is on, a row above the box counts them, with
// Stop. The row is also the run's driver: it is the only thing that starts a reply, and it only
// does while it is on screen in the tab that started the run.
import { useAtomValue } from "@effect/atom-react"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import { useEffect, useId, useRef, useSyncExternalStore } from "react"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useChatPlaceKey } from "../chat/chatPlace.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { chipClass } from "../chat/nextReplyStrip.tsx"
import { type ChatSession, liveSteps } from "../chat/session.ts"
import {
  type AutoRun,
  canResume,
  counted,
  counting,
  MAX_TURNS,
  newRun,
  parseBounds,
  resumed,
  runStoreOf,
  type Seen,
  started,
  starting,
  stepOf,
  stopped,
  stopText,
  type Tip
} from "./run.ts"

const externalEvent = (event: ChatEvent, run: AutoRun): boolean => {
  const own = run.waiting ?? run.tip
  switch (event._tag) {
    case "Slot":
      return event.entry.slotId !== own?.slotId || event.entry.version.id !== own?.versionId
    case "Version":
      return event.version.id !== own?.versionId
    case "Chat":
      return event.chat.activeLeafSlotId !== own?.slotId
    case "Queue":
      return event.queue.length > 0
    case "State":
    case "Lcm":
    case "Reload":
    case "Deleted":
    case "ComposerChoice":
      return true
    default:
      return false
  }
}

const NO_VERSION = "" as VersionId

const useRun = (session: ChatSession) => {
  const store = runStoreOf(session)
  return [useSyncExternalStore(store.subscribe, store.get, store.get), store] as const
}

const tipOf = (context: ComposerControlContext): Tip | null =>
  context.leaf ? { slotId: context.leaf.slotId, versionId: context.leaf.version.id } : null

const seenOf = (context: ComposerControlContext, approval: boolean): Seen => ({
  forkId: context.view.forkId,
  atLeaf: context.view.newer === null && !context.view.loading,
  leaf: context.leaf
    ? {
        ...tipOf(context)!,
        status: context.leaf.version.status,
        empty: context.leaf.version.content.trim() === "" && !context.leaf.version.images?.length
      }
    : null,
  hasText: context.hasText,
  queued: context.view.queue.length,
  replier: context.replier,
  picked: context.reply.picked !== null || context.reply.noReplies === true,
  candidates: context.reply.candidates.length,
  ready: context.ready,
  busy: context.busy,
  approval
})

/** Why a run can't start (or carry on) now; null when it can. */
const blocked = (context: ComposerControlContext): string | null => {
  const seen = seenOf(context, false)
  if (seen.candidates < 2) return "At least two characters must be able to reply."
  if (seen.hasText) return "Send or clear your message first."
  if (seen.queued > 0 || context.leafGenerating || seen.busy) return "Wait for the current reply."
  if (seen.picked) return "Set Next back to Auto first: auto replies follow the chat's reply order."
  if (!seen.ready || !seen.atLeaf) return "Still loading the chat."
  if (seen.leaf !== null && seen.leaf.status !== "complete")
    return "The last message didn't finish. Retry or delete it first."
  if (seen.replier === null) return "No one is set to reply."
  return null
}

/** A finished reply's usage, read a few times while its last request is still being closed. */
const readUsage = async (session: ChatSession, versionId: VersionId) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const outcome = await session.call((client) => client("GetVersionMetrics", { versionIds: [versionId] }))
    const metrics = outcome.ok ? outcome.value.find((m) => m.versionId === versionId) : undefined
    if (metrics && !metrics.running)
      return metrics.outputUnknown > 0 || metrics.estimated
        ? null
        : { tokens: metrics.output, requests: metrics.requests }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

/** The strip's chip, after ▶: opens the dialog. */
export function AutoRunChip(context: ComposerControlContext) {
  const [run] = useRun(context.session)
  const [place, setPlace] = usePlaceParam(useChatPlaceKey("autoReplies"), "")
  const running = run !== null && run.stop === null
  return (
    <>
      <Tooltip
        label={
          running
            ? "Auto replies are running. Stop them above the message box."
            : "Let the characters reply to each other for a set number of replies, with nothing sent from you. You choose how many before anything is sent."
        }
      >
        <Button
          variant="ghost"
          type="button"
          focusableWhenDisabled
          disabled={running}
          onClick={() => setPlace("5:")}
          className={chipClass()}
        >
          <Icon name="play" size={12} />
          Auto…
        </Button>
      </Tooltip>
      {place !== "" && (
        <AutoRunDialog
          context={context}
          value={place}
          onChange={(value) => setPlace(value, true)}
          onClose={() => setPlace("", true)}
        />
      )}
    </>
  )
}

function AutoRunDialog({
  context,
  value,
  onChange,
  onClose
}: {
  context: ComposerControlContext
  value: string
  onChange: (value: string) => void
  onClose: () => void
}) {
  const [, store] = useRun(context.session)
  const [turns = "5", tokens = ""] = value.split(":")
  const form = useId()
  const bounds = parseBounds(turns, tokens)
  const problem = blocked(context)
  const tools = context.view.cast?.agentEnabled === true
  const start = () => {
    if (bounds.turns === null || bounds.tokenLimit === undefined || problem !== null) return
    store.set(newRun(context.view.forkId, bounds.turns, bounds.tokenLimit, tipOf(context)))
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="Auto replies"
      description="The characters reply to each other, with nothing sent from you."
    >
      <form
        id={form}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          start()
        }}
      >
        <Field
          label="Replies"
          description="It stops after this many."
          error={bounds.turns === null ? `A whole number from 1 to ${MAX_TURNS}.` : null}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_TURNS}
            step={1}
            required
            value={turns}
            onChange={(event) => onChange(`${event.currentTarget.value}:${tokens}`)}
          />
        </Field>
        <Field
          label="Token limit (optional)"
          description="Maximum output tokens across replies and their tool calls. Decisions and summaries are separate."
          error={bounds.tokenLimit === undefined ? "A whole number, or leave it empty." : null}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={tokens}
            onChange={(event) => onChange(`${turns}:${event.currentTarget.value}`)}
          />
        </Field>
        <p data-auto-sends className="text-sm">
          {bounds.turns === null
            ? "Each reply is sent to this chat's model, one at a time, like Reply now."
            : `Sends up to ${bounds.turns} ${bounds.turns === 1 ? "reply" : "replies"} to this chat's model, one at a time, each like Reply now.`}
          {tools ? " With tools on, one reply can make up to 12 requests." : ""} Decisions and summaries you turned on
          run as usual.
        </p>
        <p className="text-sm text-muted">
          It stops by itself when you type or send, when a reply fails or is stopped, when a tool needs your approval,
          and when the chat changes. It runs only while this tab stays on this chat and branch.
        </p>
      </form>
      <DialogActions>
        <Button variant="ghost" hint="Closes without sending anything." onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          form={form}
          focusableWhenDisabled
          disabled={bounds.turns === null || bounds.tokenLimit === undefined || problem !== null}
          hint={problem ?? "Starts the first reply now."}
        >
          Start
        </Button>
      </DialogActions>
    </Dialog>
  )
}

const count = (value: number) => value.toLocaleString("en-US")

/** Above the box: the run's count and Stop; once ended, why, with Continue and Dismiss. Drives the run. */
export function AutoRunRow(context: ComposerControlContext) {
  const { session, report } = context
  const [run, store] = useRun(session)
  const steps = useAtomValue(liveSteps(run?.waiting?.versionId ?? NO_VERSION))
  const approval =
    run?.waiting != null && (steps ?? []).some((step) => step.kind === "tool" && step.status === "waiting")
  const seen = seenOf(context, approval)
  const current = useRef(context)
  useEffect(() => {
    current.current = context
  })
  const pendingEvents = useRef<ChatEvent[]>([])

  // Events outside the last message count too: editing an earlier line must end the run.
  // During Generate, buffer events until its returned identities identify its own writes.
  useEffect(
    () =>
      session.subscribeActivity((event) => {
        const now = store.get()
        if (!now || now.stop !== null) return
        if (event === null || event._tag === "Hello") {
          store.update(now.id, (r) => stopped(r, "disconnected"))
          return
        }
        if (event._tag === "Steps" && event.steps.some((step) => step.kind === "tool" && step.status === "waiting")) {
          store.update(now.id, (r) => stopped(r, "approval"))
          return
        }
        if (event._tag === "Cache") {
          const previous = session.snapshot().history
          if (
            previous &&
            (JSON.stringify(previous.budget?.origins?.model) !== JSON.stringify(event.budget?.origins?.model) ||
              JSON.stringify(previous.model) !== JSON.stringify(event.model))
          ) {
            store.update(now.id, (r) => stopped(r, "moved"))
            return
          }
        }
        if (now.pending === "start") {
          pendingEvents.current.push(event)
          return
        }
        if (externalEvent(event, now)) store.update(now.id, (r) => stopped(r, "moved"))
      }),
    [session, store]
  )

  // The run's one driver. It reads the run from the store, never from this render, so a step
  // already taken (a request that's out) isn't taken twice.
  useEffect(() => {
    const now = store.get()
    if (now === null) return
    if (now.stop !== null) {
      // A reply already sent still consumes both bounds, even when typing ended the run.
      if (
        now.waiting &&
        now.pending === null &&
        context.leaf?.version.id === now.waiting.versionId &&
        context.leaf.version.status !== "generating"
      ) {
        store.update(now.id, counting)
        void readUsage(session, now.waiting.versionId).then((usage) =>
          store.update(now.id, (r) =>
            usage ? counted(r, usage) : { ...r, pending: null, waiting: null, asked: r.turns }
          )
        )
      }
      return
    }
    const step = stepOf(now, seen)
    if (step.do === "wait") return
    if (step.do === "stop") {
      store.update(now.id, (r) => stopped(r, step.why))
      return
    }
    if (step.do === "count") {
      store.update(now.id, counting)
      void readUsage(session, step.versionId).then((usage) =>
        store.update(now.id, (r) =>
          usage !== null
            ? counted(r, usage)
            : r.tokenLimit === null
              ? counted(r, { tokens: 0, requests: 0 })
              : { ...stopped(r, "uncounted"), pending: null, waiting: null, asked: r.turns }
        )
      )
      return
    }
    pendingEvents.current = []
    store.update(now.id, starting)
    // Exactly ▶ Reply now's request for one reply: Auto's pick, no round after it.
    void session
      .generate(
        session.snapshot().leafSlotId,
        seen.replier,
        "",
        undefined,
        [],
        context.reply.decides === true && context.reply.picked === null,
        {
          allowed: () =>
            store.get()?.id === now.id &&
            store.get()?.stop === null &&
            !pendingEvents.current.some((event) => externalEvent(event, now)) &&
            stepOf({ ...now, pending: null }, seenOf(current.current, false)).do === "start",
          token: now.token,
          ...(now.tokenLimit === null ? {} : { outputLimit: now.tokenLimit - now.tokens })
        }
      )
      .then((outcome) => {
        if (!outcome.ok) {
          store.update(now.id, (r) => ({
            ...(outcome.error.tag === "LeafMoved"
              ? stopped(r, "moved")
              : outcome.error.tag === "AutoRefused"
                ? // The server found a change this tab hadn't heard of yet: nothing was sent.
                  stopped(
                    r,
                    outcome.error.reason === "settings"
                      ? "settings"
                      : outcome.error.reason === "expired"
                        ? "restarted"
                        : "moved"
                  )
                : stopped(r, "error", outcome.error.message)),
            pending: null,
            asked: r.tokenLimit === null ? r.asked : r.turns
          }))
          return
        }
        if (outcome.value._tag !== "Posted") {
          // Something else was being written: the reply waits in the queue, which ends the run.
          store.update(now.id, (r) => stopped(r, "queued"))
          return
        }
        const reply = { slotId: outcome.value.entry.slotId, versionId: outcome.value.entry.version.id }
        const token = outcome.value.auto?.token ?? null
        const after = store.update(now.id, (r) => {
          const next = started(r, reply, token)
          return pendingEvents.current.some((event) => externalEvent(event, next)) ? stopped(next, "moved") : next
        })
        // Stopped (or dismissed) while the request was out: the reply it started is stopped too.
        if (after === null || after.stop !== null) void session.stop(reply.versionId)
      })
  })
  // Leaving the chat's composer ends the run: nothing is started from a tab that isn't showing it.
  useEffect(
    () => () => {
      const now = store.get()
      if (now !== null) store.update(now.id, (r) => stopped(r, "left"))
    },
    [store]
  )

  useEffect(() => {
    const leave = () => {
      const now = store.get()
      if (now) store.update(now.id, (r) => stopped(r, "left"))
    }
    window.addEventListener("pagehide", leave)
    window.addEventListener("offline", leave)
    return () => {
      window.removeEventListener("pagehide", leave)
      window.removeEventListener("offline", leave)
    }
  }, [store])

  if (run === null) return null
  const running = run.stop === null
  const stop = async (now: AutoRun) => {
    store.update(now.id, (r) => stopped(r, "you"))
    if (now.waiting !== null) report(await session.stop(now.waiting.versionId))
  }
  const problem = running ? null : blocked(context)
  const written = run.tokens > 0 ? ` About ${count(run.tokens)} tokens written.` : ""
  return (
    <div
      role="group"
      aria-label="Auto replies"
      data-auto-run={running ? "running" : run.stop}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border px-3 py-2 text-sm"
    >
      <Badge tone={running || run.stop === "done" ? "neutral" : "warning"}>
        {running ? "auto" : run.stop === "done" ? "auto done" : "auto stopped"}
      </Badge>
      <span role="status" className="min-w-[10rem] flex-1 text-muted [overflow-wrap:anywhere]">
        {running ? `Reply ${Math.min(run.done + 1, run.turns)} of ${run.turns}.` : stopText(run)}
        {written}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {running ? (
          <Tooltip label="Stop the reply being written and end auto replies.">
            <Button variant="primary" onClick={() => void stop(run)}>
              Stop
            </Button>
          </Tooltip>
        ) : (
          <>
            {canResume(run) && (
              <Tooltip
                label={
                  problem ??
                  `Carry on with the ${run.turns - run.asked} left of ${run.turns}. The next reply is sent now.`
                }
              >
                <Button
                  variant="ghost"
                  focusableWhenDisabled
                  disabled={problem !== null}
                  onClick={() => store.set(resumed(run, tipOf(context)))}
                >
                  Continue
                </Button>
              </Tooltip>
            )}
            <Tooltip label="Hide this. Nothing is sent.">
              <Button variant="ghost" onClick={() => store.set(null)}>
                Dismiss
              </Button>
            </Tooltip>
          </>
        )}
      </span>
    </div>
  )
}
