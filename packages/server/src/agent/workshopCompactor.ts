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
      // An already-oversized fixed prefix has no transcript span LCM can replace.
      // Keep the existing provider admission behavior for that case.
      if (fixed >= room) return messages
      const available = Math.max(0, room - fixed)
      const trigger = fixed + (available * 3) / 4
      const keep = fixed + available / 2
      if (
        (yield* count(messages)) <= trigger &&
        !activeRunSummaries(messages).length &&
        !prefix.messages.some((m) => m.content.includes("<summary "))
      )
        return messages
      const resolved = yield* reader.WorkshopSummaryContext({
        userId: request.userId,
        chatId: request.chatId,
        forkId: request.forkId ?? null,
        leafSlotId: input.leafSlotId
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
      if ((yield* count(messages)) <= trigger) return messages
      if (!settings.enabled) return messages

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
      const allowance = Math.max(
        1,
        (summaryModel.context ?? 128_000) - target * 3 - (yield* countText(instruction)) - 128
      )
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
      for (let pass = 0; pass < 32; pass++) {
        const active = activeRunSummaries(messages)
        const condense = active.reduce((n, s) => n + s.content.length / 4, 0) > room / 8
        const from = condense ? 1 : (active.at(-1)?.through ?? 1)
        const boundaries = compactionBoundaries(messages, from)
        // Keep the newest group where possible, but a huge completed group is still compactable.
        const candidates = boundaries.length > 1 ? boundaries.slice(0, -1) : boundaries
        let lo = 0,
          hi = candidates.length - 1
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          const trial: RunSummary = {
            role: "rpCompaction",
            id: "pending",
            from,
            through: candidates[mid]!,
            content: "[Summary pending]",
            timestamp: 0
          }
          if ((yield* count([...messages, trial])) <= keep - target) hi = mid
          else lo = mid + 1
        }
        const through = candidates[lo]
        if (through === undefined || through <= from) {
          if ((yield* count(messages)) <= room) return messages
          return yield* new GenerationFailed({
            class: "budget",
            message:
              "The fixed instructions or an unfinished tool call exceed this model's room. Choose a model with more room, then resume."
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
          changes: settings.changes,
          timestamp: Date.now()
        }
        const next = [...messages, summary]
        const before = yield* count(messages),
          after = yield* count(next)
        if (after >= before)
          return yield* new GenerationFailed({
            class: "budget",
            message: "The summary didn't make enough room. Resume with a larger model or a shorter summary setting."
          })
        messages = next
        if (after <= keep) return messages
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
