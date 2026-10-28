import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { Worker } from "node:worker_threads"
import { takeSummaryPrefix } from "../src/lcm/prefix.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { databaseFile } from "../src/db/connection.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import type { Generation } from "../src/assembler/types.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

interface Probe {
  consumers: Array<string>
  baseline: ContextSnapshot
  changed: ContextSnapshot
  generation: Generation
  rebuilt: ContextSnapshot
  restored: ContextSnapshot
  disabled: ContextSnapshot
  restoredAgain: ContextSnapshot
}

for (const withPreset of [true, false]) {
  lcmTest(
    `summary transform overrides, disables and restores through worker generation and rebuild (preset ${withPreset})`,
    (server) =>
      Effect.gen(function* () {
        const h = yield* lcmHarness(server, { messages: 3, settings: { withPreset } })
        yield* h.enqueue(0, 2)
        const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
        assert.isNotNull(job)
        const reply = yield* h.reader.AssembleContext({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: h.rows.at(-1)!.slotId,
          versionId: h.rows.at(-1)!.version.id,
          frozen: null,
          now: 1,
          timeZone: "UTC"
        })
        const prefix = takeSummaryPrefix(JSON.parse(reply.snapshot) as ContextSnapshot)
        const pinnedText = "Pinned default prefix"
        yield* fixtureSql(h.dataDir, [
          {
            sql: "UPDATE summarization_jobs SET prefix_json = ? WHERE id = ?",
            params: [
              JSON.stringify({
                ...prefix,
                request: {
                  ...prefix.request,
                  messages: [{ role: "system", content: pinnedText }],
                  breakpoints: [{ message: 0, reason: "prefix" }]
                },
                pieces: [
                  {
                    id: "synthetic:pinned",
                    source: { kind: "assembler", what: "pinned default prefix" },
                    text: pinnedText,
                    messages: [0]
                  }
                ]
              }),
              job!.id
            ]
          }
        ])
        const probe = yield* Effect.tryPromise(
          () =>
            new Promise<Probe>((resolve, reject) => {
              const worker = new Worker(new URL("./support/summaryAssemblyWorker.ts", import.meta.url), {
                workerData: { dbPath: databaseFile(h.dataDir), userId: h.userId, jobId: job!.id, attempt: job!.epoch }
              })
              let response: { result?: Probe; error?: string } | undefined
              worker.once("message", (message: typeof response) => {
                response = message
              })
              worker.once("error", reject)
              worker.once("exit", (code) => {
                if (code !== 0 || !response?.result) reject(new Error(response?.error ?? `probe exited ${code}`))
                else resolve(response.result)
              })
            })
        )
        assert.deepStrictEqual(probe.consumers, [
          "AssembleContext",
          "CacheWarmth",
          "PlanSummaries",
          "EstimateBackfill",
          "LcmSettingsAt",
          "AssembleSummary",
          "RebuildContext"
        ])
        const text = `Synthetic request for ${job!.id}: ${probe.changed.summaryAssembly!.job.tail}`
        assert.deepStrictEqual(probe.changed.request.messages.at(-1), { role: "system", content: text })
        assert.deepStrictEqual(probe.changed.pieces.at(-1), {
          id: "synthetic:instruction",
          source: { kind: "assembler", what: "synthetic summary instruction" },
          text,
          messages: [probe.changed.request.messages.length - 1]
        })
        assert.deepStrictEqual(probe.changed.request.breakpoints, [
          { message: probe.changed.request.messages.length - 1, reason: "prefix" }
        ])
        assert.strictEqual(probe.changed.request.samplers.max_tokens, probe.disabled.request.samplers.max_tokens + 1)
        assert.deepStrictEqual(probe.generation.request, probe.changed.request)
        assert.deepStrictEqual(probe.rebuilt, probe.changed)
        assert.isFalse(probe.changed.request.messages.some((m) => m.content.includes("Return only the summary")))
        assert.isFalse(probe.changed.request.messages.some((m) => m.content.includes(pinnedText)))
        assert.strictEqual(
          probe.baseline.request.messages.some((m) => m.content.includes(pinnedText)),
          withPreset
        )
        assert.deepStrictEqual(probe.restored.request, probe.baseline.request)
        assert.deepStrictEqual(probe.restored.pieces, probe.baseline.pieces)
        assert.deepStrictEqual(probe.restoredAgain.request, probe.baseline.request)
        assert.isTrue(probe.baseline.request.messages.some((m) => m.content.includes("Return only the summary")))
        assert.isFalse(probe.disabled.request.messages.some((m) => m.content.includes("Return only the summary")))
        assert.isFalse(probe.disabled.request.messages.some((m) => m.content.includes("Synthetic request")))
        assert.deepStrictEqual(
          probe.changed.summaryJob!.inputs.map((i) => i.versionId),
          h.rows.map((r) => r.version.id)
        )
      })
  )
}
