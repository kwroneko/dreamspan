// Runs real summary/rebuild handlers in a worker with a scoped synthetic plugin.
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { makeAssembler, WorkerAssembler } from "../../src/assembler/assembler.ts"
import type { ContextSnapshot } from "../../src/assembler/types.ts"
import { makeAssemblyReadHandlers } from "../../src/db/assemblyReads.ts"
import { makeLcmPlanningHandlers } from "../../src/db/lcmPlanning.ts"
import { makeLcmEnableReadHandlers } from "../../src/db/lcmEnableReads.ts"
import { readerConnection } from "../../src/db/connection.ts"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"

const { dbPath, userId, jobId, attempt } = workerData as {
  dbPath: string
  userId: UserId
  jobId: string
  attempt: number
}

const program = Effect.gen(function* () {
  const assembler = yield* makeAssembler
  const [planning, assembly, enabling] = yield* Effect.all([
    makeLcmPlanningHandlers,
    makeAssemblyReadHandlers,
    // This handler also requires the same service, rather than constructing private defaults.
    makeLcmEnableReadHandlers
  ]).pipe(Effect.provideService(WorkerAssembler, assembler))
  const build = planning.AssembleSummary({ userId, jobId, attempt })
  const baseline = yield* build
  const original = JSON.parse(baseline.snapshot) as ContextSnapshot
  const target = original.summaryJob!.prefix!.inputs
  const chatId = target.chatId as ChatId
  const leafSlotId = original.inputs.leafSlotId as SlotId
  const consumers = yield* Effect.scoped(
    Effect.gen(function* () {
      const visited: Array<string> = []
      let caller = ""
      yield* assembler.transforms.register({
        id: "synthetic:consumer-probe",
        run: (snapshot) =>
          Effect.sync(() => {
            visited.push(caller)
            return snapshot
          })
      })
      caller = "AssembleContext"
      yield* assembly.AssembleContext({
        userId,
        chatId,
        slotId: target.slotId as SlotId,
        versionId: target.versionId as VersionId,
        now: target.now,
        timeZone: target.timeZone,
        frozen: null
      })
      caller = "CacheWarmth"
      yield* assembly.CacheWarmth({ userId, chatId, leafSlotId: target.leafSlotId as SlotId | null })
      caller = "PlanSummaries"
      yield* planning.PlanSummaries({ userId, chatId, leafSlotId })
      caller = "EstimateBackfill"
      yield* enabling.EstimateBackfill({
        userId,
        chatId,
        leafSlotId
      })
      caller = "LcmSettingsAt"
      yield* enabling.LcmSettingsAt({ userId, chatId, leafSlotId })
      caller = "AssembleSummary"
      yield* build
      caller = "RebuildContext"
      yield* assembly.RebuildContext({ userId, snapshot: baseline.snapshot })
      return visited
    })
  )
  const legacySnapshot = JSON.stringify({ ...JSON.parse(baseline.snapshot), summaryAssembly: undefined })
  const legacy = yield* assembly.RebuildContext({ userId, snapshot: legacySnapshot })
  if (legacy._tag !== "Rebuilt") throw new Error("Cannot rebuild earlier summary snapshot")
  if (legacy.snapshot !== legacySnapshot) throw new Error("Earlier snapshot changed during rebuild")
  const changed = yield* Effect.scoped(
    Effect.gen(function* () {
      let staged = false
      yield* assembler.stages.register({
        id: "synthetic:job-metadata",
        run: (assembly) =>
          Effect.sync(() => {
            const job = assembly.request.summaryJob
            if (job?.id !== jobId || job.inputs.length !== 3 || !job.prefix)
              throw new Error("Missing summary metadata before transforms")
            staged = true
            return assembly
          })
      })
      yield* assembler.transforms.register({
        id: "summary-request",
        run: (snapshot) =>
          Effect.sync(() => {
            if (!staged) throw new Error("Transform ran without the metadata stage")
            staged = false
            const job = snapshot.summaryJob!
            if (job.id !== jobId || job.inputs.length !== 3 || !job.prefix) throw new Error("Missing summary metadata")
            const at = snapshot.request.messages.length
            const text = `Synthetic request for ${job.id}: ${job.tail}`
            return {
              ...snapshot,
              summaryJob: { ...job, tail: text },
              pieces: [
                ...snapshot.pieces,
                {
                  id: "synthetic:instruction",
                  source: { kind: "assembler" as const, what: "synthetic summary instruction" },
                  text,
                  messages: [at]
                }
              ],
              request: {
                ...snapshot.request,
                messages: [...snapshot.request.messages, { role: "system" as const, content: text }],
                prefill: null,
                breakpoints: [{ message: at, reason: "prefix" as const }],
                samplers: { ...snapshot.request.samplers, max_tokens: snapshot.request.samplers.max_tokens + 1 }
              }
            }
          })
      })
      const generated = yield* build
      const rebuilt = yield* assembly.RebuildContext({ userId, snapshot: generated.snapshot })
      if (rebuilt._tag !== "Rebuilt") throw new Error("Cannot rebuild synthetic request")
      return { generated, rebuilt: rebuilt.snapshot }
    })
  )
  const restored = yield* build
  const disabled = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* assembler.transforms.disable("summary-request")
      return yield* build
    })
  )
  const restoredAgain = yield* build
  const parse = (json: string) => JSON.parse(json) as ContextSnapshot
  return {
    consumers,
    baseline: parse(baseline.snapshot),
    changed: parse(changed.generated.snapshot),
    generation: JSON.parse(changed.generated.generation) as unknown,
    rebuilt: parse(changed.rebuilt),
    restored: parse(restored.snapshot),
    disabled: parse(disabled.snapshot),
    restoredAgain: parse(restoredAgain.snapshot)
  }
}).pipe(Effect.scoped, Effect.provide(readerConnection(dbPath)))

Effect.runPromise(program).then(
  (result) => parentPort!.postMessage({ result }),
  (error: unknown) => parentPort!.postMessage({ error: String(error) })
)
