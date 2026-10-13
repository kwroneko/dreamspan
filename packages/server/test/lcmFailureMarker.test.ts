import { assert } from "@effect/vitest"
import { NewVersion } from "@rp/shared/chat.ts"
import { newCardDoc } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

for (const mode of ["st", "layouts"] as const)
  lcmTest(`${mode}: failed ranges stay raw until overflow, then carry a budgeted, pinned marker`, (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { summarizer: () => ({ refusal: true }) })
      if (mode === "st") {
        const card = yield* h.writer.CreateEntity({
          userId: h.userId,
          kind: "card",
          label: "Synthetic",
          subtitle: "",
          schemaVersion: 1,
          origin: "user",
          sourcePath: null,
          doc: newCardDoc("Synthetic")
        })
        yield* h.writer.AddStateEvent({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "participant.join", value: { entity: card.entityId } }
        })
      }
      const job = yield* h.enqueue(0, 1)
      yield* h.drain
      const inputs = h.rows.slice(0, 2).map((row) => ({ slotId: row.slotId, versionId: row.version.id, amendCount: 0 }))
      const assemble = () =>
        Effect.map(
          h.reader.AssembleContext({
            userId: h.userId,
            chatId: h.chat.id,
            slotId: h.rows.at(-1)!.slotId,
            versionId: h.rows.at(-1)!.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          }),
          (r) => JSON.parse(r.snapshot) as ContextSnapshot
        )
      const fitting = yield* assemble()
      const wireText = (s: ContextSnapshot) => s.request.messages.map((m) => m.content).join("\n")
      assert.include(wireText(fitting), "Message 0.")
      assert.include(wireText(fitting), "Message 1.")
      assert.notInclude(wireText(fitting), "could not be summarized")
      assert.isEmpty(fitting.lcm!.failures!)
      for (let n = 0; n < 36; n++) yield* h.append(`New ${n}. ` + "x".repeat(1000))
      yield* h.append("target")
      const overflowing = yield* assemble()
      assert.include(wireText(overflowing), "[Messages 1–2 could not be summarized.]")
      assert.notInclude(wireText(overflowing), "Message 0.")
      assert.notInclude(wireText(overflowing), "Message 1.")
      assert.deepStrictEqual(overflowing.lcm!.failures, [{ from: 1, to: 2 }])
      assert.isTrue(overflowing.issues.some((i) => i.kind === "summary_failed" && i.message.includes("1–2")))
      assert.isAtMost(
        overflowing.request.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 3, 3),
        8192 - 512
      )
      // Both the raw decision and the failure survive a later edit and successful repair.
      yield* h.writer.AddVersion({
        userId: h.userId,
        slotId: h.rows[0]!.slotId,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "Changed original",
          status: "complete",
          origin: "user_written",
          macroMode: "verbatim"
        })
      })
      const stale = yield* assemble()
      assert.notInclude(wireText(stale), "could not be summarized")
      for (const snapshot of [fitting, overflowing]) {
        const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(snapshot) })
        assert.strictEqual(rebuilt._tag, "Rebuilt")
        if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snapshot)
      }
      const [originalJobs] = yield* fixtureSql(h.dataDir, [
        { sql: "SELECT status FROM summarization_jobs WHERE id=?", params: [job.id] }
      ])
      assert.strictEqual(originalJobs![0]!.status, "failed")
      const current = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
      yield* completeFixture(
        h.dataDir,
        h.writer,
        h.userId,
        h.chat.id,
        current.entries.slice(0, 2).map((e) => ({ ...inputs[0]!, slotId: e.slotId, versionId: e.version.id }))
      )
      const repaired = yield* assemble()
      assert.notInclude(wireText(repaired), "could not be summarized")
      const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(overflowing) })
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), overflowing)
      else assert.fail("failure capture must rebuild exactly")
    })
  )

