import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"

import { Reader, Writer } from "../src/db/Database.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { importStPreset } from "../src/formats/preset.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
const config = testConfig()
it.live(
  "failed gaps do not repeat completed work and cold idle claims are demoted",
  () =>
    Effect.gen(function* () {
      const api = yield* client(),
        user = yield* api.Whoami(),
        writer = yield* Writer,
        reader = yield* Reader
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: 1,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic",
        overrides: { context: 4096, settings: { samplers: { openai_max_context: 4096, openai_max_tokens: 256 } } }
      })
      const preset = yield* writer.CreateEntity({
        userId: user.id,
        kind: "preset",
        label: "synthetic",
        subtitle: "",
        schemaVersion: 1,
        origin: "user",
        sourcePath: null,
        doc: importStPreset(JSON.stringify({ openai_max_context: 4096, openai_max_tokens: 256 })).document!
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
      })
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "synthetic",
        participants: [],
        greeting: null
      })
      yield* writer.AddStateEvent({
        userId: user.id,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "lcm.settings", value: { enabled: true, leafTarget: 100 } }
      })
      const rows: Array<{ slotId: SlotId }> = []
      for (let n = 0; n < 12; n++)
        rows.push(
          yield* writer.AppendMessage({
            userId: user.id,
            chatId: chat.id,
            parentSlotId: rows.at(-1)?.slotId ?? null,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "human",
              content: `MATERIAL ${n} ` + "x".repeat(1100),
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
        )
      const position = { userId: user.id, chatId: chat.id, leafSlotId: rows.at(-1)!.slotId }
      const plan = yield* reader.PlanSummaries(position)
      assert.isAbove(plan.chunks.length, 1)
      const jobs = yield* writer.EnqueueSummaries({ ...position, chunks: plan.chunks, requestClass: "idle" })
      const warmth = yield* reader.CacheWarmth({ userId: user.id, chatId: chat.id })
      assert.isNull(warmth.warmth)
      let first = yield* writer.ClaimSummaryJob({ userId: user.id })
      assert.strictEqual(first!.requestClass, "background")
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) first = yield* writer.ClaimSummaryJob({ userId: user.id })
        assert.strictEqual(first!.id, jobs[0]!.id)
        yield* writer.FailSummaryAttempt({
          userId: user.id,
          jobId: first!.id,
          attempt: first!.epoch,
          rolloutId: null,
          error: "synthetic refusal"
        })
      }
      for (let i = 1; i < jobs.length; i++) {
        const j = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
        const assembled = yield* reader.AssembleSummary({ userId: user.id, jobId: j.id, attempt: j.epoch })
        const snap = JSON.parse(assembled.snapshot) as ContextSnapshot
        const expected = new Set<string | null>(snap.summaryJob!.inputs.map((x) => x.versionId))
        const rendered = snap.pieces
          .filter((p) => p.source.kind === "message" && p.messages.length)
          .flatMap((p) => (p.source.kind === "message" ? [p.source.version] : []))
        const extras = rendered.filter((v) => !expected.has(v))
        assert.strictEqual(extras.length, 0, "only declared material is rendered despite failure gap")
        const rolloutId = uuidv7()
        yield* writer.StartSummaryRollout({
          userId: user.id,
          jobId: j.id,
          attempt: j.epoch,
          rolloutId,
          snapshot: assembled.snapshot
        })
        yield* writer.CompleteSummary({
          userId: user.id,
          jobId: j.id,
          rolloutId,
          content: "Synthetic summary.",
          status: "complete",
          inputs: snap.summaryJob!.inputs,
          children: []
        })
      }
      const again = yield* reader.PlanSummaries(position)
      assert.lengthOf(again.chunks, 0)
      const oldComplete = jobs.slice(1).map((j) => j.firstSlotId)
      assert.isFalse(again.chunks.some((c) => oldComplete.includes(c.inputs[0]!.slotId)))
      const duplicate = yield* writer.EnqueueSummaries({
        ...position,
        chunks: plan.chunks.slice(1),
        requestClass: "idle"
      })
      assert.lengthOf(duplicate, 0)
    }).pipe(Effect.provide(serverLayer(config, undefined, Summarizer.none))),
  120_000
)
