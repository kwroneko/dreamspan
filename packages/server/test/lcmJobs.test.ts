import { assert, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect, Exit } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { summaryDraft, clipSummary } from "../src/lcm/summaryTool.ts"
import { limitImages } from "../src/providers/images.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

it("the summary tool edits atomically and requires a real draft", () => {
  const draft = summaryDraft(10)
  assert.isTrue(draft.execute({ command: "finalize" }).isError)
  assert.isFalse(draft.execute({ command: "create", file_text: "A story." }).isError)
  assert.isTrue(draft.execute({ command: "str_replace", old_str: "story", new_str: "x".repeat(100) }).isError)
  assert.strictEqual(draft.content(), "A story.")
  assert.isTrue(draft.execute({ command: "insert", insert_line: 1, new_str: "Next.", finalize: true }).done)
  assert.strictEqual(draft.content(), "A story.\nNext.")
  assert.strictEqual(clipSummary("One sentence. Second sentence. Extra", 8), "One sentence. Second sentence.")
})
it("every provider payload keeps only its last N images", () => {
  const image = (id: number) => ({ type: "image_url", image_url: { url: `synthetic:${id}` } })
  const payload = {
    messages: [
      { role: "user", content: [image(1), { type: "text", text: "older" }] },
      { role: "user", content: [image(2), image(3)] }
    ]
  }
  assert.deepStrictEqual(limitImages(payload, 1), {
    messages: [
      { role: "user", content: [{ type: "text", text: "older" }] },
      { role: "user", content: [image(3)] }
    ]
  })
  assert.strictEqual(payload.messages[0]!.content.length, 2)
  const signal = new AbortController().signal
  assert.strictEqual(limitImages({ signal }, 1).signal, signal)
})