lcmTest("a trim inside a failed chunk sends one marker for the whole chunk", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0, summarizer: () => ({ refusal: true }) })
    for (let n = 0; n < 16; n++) yield* h.append(`Failed original ${n}. ` + "x".repeat(1000))
    yield* h.append("target")
    yield* h.enqueue(0, 15)
    yield* h.drain
    const assemble = () =>
      h.reader.AssembleContext({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: h.rows.at(-1)!.slotId,
        versionId: h.rows.at(-1)!.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })
    const fitting = JSON.parse((yield* assemble()).snapshot) as ContextSnapshot
    assert.isEmpty(fitting.lcm!.failures!)
    for (let n = 0; n < 20; n++) yield* h.append(`Recent ${n}. ` + "y".repeat(1000))
    yield* h.append("target")
    const snapshot = JSON.parse((yield* assemble()).snapshot) as ContextSnapshot
    const text = snapshot.request.messages.map((m) => m.content).join("\n")
    assert.include(text, "[Messages 1–16 could not be summarized.]")
    assert.notInclude(text, "Failed original")
    assert.isAtLeast(snapshot.historyStart!.depth, 16)
    assert.isDefined(snapshot.request.summaryStart)
    assert.deepStrictEqual(snapshot.lcm!.failures, [{ from: 1, to: 16 }])
  })
)

lcmTest("unused failure markers consume no space while many short originals still fit", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0 })
    const preset = yield* h.writer.CreateEntity({
      userId: h.userId,
      kind: "preset",
      label: "Small",
      subtitle: "",
      schemaVersion: 1,
      origin: "user",
      sourcePath: null,
      doc: importStPreset(JSON.stringify({ openai_max_context: 512, openai_max_tokens: 64 })).document!
    })
    yield* h.api.SetGenerationDefaults({ defaults: { model: h.primary, preset: preset.ref.id } })
    for (let n = 0; n < 80; n++) yield* h.append(`m${n}`)
    yield* h.append("target")
    yield* fixtureSql(
      h.dataDir,
      h.rows.slice(0, 80).flatMap((row, n) =>
        n % 2
          ? []
          : [
              {
                sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?, '',0,'generated',1)",
                params: [`r${n}`, `s${n}`]
              },
              {
                sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,1,?,?,?,1,'failed',1)",
                params: [`s${n}`, h.chat.id, `r${n}`, row.slotId, row.slotId]
              },
              {
                sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,0,?,?)",
                params: [`s${n}`, row.slotId, row.version.id]
              },
              { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [`s${n}`] }
            ]
      )
    )
    const built = yield* h.reader.AssembleContext({
      userId: h.userId,
      chatId: h.chat.id,
      slotId: h.rows.at(-1)!.slotId,
      versionId: h.rows.at(-1)!.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null
    })
    const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
    assert.isEmpty(snapshot.lcm!.failures!)
    assert.lengthOf(snapshot.sources!.lcm!.failures!, 40)
    assert.isEmpty(snapshot.lcm!.omitted)
    assert.include(snapshot.request.messages.map((m) => m.content).join("\n"), "m0")
  })
)

lcmTest("an adjacent failed range keeps its originals when only the older one must leave", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0 })
    for (let n = 0; n < 32; n++) yield* h.append(`${n < 16 ? "Older" : "Later"} original ${n}. ` + "x".repeat(1000))
    yield* h.append("target")
    yield* fixtureSql(
      h.dataDir,
      [0, 1].flatMap((n) => {
        const rows = h.rows.slice(n * 16, (n + 1) * 16)
        return [
          {
            sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'',0,'generated',1)",
            params: [`revision${n}`, `failed${n}`]
          },
          {
            sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,1,?,?,?,16,'failed',1)",
            params: [`failed${n}`, h.chat.id, `revision${n}`, rows[0]!.slotId, rows.at(-1)!.slotId]
          },
          ...rows.map((row, ordinal) => ({
            sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,?,?,?)",
            params: [`failed${n}`, ordinal, row.slotId, row.version.id]
          })),
          { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [`failed${n}`] }
        ]
      })
    )
    const built = yield* h.reader.AssembleContext({
      userId: h.userId,
      chatId: h.chat.id,
      slotId: h.rows.at(-1)!.slotId,
      versionId: h.rows.at(-1)!.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null
    })
    const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
    const text = snapshot.request.messages.map((m) => m.content).join("\n")
    assert.deepStrictEqual(snapshot.lcm!.failures, [{ from: 1, to: 16 }])
    assert.include(text, "[Messages 1–16 could not be summarized.]")
    assert.notInclude(text, "Older original")
    assert.include(text, "Later original 16.")
    assert.include(text, "Later original 31.")
  })
)
