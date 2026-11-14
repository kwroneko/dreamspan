import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { WORKSHOP_SUMMARY_INSTRUCTION } from "@rp/shared/workshopLcm.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect, Option, Stream } from "effect"
import { SummaryChecks } from "../lcm/OutputChecks.ts"
import type { AssembledRequest, ModelInput } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import { GenerationFailed, type GenerationRequest } from "../chat/Generator.ts"
import type { Reader } from "../db/Database.ts"
import type { Providers } from "../providers/Providers.ts"
import {
  activeRunSummaries,
  runSummaryMessage,
  compactionBoundaries,
  summarySafeText,
  transcriptData,
  type RunSummary
} from "./compaction.ts"
import type { FrozenTool } from "./tools.ts"

interface RunCompactorInput {
  readonly reader: Reader["Service"]
  readonly providers: Providers["Service"]
  readonly request: GenerationRequest
  readonly rolloutId: string
  readonly model: ModelInput
  readonly prefix: AssembledRequest
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<FrozenTool>
  readonly leafSlotId: import("@rp/shared/chat.ts").SlotId | null
  readonly reserve: number
  readonly recentPrefix?: number | undefined
}
export interface RunCompactor {
  readonly id: string
  readonly compact: (input: RunCompactorInput) => Effect.Effect<ReadonlyArray<AgentMessage>, GenerationFailed>
}