const config = testConfig()
it.live(
  "durable jobs pin the request, serialize a chat, publish batches together, refund drain and fence old attempts",
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
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic",
        overrides: { context: 4096 }
      })
      const preset = yield* writer.CreateEntity({
        userId: user.id,
        kind: "preset",
        label: "Synthetic",
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
        title: "Synthetic",
        participants: [],
        greeting: null
      })
      const rows: Array<import("../src/db/ops.ts").AppendResult> = []
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
              content: `slot ${n} ` + "x".repeat(n === 0 ? 30_000 : 1100),
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
        )
      const leaf = rows.at(-1)!.slotId
      const plan = yield* reader.PlanSummaries({ userId: user.id, chatId: chat.id, leafSlotId: leaf })
      assert.isTrue(plan.enabled)
      assert.isAbove(plan.chunks.length, 1)
      const jobs = yield* writer.EnqueueSummaries({
        userId: user.id,
        chatId: chat.id,
        leafSlotId: leaf,
        chunks: plan.chunks,
        requestClass: "idle"
      })
      assert.lengthOf(
        yield* writer.EnqueueSummaries({
          userId: user.id,
          chatId: chat.id,
          leafSlotId: leaf,
          chunks: plan.chunks,
          requestClass: "idle"
        }),
        0
      )
      yield* api.SetGenerationDefaults({
        defaults: {
          model: { connection: connection.id, model: model.id },
          preset: preset.ref.id,
          lcm: { spendAhead: false }
        }
      })
      assert.isNull(yield* writer.ClaimSummaryJob({ userId: user.id }))
      yield* writer.EscalateSummaryJob({ userId: user.id, jobId: jobs[0]!.id })
      let claimed = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
      assert.strictEqual(claimed.id, jobs[0]!.id)
      assert.isNull(yield* writer.ClaimSummaryJob({ userId: user.id }))
      yield* writer.ReleaseSummaryJob({ userId: user.id, jobId: claimed.id, attempt: claimed.epoch })
      claimed = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
      assert.strictEqual(claimed.attempts, 1)
      const assembled = yield* reader.AssembleSummary({ userId: user.id, jobId: claimed.id, attempt: claimed.epoch })
      const snap = JSON.parse(assembled.snapshot) as ContextSnapshot
      assert.isTrue(snap.request.messages.some((m) => m.content.includes("[Message clipped for summarization.]")))
      assert.isBelow(snap.request.messages.map((m) => m.content).join("").length, 10_000)
      assert.strictEqual(snap.inputs.type, "quiet")
      assert.isNull(snap.request.prefill)
      assert.isFalse(snap.request.breakpoints.some((b) => b.reason === "history"))
      const rolloutId = uuidv7()
      yield* writer.StartSummaryRollout({
        userId: user.id,
        jobId: claimed.id,
        attempt: claimed.epoch,
        rolloutId,
        snapshot: assembled.snapshot
      })
      yield* writer.AddVersion({
        userId: user.id,
        slotId: rows[0]!.slotId,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "edited while in flight",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const complete = {
        userId: user.id,
        jobId: claimed.id,
        rolloutId,
        content: "Frozen synthetic summary.",
        status: "complete" as const,
        children: []
      }
      assert.strictEqual(yield* outcome(writer.CompleteSummary({ ...complete, inputs: [] })), "StorageError:constraint")
      const summary = yield* writer.CompleteSummary({ ...complete, inputs: snap.summaryJob!.inputs })
      assert.isFalse(summary.fresh)
      assert.strictEqual(summary.inputs[0]!.versionId, rows[0]!.version.id)
      const request = rows.at(-1)!
      const ordinary = yield* reader.AssembleContext({
        userId: user.id,
        chatId: chat.id,
        slotId: request.slotId,
        versionId: request.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })
      assert.lengthOf((JSON.parse(ordinary.snapshot) as ContextSnapshot).lcm!.selected, 0)
      const overflow = yield* reader.AssembleContext({
        userId: user.id,
        chatId: chat.id,
        slotId: request.slotId,
        versionId: request.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null,
        partialBatch: true
      })
      assert.strictEqual((JSON.parse(overflow.snapshot) as ContextSnapshot).lcm!.selected[0]!.id, summary.id)
      const rebuilt = yield* reader.RebuildContext({ userId: user.id, snapshot: assembled.snapshot })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snap)
      yield* writer.EscalateSummaryJob({ userId: user.id, jobId: jobs[1]!.id })
      const next = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
      assert.strictEqual(next.id, jobs[1]!.id)
      yield* writer.ResetSummaryJobs()
      assert.strictEqual(
        yield* outcome(
          writer.FailSummaryAttempt({
            userId: user.id,
            jobId: next.id,
            attempt: next.epoch,
            rolloutId: null,
            error: "late"
          })
        ),
        "NotFound"
      )
      const reclaimed = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
      const binned = yield* writer.DeleteChat({ userId: user.id, chatId: chat.id })
      yield* writer.FailSummaryAttempt({
        userId: user.id,
        jobId: reclaimed.id,
        attempt: reclaimed.epoch,
        rolloutId: null,
        error: "Synthetic completion after binning"
      })
      yield* writer.RestoreBinItem({ userId: user.id, itemId: binned.id })
      const restored = (yield* writer.ClaimSummaryJob({ userId: user.id }))!
      assert.strictEqual(restored.id, reclaimed.id)
      yield* writer.ReleaseSummaryJob({ userId: user.id, jobId: restored.id, attempt: restored.epoch })
      const [live] = yield* fixtureSql(config.dataDir, [
        { sql: "SELECT id FROM summarization_jobs WHERE status='processing'" }
      ])
      assert.lengthOf(live!, 0)
      const other = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Synthetic other",
        participants: [],
        greeting: null
      })
      const otherMessage = yield* writer.AppendMessage({
        userId: user.id,
        chatId: other.id,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "other",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const foreign = yield* summaryJob(config.dataDir, other.id, otherMessage.slotId, otherMessage.slotId)
      for (const statement of [
        { sql: "UPDATE summarization_jobs SET rollout_id=? WHERE id=?", params: [foreign.rolloutId, jobs[0]!.id] },
        {
          sql: "INSERT INTO summarization_jobs(id,chat_id,level,first_slot_id,last_slot_id,target_token_count,rollout_id,created_at,updated_at) VALUES(?,?,1,?,?,600,?,1,1)",
          params: [uuidv7(), chat.id, rows[0]!.slotId, rows[0]!.slotId, foreign.rolloutId]
        }
      ]) {
        const bad = yield* Effect.exit(fixtureSql(config.dataDir, [statement]))
        assert.isTrue(Exit.isFailure(bad), "rollout same-chat insert/update trigger")
      }
    }).pipe(Effect.provide(serverLayer(config))),
  90_000
)

const branchConfig = testConfig()
it.live(
  "disabled idle work on another branch does not block an interactive job",
  () =>
    Effect.gen(function* () {
      const api = yield* client(),
        user = yield* api.Whoami(),
        writer = yield* Writer
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null, lcm: { spendAhead: false } } })
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Synthetic branches",
        participants: [],
        greeting: null
      })
      const append = (parentSlotId: SlotId | null) =>
        writer.AppendMessage({
          userId: user.id,
          chatId: chat.id,
          parentSlotId,
          branch: parentSlotId !== null,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content: "Synthetic branch material.",
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
      const root = yield* append(null),
        a = yield* append(root.slotId),
        b = yield* append(root.slotId)
      const enqueue = (v: typeof a) =>
        writer.EnqueueSummaries({
          userId: user.id,
          chatId: chat.id,
          leafSlotId: v.slotId,
          chunks: [{ inputs: [{ slotId: v.slotId, versionId: v.version.id, amendCount: 0 }], target: 100 }],
          requestClass: "idle"
        })
      yield* enqueue(a)
      const [wanted] = yield* enqueue(b)
      yield* writer.EscalateSummaryJob({ userId: user.id, jobId: wanted!.id })
      const claimed = yield* writer.ClaimSummaryJob({ userId: user.id })
      assert.strictEqual(claimed?.id, wanted!.id)
      yield* writer.ReleaseSummaryJob({ userId: user.id, jobId: claimed!.id, attempt: claimed!.epoch })
    }).pipe(Effect.provide(serverLayer(branchConfig))),
  90_000
)
