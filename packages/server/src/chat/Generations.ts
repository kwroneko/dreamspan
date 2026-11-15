import { RefusalJudge } from "../decision/RefusalJudge.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
// Running generations (DESIGN §3.1): one fiber each, any number at once, several under one
// slot. Their text streams to the chat's subscribers as deltas and is saved now and then,
// so a crash keeps most of it. Stopping one keeps its text; a failure becomes a failed
// version with its cause. Everything here runs on the main thread and never blocks it:
// text arrives in chunks, and storage is a message to the writer worker.
import type { ChatId, ForkId, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { RolloutStep } from "@rp/shared/agent.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import type { QueueOutcome } from "../db/ops.ts"
import { sectionsDisplay, type ReplySections } from "@rp/shared/replySections.ts"
import { CacheWarmth } from "./CacheWarmth.ts"
import { ChatHub } from "./ChatHub.ts"
import { DecisionEngine } from "../decision/engine.ts"
import { fromItems, type Rewritten, rewriteItems, rewriteText } from "./rewrites.ts"
import { settleHeld } from "./replySections.ts"
import { executionRegistry } from "../execution.ts"
import { OUT_OF_TIME } from "@rp/shared/regexScripts.ts"
import type { LiveRewrite } from "./liveRewrites.ts"
import { Notices } from "./Notices.ts"
import {
  AutoRequestGuard,
  GenerationFailed,
  type GenerationRequest,
  Generator,
  type GeneratorShape
} from "./Generator.ts"

/** How often a generating version's text so far is saved. */
const SAVE_EVERY_MS = 2000
/** How often a stalled stream checks for text not saved yet. */
const SAVE_TICK_MS = 500
const SAVE_TICK: unique symbol = Symbol("save")

/** The longest pause between two live rewrites of one reply (see `pump`). */
const LIVE_PAUSE_MS = 100
/** How many times in a row a failed live rewrite is tried again before waiting for more text. */
const LIVE_RETRIES = 5

interface Running {
  request: GenerationRequest
  several: boolean
  text: string
  /** The reasoning streamed so far (DESIGN §7.4), kept apart from the text. */
  reasoning: string
  /** Whether this generation streamed any reasoning yet (a continuation starts with its source's). */
  reasoned: boolean
  /** The reply's leading tagged sections as parsed so far (replySections.ts), and their panel text. */
  sections: ReplySections | null
  sectionsText: string
  /** An agent reply's steps as last sent, for a subscriber that joins while it runs (spec/AGENTIC.md §5.1). */
  steps: ReadonlyArray<RolloutStep> | null
  /** What a reply parser holds back for now, kept if the reply ends here. */
  held: { readonly held: string; readonly into: "body" | "section" } | null
  /**
   * What subscribers were last sent of the text, reasoning and section panel: the texts above
   * through the live rewrites (liveRewrites.ts), or as they are (`direct`). `pending` until
   * the first rewrite says whether any script applies; nothing is sent until then.
   */
  shown: { text: string; reasoning: string; sections: string }
  mode: "pending" | "direct" | "rewrite"
  /** Texts changed since the last rewrite started, and whether one is running. */
  dirty: boolean
  pumping: boolean
  /** Scripts already reported as failing while this reply streamed. */
  reported: Set<string>
  /** Live rewrites that failed in a row (`pump`). */
  failures: number
  /** Ended: nothing more is sent as it streams. */
  closed: boolean
  waitingCache: boolean
  savedAt: number
  /** Text, reasoning or sections changed since the last save. */
  unsaved: boolean
  /** Stopped by the user (`stopped`), as opposed to the server going down (`interrupted`). */
  stopped: boolean
  fiber: Fiber.Fiber<void, GenerationFailed> | undefined
  /** The version as saved when the generation ended. */
  final: Version | undefined
}

export class Generations extends Context.Service<
  Generations,
  {
    /** Starts generating into a version that was just created with status `generating`. */
    readonly start: (request: GenerationRequest) => Effect.Effect<void>
    /** Stops one generation and returns its version as saved; NotFound unless it's running and the user's. */
    readonly stop: (userId: UserId, versionId: VersionId) => Effect.Effect<Version, NotFound>
    /** The text so far of each version generating in a chat. */
    readonly live: (chatId: ChatId) => Array<{
      readonly versionId: VersionId
      readonly text: string
      readonly waitingCache?: boolean
      readonly reasoning?: string
      readonly sections?: string
      readonly steps?: ReadonlyArray<RolloutStep>
    }>
    /** The versions generating in a chat. */
    readonly runningIn: (chatId: ChatId, forkIds?: ReadonlyArray<ForkId>) => Array<VersionId>
    /** After a write moved the send queue: starts the reply it posted, and publishes what changed. */
    readonly continueQueue: (userId: UserId, outcome: typeof QueueOutcome.Type) => Effect.Effect<void>
  }
>()("rp/chat/Generations") {
  static readonly layer = Layer.effect(
    Generations,
    Effect.gen(function* () {
      const summaries = yield* Summarizer
      const judge = yield* RefusalJudge
      const writer = yield* Writer
      const reader = yield* Reader
      const hub = yield* ChatHub
      const notices = yield* Notices
      const generator = yield* Generator
      const warmth = yield* Effect.serviceOption(CacheWarmth)
      // Decision points that act after a reply (spec/AGENTIC.md §7: presence); optional.
      const decisions = yield* Effect.serviceOption(DecisionEngine)
      const { liveRewrites } = yield* executionRegistry
      const scope = yield* Effect.scope
      const running = new Map<VersionId, Running>()

      // Versions a previous process left generating can't continue: they keep their text.
      // What was queued behind them posts without replies (chatSetupWrites.ts).
      const { interrupted, queued } = yield* writer.InterruptGenerations()
      if (interrupted > 0) yield* Effect.logWarning(`${interrupted} generations were interrupted by the last shutdown`)
      if (queued > 0)
        yield* Effect.logWarning(`${queued} queued messages were posted or dropped after the last shutdown`)

      /** The text and sections to save: with what a parser holds back, as if the reply ended now. */
      const settled = (entry: Running) => {
        const { text, sections } = settleHeld(entry.text, entry.sections, entry.held)
        return { content: text, ...(sections ? { replySections: sections } : {}) }
      }

      const save = (entry: Running, status: Version["status"], error: Version["error"]) =>
        writer.SaveGeneration({
          userId: entry.request.userId,
          versionId: entry.request.versionId,
          ...settled(entry),
          ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
          status,
          error
        })

      /**
       * A finished reply is read by the judge model, if the user chose one: a refusal marks the
       * version and leaves its text (spec/LCM.md §2.4). A judge that fails marks nothing.
       */
      const markIfRefused = (request: GenerationRequest, text: string) =>
        judge.judge({ userId: request.userId, chatId: request.chatId, text, versionId: request.versionId }).pipe(
          Effect.flatMap((verdict) =>
            verdict === "refused"
              ? writer
                  .MarkVersion({ userId: request.userId, versionId: request.versionId, mark: "refused" })
                  .pipe(
                    Effect.tap((version) =>
                      Effect.sync(() => hub.publish(request.chatId, { _tag: "Version", version }))
                    )
                  )
              : Effect.void
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("judging a reply failed", cause)
          ),
          Effect.asVoid
        )

      const finish = (entry: Running, exit: Exit.Exit<void, GenerationFailed>) =>
        Effect.gen(function* () {
          let { request } = entry
          let status: Version["status"] = "complete"
          let error: Version["error"] = null
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterruptsOnly(exit.cause)) {
              status = entry.stopped ? "stopped" : "interrupted"
            } else {
              status = "failed"
              const failure = Cause.findErrorOption(exit.cause)
              if (Option.isSome(failure)) {
                const { contextLimit } = failure.value
                error = {
                  class: failure.value.class,
                  message: failure.value.message,
                  ...(contextLimit === undefined ? {} : { contextLimit })
                }
              } else {
                yield* Effect.logError("generation crashed", exit.cause)
                error = { class: "unknown", message: "The generation failed unexpectedly." }
              }
            }
          }
          entry.closed = true
          // A reply that ended with text goes through the scripts with neither flag, as ST's
          // cleanUpMessage runs them on what it received (ARCHITECTURE §12, "Rewrites"): its
          // body once the sections are out, its reasoning and each section's text (placement
          // 6); a continuation with the text it continues, which they rewrote already.
          const { content, replySections } = settled(entry)
          const written: Rewritten =
            status === "complete" || status === "stopped"
              ? yield* rewriteText(reader, {
                  userId: request.userId,
                  chatId: request.chatId,
                  forkId: request.forkId,
                  at: { slotId: request.slotId, versionId: request.versionId },
                  edit: false,
                  content,
                  reasoning: entry.reasoning || undefined,
                  sections: replySections
                })
              : {
                  content,
                  ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
                  ...(replySections ? { sections: replySections } : {})
                }
          entry.text = written.content
          if (written.reasoning !== undefined) entry.reasoning = written.reasoning
          // A reply that ended before its first live rewrite came back (a short one, a busy
          // host) has shown nothing yet: its stream ends on the texts as saved, which went
          // through the scripts.
          if (entry.mode === "pending" && (status === "complete" || status === "stopped")) {
            send(entry, "text", entry.text)
            send(entry, "reasoning", entry.reasoning)
            send(entry, "sections", sectionsDisplay(written.sections))
          }
          // The final save posts what was queued behind this reply, in the same transaction.
          const saved = yield* Effect.exit(
            writer.FinishGeneration({
              userId: request.userId,
              versionId: request.versionId,
              content: written.content,
              ...(written.sections ? { replySections: written.sections } : {}),
              ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
              status,
              error,
              ...(entry.several ? { discardEmpty: true } : {}),
              ...(written.rewrite ? { rewrite: written.rewrite } : {})
            })
          )
          running.delete(request.versionId)
          if (Exit.isFailure(saved))
            return yield* Effect.logError(`saving generation ${request.versionId} failed`, saved.cause)
          const finished = saved.value
          entry.final = finished.version
          if (finished.removedSlotId)
            request = { ...request, slotId: finished.version.slotId, versionId: finished.version.id }
          if (finished.removedSlotId) hub.publish(request.chatId, { _tag: "Reload" })
          else hub.publish(request.chatId, { _tag: "Version", version: finished.version })
          // A reply that ended on its own is news wherever the user is (DESIGN §10.1).
          if (status === "complete" || status === "failed") {
            notices.publish(request.userId, {
              _tag: "ReplyFinished",
              chatId: request.chatId,
              slotId: request.slotId,
              versionId: request.versionId,
              status
            })
          }
          if (!request.replyOnly && status === "complete" && entry.text.trim() !== "")
            yield* Effect.forkIn(markIfRefused(request, entry.text), scope)
          if (!request.replyOnly && status === "complete" && Option.isSome(decisions))
            yield* Effect.forkIn(
              decisions.value
                .afterReply({
                  userId: request.userId,
                  chatId: request.chatId,
                  slotId: request.slotId,
                  versionId: request.versionId,
                  forkId: request.forkId ?? null
                })
                .pipe(
                  Effect.tap((changed) =>
                    Effect.sync(() => {
                      if (changed) hub.publish(request.chatId, { _tag: "State" })
                    })
                  )
                ),
              scope
            )
          if (!request.replyOnly && status === "complete")
            yield* summaries.afterReply({
              userId: request.userId,
              chatId: request.chatId,
              leafSlotId: request.slotId,
              ...(request.forkId === undefined ? {} : { forkId: request.forkId ?? null }),
              triggerVersionId: request.versionId
            })
          yield* continueQueue(request.userId, finished)
        })

      /**
       * After the queue moved: the reply it posted starts, and subscribers hear of both. The
       * queue goes out first, before anything here waits, so queue events leave in the order
       * the writer committed them: a reply posted from this queue may end at once and publish
       * the next queue, and an older one must never follow it.
       */
      const continueQueue = (userId: GenerationRequest["userId"], outcome: typeof QueueOutcome.Type) =>
        Effect.gen(function* () {
          if (!outcome.queueChanged) return
          hub.publish(outcome.chatId, { _tag: "Queue", queue: outcome.queue })
          for (const next of outcome.next === null ? [] : [outcome.next, ...(outcome.more ?? [])])
            yield* startGeneration({
              userId,
              chatId: outcome.chatId,
              slotId: next.slotId,
              versionId: next.versionId,
              ...(next.forkId === undefined ? {} : { forkId: next.forkId }),
              ...(next.storyAt === undefined ? {} : { storyAt: next.storyAt })
            })
          yield* publishPosted(userId, outcome.chatId, outcome.posted)
        })

      /** Slots the queue posted, then the chat whose leaf they moved. */
      const publishPosted = (userId: GenerationRequest["userId"], chatId: ChatId, posted: ReadonlyArray<SlotId>) =>
        Effect.gen(function* () {
          if (posted.length === 0) return
          for (const slotId of posted) {
            const { entry } = yield* reader.GetSlot({ userId, slotId })
            hub.publish(chatId, { _tag: "Slot", entry })
          }
          hub.publish(chatId, { _tag: "Chat", chat: yield* reader.GetChat({ userId, chatId }) })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("publishing posted messages failed", cause)))

      /** Sends what changed of one shown text: added at its end, or replaced from where it differs. */
      const send = (entry: Running, field: keyof Running["shown"], next: string) => {
        const previous = entry.shown[field]
        if (next === previous) return
        let offset = 0
        if (next.startsWith(previous)) offset = previous.length
        else {
          const end = Math.min(previous.length, next.length)
          while (offset < end && previous.charCodeAt(offset) === next.charCodeAt(offset)) offset++
        }
        entry.shown[field] = next
        const { chatId, versionId } = entry.request
        const _tag = field === "text" ? "Delta" : field === "reasoning" ? "Reasoning" : "Section"
        hub.publish(chatId, {
          _tag,
          versionId,
          offset,
          text: next.slice(offset),
          ...(offset < previous.length ? { replace: true } : {})
        })
      }

      /** The texts as they are, sent as they stream (no rewrite applies). */
      const sendRaw = (entry: Running) => {
        send(entry, "text", entry.text)
        send(entry, "reasoning", entry.reasoning)
        send(entry, "sections", entry.sectionsText)
      }

      /**
       * Rewrites the texts so far and sends them, again while they changed meanwhile: one
       * rewrite at a time per reply, each on the newest text, so chunks that arrive during one
       * are taken together by the next. A rewrite that fails sends nothing: the texts shown
       * stay as they were and the next rewrite tries again, since what failed may be a script
       * that would take something out (a worker that's busy or restarting, say).
       */
      const pump = (entry: Running, steps: ReadonlyArray<LiveRewrite>): Effect.Effect<void> =>
        Effect.gen(function* () {
          while (entry.dirty && !entry.closed) {
            entry.dirty = false
            const { text, reasoning, sections } = entry
            const started = Date.now()
            const items = rewriteItems(text, reasoning || undefined, sections)
            let current: ReadonlyArray<{ readonly text: string }> = items
            let active = false
            let failed = false
            for (const step of steps) {
              // Each rewrite takes what the one before made.
              const given = current.map((item, i) => ({ text: item.text, kind: items[i]!.kind }))
              const result = yield* Effect.suspend(() => step.rewrite({ reader }, entry.request, given)).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.as(
                        entry.failures++ === 0
                          ? Effect.logWarning(
                              `live rewrite ${step.id} failed; the shown text waits for the next`,
                              cause
                            )
                          : Effect.void,
                        "failed" as const
                      )
                )
              )
              if (result === "failed") {
                failed = true
                break
              }
              if (result === null) continue
              // A script that ran out of time (a busy host) left a text as it came, which may
              // hold what it takes out: as a failure, what's shown waits for the next rewrite.
              if (result.texts.some((text) => text.failed.some((failure) => failure.reason === OUT_OF_TIME))) {
                if (entry.failures++ === 0)
                  yield* Effect.logWarning(`live rewrite ${step.id} ran out of time; tried again`)
                failed = true
                break
              }
              active = true
              current = result.texts
              for (const failure of result.texts.flatMap((r) => r.failed)) {
                const key = `${failure.script.scope}:${failure.script.id}`
                if (entry.reported.has(key)) continue
                entry.reported.add(key)
                yield* Effect.logWarning(
                  `regex script "${failure.script.name}" was skipped while a reply streamed: ${failure.reason}`
                )
              }
            }
            if (entry.closed) return
            if (failed) {
              // Tried again soon even if nothing more arrives, a few times; then with the next chunk.
              if (entry.failures <= LIVE_RETRIES) {
                entry.dirty = true
                yield* Effect.sleep(LIVE_PAUSE_MS)
              }
              continue
            }
            entry.failures = 0
            if (!active) {
              // Nothing changes this reply's text: it streams as it is from now on.
              entry.mode = "direct"
              return sendRaw(entry)
            }
            entry.mode = "rewrite"
            // Only text that went through the scripts is ever shown: what came meanwhile waits
            // for the next rewrite, so nothing a script takes out shows for a moment.
            const next = fromItems(current, text, reasoning || undefined, sections)
            send(entry, "text", next.content)
            send(entry, "reasoning", next.reasoning ?? "")
            send(entry, "sections", sectionsDisplay(next.sections))
            // As long again before the next one (at most 100 ms), so a long reply under heavy
            // scripts takes about half a reader worker, not all of one, while it streams.
            const spent = Date.now() - started
            if (entry.dirty && spent >= 5) yield* Effect.sleep(Math.min(spent, LIVE_PAUSE_MS))
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.pumping = false
            })
          )
        )

      /** After a chunk: sends it, or has the texts so far rewritten (`pump`). */
      const changed = (entry: Running) => {
        if (entry.mode === "direct") return Effect.sync(() => sendRaw(entry))
        entry.dirty = true
        if (entry.pumping) return Effect.void
        entry.pumping = true
        return Effect.asVoid(Effect.forkIn(pump(entry, liveRewrites.list()), scope))
      }

      const run = (gen: GeneratorShape, entry: Running) =>
        gen
          .generate({
            ...entry.request,
            onNotice: (message) =>
              hub.publish(entry.request.chatId, { _tag: "RequestNotice", versionId: entry.request.versionId, message }),
            onWaitingCache: (waiting) => {
              entry.waitingCache = waiting
              hub.publish(entry.request.chatId, { _tag: "WaitingCache", versionId: entry.request.versionId, waiting })
            }
          })
          .pipe(
            // A tick in the same loop as the chunks, so a stream that stalls still gets its
            // text saved, and never after the final save.
            Stream.merge(
              Stream.map(Stream.tick(SAVE_TICK_MS), (): typeof SAVE_TICK => SAVE_TICK),
              { haltStrategy: "left" }
            ),
            Stream.runForEach((chunk) =>
              Effect.suspend(() => {
                if (chunk === SAVE_TICK) return saveSoFar(entry)
                if (typeof chunk === "object" && "several" in chunk) {
                  entry.several = true
                  return Effect.void
                }
                if (typeof chunk === "object" && "post" in chunk)
                  return Effect.gen(function* () {
                    // A live rewrite owns the old message until it finishes. No chunks of the
                    // next message can arrive while send_message awaits this boundary.
                    while (entry.pumping) yield* Effect.sleep(5)
                    const { request } = entry
                    const { content, replySections } = settled(entry)
                    const written = yield* rewriteText(reader, {
                      userId: request.userId,
                      chatId: request.chatId,
                      forkId: request.forkId,
                      at: { slotId: request.slotId, versionId: request.versionId },
                      edit: false,
                      content,
                      reasoning: entry.reasoning || undefined,
                      sections: replySections
                    })
                    const next = yield* writer.PostRolloutMessage({
                      userId: request.userId,
                      rolloutId: chunk.post.rolloutId,
                      versionId: request.versionId,
                      toolCallId: chunk.post.toolCallId,
                      content: written.content,
                      ...(written.reasoning ? { reasoning: written.reasoning } : {}),
                      ...(written.sections ? { replySections: written.sections } : {}),
                      ...(written.rewrite ? { rewrite: written.rewrite } : {})
                    })
                    running.delete(request.versionId)
                    entry.request = { ...request, slotId: next.slotId, versionId: next.versionId }
                    running.set(next.versionId, entry)
                    entry.text = ""
                    entry.reasoning = ""
                    entry.reasoned = false
                    entry.sections = null
                    entry.sectionsText = ""
                    entry.held = null
                    entry.steps = null
                    entry.shown = { text: "", reasoning: "", sections: "" }
                    entry.mode = liveRewrites.list().length > 0 ? "pending" : "direct"
                    entry.dirty = false
                    entry.savedAt = Date.now()
                    entry.unsaved = false
                    const previous = yield* reader.GetSlot({
                      userId: request.userId,
                      slotId: request.slotId,
                      forkId: request.forkId ?? null
                    })
                    hub.publish(request.chatId, { _tag: "Slot", entry: previous.entry })
                    const working = yield* reader.GetSlot({
                      userId: request.userId,
                      slotId: next.slotId,
                      forkId: request.forkId ?? null
                    })
                    hub.publish(request.chatId, { _tag: "Slot", entry: working.entry })
                    const chat = yield* reader.GetChat({ userId: request.userId, chatId: request.chatId })
                    hub.publish(request.chatId, { _tag: "Chat", chat })
                    chunk.post.resolve(next)
                  }).pipe(
                    // Once the post commits, Stop must observe its new working version.
                    Effect.uninterruptible,
                    Effect.mapError(
                      () => new GenerationFailed({ class: "server", message: "The server couldn't post the message." })
                    ),
                    Effect.tapCause((cause) => Effect.sync(() => chunk.post.reject(cause)))
                  )
                if (typeof chunk === "string") {
                  entry.text += chunk
                } else if ("sections" in chunk) {
                  entry.sections = chunk.sections
                  entry.sectionsText += chunk.text
                } else if ("held" in chunk) {
                  entry.held = chunk
                  return Effect.void
                } else if ("steps" in chunk) {
                  // Steps go to subscribers as they stand; the transcript is what keeps them.
                  const { chatId } = entry.request
                  const versionId = chunk.versionId ?? entry.request.versionId
                  if (versionId === entry.request.versionId) entry.steps = chunk.steps
                  hub.publish(chatId, { _tag: "Steps", versionId, steps: chunk.steps })
                  if (versionId !== entry.request.versionId)
                    return reader.GetVersion({ userId: entry.request.userId, versionId }).pipe(
                      Effect.tap((version) => Effect.sync(() => hub.publish(chatId, { _tag: "Version", version }))),
                      Effect.catch(() => Effect.void),
                      Effect.asVoid
                    )
                  return Effect.void
                } else if ("restart" in chunk) {
                  // Back to where it began (a continuation's source text stays).
                  const initial = entry.request.initial
                  entry.text = initial?.text ?? ""
                  entry.reasoning = initial?.reasoning ?? ""
                  entry.reasoned = false
                  entry.sections = initial?.sections ?? null
                  entry.sectionsText = sectionsDisplay(initial?.sections)
                  entry.held = null
                } else {
                  // A continuation's own reasoning goes after its source's, a paragraph apart.
                  const text =
                    !entry.reasoned && entry.reasoning.length > 0 ? `\n\n${chunk.reasoning}` : chunk.reasoning
                  entry.reasoned = true
                  entry.reasoning += text
                }
                entry.unsaved = true
                return Effect.andThen(
                  changed(entry),
                  Effect.suspend(() => saveSoFar(entry))
                )
              })
            ),
            Effect.onExit((exit) => finish(entry, exit)),
            Effect.provideService(AutoRequestGuard, entry.request.autoGuard ?? null)
          )

      /** Saves the text so far now and then, so a crash keeps most of it. */
      const saveSoFar = (entry: Running) => {
        if (!entry.unsaved || Date.now() - entry.savedAt < SAVE_EVERY_MS) return Effect.void
        entry.savedAt = Date.now()
        entry.unsaved = false
        return save(entry, "generating", null).pipe(
          // Gone for good (purged from the bin): nothing it writes would be kept.
          Effect.catchTag("NotFound", () =>
            Effect.suspend(() => {
              entry.stopped = true
              return Effect.interrupt
            })
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("saving a generation's text so far failed", cause)
          ),
          Effect.catchTag(["StorageError", "RpcClientError"], () => Effect.void)
        )
      }

      const startGeneration = (request: GenerationRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (Option.isNone(generator)) return yield* Effect.die(new Error("no generator: refuse before writing"))
          const entry: Running = {
            request,
            several: false,
            // Continue starts from the text it continues: deltas go on from its end.
            text: request.initial?.text ?? "",
            reasoning: request.initial?.reasoning ?? "",
            reasoned: false,
            sections: request.initial?.sections ?? null,
            sectionsText: sectionsDisplay(request.initial?.sections),
            steps: null,
            held: null,
            shown: {
              text: request.initial?.text ?? "",
              reasoning: request.initial?.reasoning ?? "",
              sections: sectionsDisplay(request.initial?.sections)
            },
            mode: liveRewrites.list().length > 0 ? "pending" : "direct",
            dirty: false,
            pumping: false,
            reported: new Set(),
            failures: 0,
            closed: false,
            waitingCache: false,
            savedAt: Date.now(),
            unsaved: false,
            stopped: false,
            fiber: undefined,
            final: undefined
          }
          running.set(request.versionId, entry)
          // The scripts are prepared while the provider is still on its first token.
          if (entry.mode === "pending") yield* changed(entry)
          // The chat's cache estimate waits until the reply ends: it would assemble beside it.
          const release = Option.match(warmth, { onNone: () => () => {}, onSome: (w) => w.hold(request.chatId) })
          entry.fiber = yield* Effect.forkIn(
            run(generator.value, entry).pipe(Effect.ensuring(Effect.sync(release))),
            scope
          )
        })

      return Generations.of({
        start: startGeneration,
        continueQueue,
        stop: (userId, versionId) =>
          Effect.gen(function* () {
            const entry = running.get(versionId)
            if (entry === undefined || entry.request.userId !== userId || entry.fiber === undefined) {
              return yield* new NotFound({ entity: "generation", id: versionId })
            }
            entry.stopped = true
            yield* Fiber.interrupt(entry.fiber)
            if (entry.final === undefined) return yield* new NotFound({ entity: "generation", id: versionId })
            return entry.final
          }),
        live: (chatId) =>
          [...running.values()]
            .filter((entry) => entry.request.chatId === chatId)
            .map((entry) => ({
              versionId: entry.request.versionId,
              // What subscribers were sent: a new one goes on from there.
              text: entry.shown.text,
              waitingCache: entry.waitingCache,
              ...(entry.shown.reasoning ? { reasoning: entry.shown.reasoning } : {}),
              ...(entry.shown.sections ? { sections: entry.shown.sections } : {}),
              ...(entry.steps ? { steps: entry.steps } : {})
            })),
        runningIn: (chatId, forkIds) =>
          [...running.values()]
            .filter(
              (entry) =>
                entry.request.chatId === chatId &&
                (forkIds === undefined ||
                  (entry.request.forkId !== undefined && forkIds.includes(entry.request.forkId)))
            )
            .map((entry) => entry.request.versionId)
      })
    })
  )
}
