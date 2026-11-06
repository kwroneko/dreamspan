import { assert } from "@effect/vitest"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { takeSummaryPrefix } from "../src/lcm/prefix.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"

lcmTest("summaries use a specific preset, fall back for unavailable refs, and replay the selected prompts", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 3 })
    const selected = yield* h.writer.CreateEntity({
      userId: h.userId,
      kind: "preset",
      label: "Summary only",
      subtitle: "",
      schemaVersion: 1,
      origin: "user",
      sourcePath: null,
      doc: importStPreset(JSON.stringify({ main_prompt: "SPECIFIC SUMMARY PRESET. Preserve the story." })).document!
    })
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { withPreset: "specific", preset: selected.ref.id } } })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { withPreset: null, preset: null } })
    const read = () => h.api.GetLcmSettings({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.strictEqual((yield* read()).resolved.withPreset, "specific")
    assert.strictEqual((yield* read()).resolved.preset, selected.ref.id)
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { withPreset: "raw" } })
    assert.strictEqual((yield* read()).resolved.withPreset, "raw")
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { withPreset: null, preset: null } })
    yield* h.enqueue(0, 2)
    const job = (yield* h.writer.ClaimSummaryJob({ userId: h.userId }))!
    const reply = yield* h.reader.AssembleContext({
      userId: h.userId,
      chatId: h.chat.id,
      slotId: h.rows.at(-1)!.slotId,
      versionId: h.rows.at(-1)!.version.id,
      frozen: null,
      now: 1,
      timeZone: "UTC"
    })
    const replySnapshot = JSON.parse(reply.snapshot) as ContextSnapshot
    yield* fixtureSql(h.dataDir, [
      {
        sql: "UPDATE summarization_jobs SET prefix_json=? WHERE id=?",
        params: [JSON.stringify(takeSummaryPrefix(replySnapshot)), job.id]
      }
    ])
    const assemble = () => h.reader.AssembleSummary({ userId: h.userId, jobId: job.id, attempt: job.epoch })
    const built = yield* assemble()
    const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
    assert.strictEqual(snapshot.inputs.preset.ref, selected.ref.id)
    assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("SPECIFIC SUMMARY PRESET")))
    assert.isFalse(snapshot.request.messages.some((m) => m.content.includes("in a fictional chat")))
    assert.deepStrictEqual(
      snapshot.summaryJob!.inputs.map((i) => i.versionId),
      h.rows.map((r) => r.version.id)
    )
    assert.match(snapshot.request.messages.at(-1)!.content, /Pause the roleplay/)
    // The actual provider receives the specific preset, rather than the saved chat prefix.
    yield* h.summarizer.runJob(job)
    assert.isTrue(JSON.stringify(requestsTo(h.mock, "primary-model")[0]!.body).includes("SPECIFIC SUMMARY PRESET"))
    // Claim another chunk so availability checks assemble a live job.
    yield* h.append("Later synthetic message.")
    yield* h.enqueue(3, 3)
    const next = (yield* h.writer.ClaimSummaryJob({ userId: h.userId }))!
    const live = () => h.reader.AssembleSummary({ userId: h.userId, jobId: next.id, attempt: next.epoch })
    // Assembly and replay remain separate: replay keeps the historical preset even after archive/delete.
    yield* h.api.SetRefArchived({ refId: selected.ref.id, archived: true })
    const archived = JSON.parse((yield* live()).snapshot) as ContextSnapshot
    assert.strictEqual(archived.inputs.preset.ref, h.preset.ref.id)
    const binned = yield* h.writer.DeleteEntity({ userId: h.userId, entityId: selected.entityId })
    const deleted = JSON.parse((yield* live()).snapshot) as ContextSnapshot
    assert.strictEqual(deleted.inputs.preset.ref, h.preset.ref.id)
    const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: built.snapshot })
    assert.strictEqual(rebuilt._tag, "Rebuilt")
    if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, snapshot.request)
    // A chat's own settings, including its switch and ranges, survive a purged preset ref.
    yield* h.api.ChangeLcmSettings({
      chatId: h.chat.id,
      change: { withPreset: "specific", preset: selected.ref.id, recentMax: 9_000, recentTarget: 4_000 }
    })
    yield* h.writer.PurgeBinItem({ userId: h.userId, itemId: binned.id })
    const purged = yield* read()
    assert.strictEqual(purged.resolved.preset, selected.ref.id)
    assert.strictEqual(purged.resolved.enabled, true)
    assert.strictEqual(purged.resolved.recentMax, 9_000)
    assert.strictEqual((JSON.parse((yield* live()).snapshot) as ContextSnapshot).inputs.preset.ref, h.preset.ref.id)
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { withNotes: true } })
    assert.strictEqual((yield* read()).resolved.withNotes, true)
    const made = yield* h.writer.CreateChat({
      userId: h.userId,
      kind: "rp",
      status: "active",
      title: "After purge",
      participants: [],
      greeting: null
    })
    const copied = yield* h.api.GetLcmSettings({ chatId: made.id, leafSlotId: null })
    assert.strictEqual(copied.resolved.preset, selected.ref.id)
    // A dangling stored choice (for example, after removing its ref) also falls back.
    yield* fixtureSql(h.dataDir, [
      {
        sql: "UPDATE settings SET value_json=json_set(value_json, '$.preset', 'missing-summary-preset') WHERE scope='user' AND scope_id=? AND key='generation.lcm'",
        params: [h.userId]
      }
    ])
    const missing = JSON.parse((yield* live()).snapshot) as ContextSnapshot
    assert.strictEqual(missing.inputs.preset.ref, h.preset.ref.id)
  })
)
