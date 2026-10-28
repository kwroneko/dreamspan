import { assert, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Providers } from "../src/providers/Providers.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { summaryTool } from "../src/lcm/summaryTool.ts"
import { providerRequest } from "../src/assembler/wire.ts"
import type { ContextSnapshot, Generation } from "../src/assembler/types.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"

for (const style of ["direct", "tool"] as const) {
  const config = testConfig()
  let providers: Providers["Service"]
  const summaries = Layer.effect(
    Summarizer,
    Effect.map(Providers, (p) => {
      providers = p
      return Summarizer.of({
        afterReply: () => Effect.void,
        beforeReply: () => Effect.succeed(false),
        runJob: () => Effect.void,
        planNow: () => Effect.succeed([])
      })
    })
  )
  it.live(
    `${style} summary keeps the triggering examples when the larger output allowance would evict them`,
    () =>
      Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_req, res) => sse(res, completionChunks(["Synthetic reply."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client(),
          user = yield* api.Whoami(),
          writer = yield* Writer,
          reader = yield* Reader
        // The summaries' sizes the example's room was measured with: on this small model, the
        // built-in 14,000/18,000 reserves too much of it.
        yield* api.ChangeGenerationDefaults({ change: { lcm: { layerTarget: 8_000, layerMax: 12_000 } } })
        const { chat, connection, model, version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", cacheTtlS: 300 },
          model: { context: 4096, maxOutput: 512, tools: true },
          preset: { openai_max_context: 4096, openai_max_tokens: 512 },
          example: "<START>\nTobin: EXAMPLE " + "x".repeat(10000) + "\nMira: EXAMPLE_REPLY."
        })
        const normal = mock.requests().at(-1)!.body!.messages as Array<{ role: string; content: string }>
        assert.isTrue(normal.some((m) => m.content.includes("EXAMPLE_REPLY")))
        yield* writer.AddStateEvent({
          userId: user.id,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: { enabled: true, style } }
        })
        const path = yield* reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId: null, limit: 100 })
        const jobs = yield* writer.EnqueueSummaries({
          userId: user.id,
          chatId: chat.id,
          leafSlotId: path.entries.at(-1)!.slotId,
          requestClass: "idle",
          triggerVersionId: version.id,
          chunks: [
            {
              inputs: path.entries
                .slice(0, 1)
                .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 })),
              target: 600
            }
          ]
        })
        const job = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
        assert.strictEqual(job.id, jobs[0]!.id)
        const assembled = yield* reader.AssembleSummary({ userId: user.id, jobId: job.id, attempt: job.epoch })
        const snapshot = JSON.parse(assembled.snapshot) as ContextSnapshot,
          generation = JSON.parse(assembled.generation) as Generation
        const rolloutId = uuidv7()
        yield* writer.StartSummaryRollout({
          userId: user.id,
          jobId: job.id,
          attempt: job.epoch,
          rolloutId,
          snapshot: assembled.snapshot
        })
        const wire = providerRequest(generation.request, generation.model!)
        yield* providers
          .stream({
            userId: user.id,
            connectionId: connection.id,
            modelId: model.id,
            context: style === "tool" ? { ...wire.context, tools: [summaryTool] } : wire.context,
            options: wire,
            attribution: { purpose: "summarize", chatId: chat.id, rolloutId }
          })
          .pipe(Stream.runDrain)
        const sent = mock.requests().at(-1)!.body!.messages as Array<{ role: string; content: string }>
        const end = normal.findIndex((m) => m.content.includes("Late again"))
        assert.isAbove(end, 0)
        assert.strictEqual(JSON.stringify(sent.slice(0, end)), JSON.stringify(normal.slice(0, end)))
        assert.isTrue(sent.some((m) => m.content.includes("EXAMPLE_REPLY")))
        assert.isAtMost(snapshot.request.samplers.max_tokens, 1500)
        const rebuilt = yield* reader.RebuildContext({ userId: user.id, snapshot: assembled.snapshot })
        assert.strictEqual(rebuilt._tag, "Rebuilt")
        if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, snapshot.request)
        yield* writer.ReleaseSummaryJob({ userId: user.id, jobId: job.id, attempt: job.epoch })
      }).pipe(Effect.provide(serverLayer(config, undefined, summaries))),
    60_000
  )
}