/** Registered workshop policy. It runs only while handling an explicit submit/Resume. */
export const workshopCompactor: RunCompactor = {
  id: "workshop",
  compact: (input) =>
    Effect.gen(function* () {
      const { reader, providers, request, model, prefix, rolloutId, tools } = input
      let messages = [...input.messages]
      const room = (model.context ?? 128_000) - input.reserve
      const count = (history: ReadonlyArray<AgentMessage>) =>
        reader.CountRolloutContext({
          model: JSON.stringify(model),
          request: JSON.stringify(prefix),
          transcript: JSON.stringify(history),
          tools: JSON.stringify(tools)
        })
      const fixed = yield* count(messages.filter((m) => m.role === "rpRequest"))
      const available = Math.max(0, room - fixed)
      const trigger = fixed + (available * 3) / 4
      const keep = fixed + available / 2
      const resolved = yield* reader.WorkshopSummaryContext({
        userId: request.userId,
        chatId: request.chatId,
        forkId: request.forkId ?? null,
        leafSlotId: input.leafSlotId,
        transcript: JSON.stringify(messages),
        rolloutId
      })
      if (resolved === null) {
        if ((yield* count(messages)) <= room) return messages
        return yield* new GenerationFailed({
          class: "budget",
          message: "This run needs summaries to fit. Turn on Summaries or choose a model with more room, then resume."
        })
      }
      const settings = JSON.parse(resolved) as {
        model: ModelInput
        target: number
        enabled: boolean
        changes: string
        tail: string | null
        recentTarget?: number
        recentMax?: number
        layerMax?: number
      }
      const latest = activeRunSummaries(messages).at(-1)
      if (latest && latest.changes !== settings.changes)
        messages = messages.map((m) => (m === latest ? { ...m, changes: settings.changes } : m))
      if (!latest && settings.changes !== "[]" && prefix.messages.some((m) => m.content.includes("<summary "))) {
        const note = "[Saved Undo records override summary notes]\n" + settings.changes
        const at = messages.findIndex(
          (m) => m.role === "rpHarness" && m.content.startsWith("[Saved Undo records override summary notes]")
        )
        const entry: AgentMessage = { role: "rpHarness", content: note, timestamp: 0 }
        if (at < 0) messages.push(entry)
        else messages[at] = entry
      }
      if (!settings.enabled) return messages
      // Count summary messages separately from recent raw steps. Tool definitions and loading
      // envelopes still count against the actual model window, even with a tiny recent band.
      const measure = Effect.fnUntraced(function* (history: ReadonlyArray<AgentMessage>) {
        const total = yield* count(history)
        const layer = activeRunSummaries(history).map(runSummaryMessage)
        const layerTokens = layer.length ? (yield* count([{ role: "rpRequest", timestamp: 0 }, ...layer])) - fixed : 0
        return { total, layer: layerTokens, recent: (input.recentPrefix ?? 0) + total - fixed - layerTokens }
      })
      // In-run summaries can't lower the prefix's own verbatim part. Between replies it grows
      // up to the recent maximum before summarizing, so a prefix past the target moves the pair
      // up with it, keeping its gap: the run then compacts in batches, not on every request.
      const prefixRecent = input.recentPrefix ?? 0
      const recentTarget = Math.max(settings.recentTarget ?? Infinity, prefixRecent)
      const recentMax = Math.max(
        settings.recentMax ?? Infinity,
        prefixRecent + (settings.recentMax ?? Infinity) - (settings.recentTarget ?? 0)
      )
      const fits = (m: { total: number; layer: number; recent: number }, target: boolean) =>
        m.total <= (target ? keep : trigger) &&
        m.recent <= (target ? recentTarget : recentMax) &&
        m.layer <= (settings.layerMax ?? Infinity)
      if (fits(yield* measure(messages), false)) return messages
      // A fixed prefix cannot be replaced by a transcript summary. Never pay for an unusable one.
      if (fixed >= room)
        return yield* new GenerationFailed({
          class: "budget",
          message:
            "The instructions and earlier messages exceed this model's room. Choose a model with more room, then resume."
        })

      const summaryModel = settings.model
      const target = Math.max(
        64,
        Math.min(settings.target, Math.floor(room / 16), Math.floor((summaryModel.context ?? 128_000) / 8))
      )
      const countText = (text: string) =>
        reader.CountRolloutContext({
          model: JSON.stringify(summaryModel),
          request: JSON.stringify(prefix),
          transcript: "[]",
          tools: "[]",
          text
        })
      const instruction = (
        WORKSHOP_SUMMARY_INSTRUCTION +
        (settings.tail && settings.tail !== WORKSHOP_SUMMARY_INSTRUCTION
          ? `\nUser's summary preference: ${settings.tail}`
          : "")
      ).replaceAll("{{words}}", String(Math.floor(target * 0.75)))
      const checks = yield* Effect.serviceOption(SummaryChecks)
      const allowance = (summaryModel.context ?? 128_000) - target * 3 - (yield* countText(instruction)) - 128
      if (allowance < (yield* countText(JSON.stringify({ workshop_transcript: "x" }))))
        return yield* new GenerationFailed({
          class: "budget",
          message: "The summary model has too little room. Choose a summary model with more room, then resume."
        })
      // Summarize bounded pieces when a single old run is bigger than the summary model.
      const summarize = Effect.fnUntraced(function* (material: string) {
        const chunks: Array<string> = []
        while (material.length) {
          let lo = 1,
            hi = material.length
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2)
            if ((yield* countText(JSON.stringify({ workshop_transcript: material.slice(0, mid) }))) <= allowance)
              lo = mid
            else hi = mid - 1
          }
          const part = material.slice(0, lo)
          material = material.slice(lo)
          const assembled: AssembledRequest = {
            ...prefix,
            prefill: null,
            breakpoints: [],
            messages: [
              { role: "system", content: instruction },
              { role: "user", content: JSON.stringify({ workshop_transcript: part }) }
            ],
            samplers: { ...prefix.samplers, max_tokens: target * 2 }
          }
          const wire = providerRequest(assembled, summaryModel)
          let text = ""
          yield* providers
            .stream({
              userId: request.userId,
              connectionId: summaryModel.connectionId as ConnectionId,
              modelId: summaryModel.modelId as ModelId,
              context: wire.context,
              options: { ...wire, sessionId: request.chatId },
              inspection: { request: assembled, model: summaryModel },
              attribution: { purpose: "summarize", chatId: request.chatId, rolloutId }
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  if (event.type === "text") text += event.delta
                })
              )
            )
          if (!text.trim())
            return yield* new GenerationFailed({
              class: "server",
              message: "The summary was empty. Resume to try again."
            })
          if (Option.isSome(checks))
            for (const check of checks.value.list()) {
              const verdict = yield* check.check({
                userId: request.userId,
                chatId: request.chatId,
                text,
                rolloutId,
                instruction
              })
              if (verdict === "refused")
                return yield* new GenerationFailed({
                  class: "server",
                  message: "The summary was refused. Resume to try again."
                })
            }
          chunks.push(summarySafeText(text).slice(0, target * 8))
        }
        return chunks.join("\n")
      })
      // A stand-in about as long as a summary: a span is chosen only if covering it still saves
      // room once its summary is written.
      const pending = "[Summary pending]" + " summary".repeat(target)
      for (let pass = 0; pass < 32; pass++) {
        const active = activeRunSummaries(messages)
        const measured = yield* measure(messages)
        // Condensing shrinks only the summaries, so it runs for their size or for the model's
        // room, never for the recent maximum (which it can't lower).
        const condense =
          measured.layer > Math.min(room / 8, settings.layerMax ?? Infinity) ||
          (active.length > 0 &&
            measured.total > trigger &&
            !compactionBoundaries(messages, active.at(-1)!.through).length)
        const from = condense ? 1 : (active.at(-1)?.through ?? 1)
        const boundaries = compactionBoundaries(messages, from)
        // Keep the newest group (results the model hasn't read yet). Only the model's room can
        // make a huge one compactable; the recent and summary limits never do.
        const candidates = boundaries.length > 1 ? boundaries.slice(0, -1) : measured.total > trigger ? boundaries : []
        let lo = 0,
          hi = candidates.length - 1
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          const trial: RunSummary = {
            role: "rpCompaction",
            id: "pending",
            from,
            through: candidates[mid]!,
            content: pending,
            timestamp: 0
          }
          if (fits(yield* measure([...messages, trial]), true)) hi = mid
          else lo = mid + 1
        }
        const through = candidates[lo]
        // Nothing left that a run summary can replace. Over the recent maximum only (for example
        // verbatim messages in the prefix whose between-reply summaries haven't landed yet) the
        // request still goes out; past the model's room it can't, and the user is told.
        if (through === undefined || through <= from) {
          if (fits(measured, false) || measured.total <= room) return messages
          return yield* new GenerationFailed({
            class: "budget",
            message: "One message or tool step is too large for this model. Choose a model with more room, then resume."
          })
        }
        // Never pay for a summary that can't shorten the request.
        const trial: RunSummary = { role: "rpCompaction", id: "pending", from, through, content: pending, timestamp: 0 }
        if ((yield* count([...messages, trial])) >= measured.total) {
          if (measured.total <= room) return messages
          return yield* new GenerationFailed({
            class: "budget",
            message:
              "These tool steps can't be shortened enough for this model. Choose a model with more room, then resume."
          })
        }
        const material = transcriptData(compactedTranscriptRange(messages, from, through))
        let content = yield* summarize(material)
        for (let reduction = 0; reduction < 8 && (yield* countText(content)) > target * 2; reduction++)
          content = yield* summarize(content)
        if ((yield* countText(content)) > target * 2)
          return yield* new GenerationFailed({
            class: "budget",
            message: "The summary is too long. Resume to try again."
          })
        const summary: RunSummary = {
          role: "rpCompaction",
          id: uuidv7(),
          from,
          through,
          content,
          model: settings.model.key,
          changes: settings.changes,
          timestamp: Date.now()
        }
        const next = [...messages, summary]
        const before = yield* count(messages),
          after = yield* count(next)
        if (after >= before) {
          // Left out rather than sent: the request without it already goes out.
          if (before <= room) return messages
          return yield* new GenerationFailed({
            class: "budget",
            message: "The summary didn't make enough room. Resume with a larger model or a shorter summary setting."
          })
        }
        messages = next
        // Passes go on toward the targets (fewer, larger rewrites); when only the newest group
        // is left, the next pass finds nothing to cover and returns.
        if (fits(yield* measure(messages), true)) return messages
      }
      return yield* new GenerationFailed({
        class: "budget",
        message: "More room is needed to summarize this run. Choose a larger model, then resume."
      })
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof GenerationFailed
            ? error
            : new GenerationFailed({
                class: "server",
                message: "The workshop couldn't write its summary. Resume to try again."
              })
        )
      )
    )
}

/** Projection with original indexes preserved before selecting a chunk. */
const compactedTranscriptRange = (messages: ReadonlyArray<AgentMessage>, from: number, through: number) => {
  const summaries = activeRunSummaries(messages).filter((s) => s.from >= from && s.through <= through)
  const range: Array<AgentMessage> = messages.slice(from, through).filter((m) => m.role !== "rpCompaction")
  // Children are data for a condensation. Originals already covered by them aren't sent twice.
  if (!summaries.length) return range
  return [
    ...summaries,
    ...messages
      .slice(from, through)
      .filter((m, i) => m.role !== "rpCompaction" && !summaries.some((s) => i + from >= s.from && i + from < s.through))
  ]
}
