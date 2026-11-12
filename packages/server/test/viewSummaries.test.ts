// Summaries kept per view (spec/CHARACTER-CONTEXT.md §2.3, §9.2 unit C7) through the real
// planner, worker and reader: in a chat set to separate contexts, the shared summaries stop where
// a character diverged and that character gets its own from there, written from what it knew;
// its replies, its condensations, a correction of who was there, an edit and the backfill
// estimate all keep to that view. A shared chat plans and sends exactly what it did before.
import { assert, describe } from "@effect/vitest"
import { type EntityId, NewVersion } from "@rp/shared/chat.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"

/** The stretch Wren was away for. */
const missed = (n: number) => n >= 20 && n < 40

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

/** A summary says whether its request carried the missed stretch, or a summary of it. */
const summarize = (request: Recorded) => ({
  text: JSON.stringify(request.body).includes("MISSED") ? "SAW-MISSED." : "CLEAN."
})

const chat = (
  server: Parameters<typeof lcmHarness>[0],
  setting: "separate" | "shared" | null,
  settings?: Record<string, unknown>
) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 200,
      message: (n) => `Message ${n}. ` + (missed(n) ? "MISSED-SCENE. " : "") + "The road ran on. ".repeat(10),
      summarizer: summarize,
      ...(settings ? { settings } : {})
    })
    const card = yield* h.writer.CreateEntity({
      userId: h.userId,
      kind: "card",
      label: "Wren",
      subtitle: "",
      doc: cardDoc("Wren"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const wren = card.entityId as EntityId
    const event = (data: StateEventData) =>
      h.writer.AddStateEvent({ userId: h.userId, chatId: h.chat.id, slotId: null, versionId: null, scope: null, data })
    yield* event({ key: "participant.join", value: { entity: wren } })
    if (setting !== null) yield* event({ key: "context.per_speaker", value: setting })
    // Every message was written with Wren in the cast; she was away for 20–39.
    yield* fixtureSql(h.dataDir, [
      {
        sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
        params: [JSON.stringify([wren]), h.chat.id]
      },
      ...h.rows.flatMap((row, n) =>
        missed(n)
          ? [
              {
                sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
                params: [JSON.stringify({ away: [wren] }), row.version.id]
              }
            ]
          : []
      )
    ])
    /** Who is away for message `n` now (a correction of who was there). */
    const setAway = (n: number, away: boolean) =>
      fixtureSql(h.dataDir, [
        {
          sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
          params: [away ? JSON.stringify({ away: [wren] }) : null, h.rows[n]!.version.id]
        }
      ])
    /** The context of a reply by `speaker` after the last message. */
    const assemble = (speaker: EntityId) =>
      Effect.gen(function* () {
        const row = yield* h.writer.AppendMessage({
          userId: h.userId,
          chatId: h.chat.id,
          parentSlotId: h.rows.at(-1)!.slotId,
          branch: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const built = yield* h.reader.AssembleContext({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: row.slotId,
          versionId: row.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    const rows = (sql: string, params: ReadonlyArray<string | number | null> = []) =>
      Effect.map(
        fixtureSql(h.dataDir, [{ sql, params: [...params] }], { readOnly: true }),
        ([r]) => r! as unknown as Array<{ n: number; audience: string | null; id: string; level: number }>
      )
    return { h, wren, assemble, setAway, rows }
  })

describe("summaries kept per view (unit C7)", () => {
  lcmTest(
    "a separate chat summarizes the common stretch once and each diverged character's own from there",
    (server) =>
      Effect.gen(function* () {
        const { h, wren, assemble, rows } = yield* chat(server, "separate")
        yield* h.settle
        const audience = JSON.stringify([wren])
        const groups = yield* rows(
          `SELECT audience_json AS audience, level, count(*) AS n FROM summaries
            WHERE chat_id = ? AND sealed = 1 AND status IN ('complete', 'truncated') GROUP BY audience_json, level`,
          [h.chat.id]
        )
        assert.isTrue(
          groups.some((g) => g.audience === null),
          JSON.stringify(groups)
        )
        assert.isTrue(
          groups.some((g) => g.audience === audience),
          JSON.stringify(groups)
        )
        // Wren's summaries were written from what she knew: no version of the missed stretch.
        const missedSlots = h.rows.filter((_, n) => missed(n)).map((r) => r.slotId)
        const [leak] = yield* rows(
          `SELECT count(*) AS n FROM summary_inputs i JOIN summaries s ON s.id = i.summary_id
            WHERE s.audience_json = ? AND i.version_id IS NOT NULL AND i.slot_id IN (SELECT value FROM json_each(?))`,
          [audience, JSON.stringify(missedSlots)]
        )
        assert.strictEqual(leak!.n, 0)
        const [contents] = yield* rows(
          `SELECT count(*) AS n FROM summaries s JOIN summary_revisions r ON r.id = s.selected_revision_id
            WHERE s.audience_json = ? AND r.content LIKE '%MISSED%'`,
          [audience]
        )
        assert.strictEqual(contents!.n, 0, "no request for Wren's summaries carried the missed stretch")
        // Shared summaries end before her first missed message where they are hers; a condensation
        // keeps to one audience.
        const [mixed] = yield* rows(
          `SELECT count(*) AS n FROM summary_parents p JOIN summaries a ON a.id = p.summary_id
            JOIN summaries b ON b.id = p.parent_id WHERE a.chat_id = ? AND a.audience_json IS NOT b.audience_json`,
          [h.chat.id]
        )
        assert.strictEqual(mixed!.n, 0)
        assert.isTrue(
          groups.some((g) => g.audience === audience && g.level > 1),
          "Wren's own summaries condense: " + JSON.stringify(groups)
        )
        const crossing = yield* rows(
          `SELECT s.id FROM summaries s JOIN slots a ON a.id = s.first_slot_id JOIN slots b ON b.id = s.last_slot_id
            WHERE s.chat_id = ? AND s.audience_json IS NULL AND s.level = 1 AND a.depth < 20 AND b.depth >= 20`,
          [h.chat.id]
        )
        assert.lengthOf(crossing, 0, "the shared chunks are cut where Wren diverged")

        const hers = yield* assemble(wren)
        const text = sentText(hers)
        assert.notInclude(text, "MISSED")
        assert.include(text, "CLEAN.")
        assert.isFalse(hers.issues.some((i) => i.kind === "summaries_withheld"))
        assert.isTrue(hers.pieces.some((p) => p.source.kind === "summary"))
        // The summary UI: the shared layer by default, Wren's with her named.
        const shared = yield* h.reader.GetLcmState({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId
        })
        assert.isFalse(shared.layer.some((s) => s.audience !== undefined))
        // The shared layer (the whole path's) covers the missed stretch.
        assert.isTrue(shared.layer.some((s) => s.content?.includes("SAW-MISSED.")))
        const view = yield* h.reader.GetLcmState({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId,
          viewer: wren
        })
        assert.isTrue(view.layer.some((s) => s.audience?.includes(wren)))
        assert.isFalse(view.layer.some((s) => s.audience === undefined && s.to > 20))
        const coverage = yield* h.reader.GetLcmCoverage({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId,
          fromDepth: 0,
          toDepth: 199,
          viewer: wren
        })
        assert.isTrue(coverage.summaries.some((s) => s.audience !== undefined))
        assert.isTrue(coverage.summaries.some((s) => s.audience === undefined))
      }),
    { timeout: 120_000 }
  )

  lcmTest(
    "a chat set to shared plans and sends what a chat without the setting does",
    (server) =>
      Effect.gen(function* () {
        const bodies = (requests: ReadonlyArray<Recorded>) => requests.map((r) => JSON.stringify(r.body)).sort()
        const absent = yield* chat(server, null)
        yield* absent.h.settle
        const shared = yield* chat(server, "shared")
        yield* shared.h.settle
        for (const c of [absent, shared]) {
          const [own] = yield* c.rows(
            "SELECT count(*) AS n FROM summaries WHERE chat_id = ? AND audience_json IS NOT NULL",
            [c.h.chat.id]
          )
          assert.strictEqual(own!.n, 0)
        }
        assert.deepStrictEqual(bodies(shared.h.mock.requests()), bodies(absent.h.mock.requests()))
        assert.include(sentText(yield* shared.assemble(shared.wren)), "SAW-MISSED.")
      }),
    { timeout: 120_000 }
  )

  lcmTest(
    "a correction of who was there repairs the view's summaries",
    (server) =>
      Effect.gen(function* () {
        const { h, wren, assemble, setAway, rows } = yield* chat(server, "separate")
        yield* h.settle
        const audience = JSON.stringify([wren])
        // Wren turns out to have been away for message 50, which her summaries were written from.
        yield* setAway(50, true)
        const before = yield* assemble(wren)
        assert.notInclude(sentText(before), "Message 50.")
        assert.notInclude(sentText(before), "SAW-MISSED.")
        yield* h.settle
        // Her layer now holds no summary written from it: those were written again without it.
        const layer = yield* h.reader.GetLcmState({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId,
          viewer: wren
        })
        const [stillHas] = yield* rows(
          `SELECT count(*) AS n FROM summary_inputs WHERE version_id = ?
            AND summary_id IN (SELECT value FROM json_each(?))`,
          [h.rows[50]!.version.id, JSON.stringify(layer.layer.map((x) => x.id))]
        )
        assert.strictEqual(stillHas!.n, 0)
        const after = yield* assemble(wren)
        assert.notInclude(sentText(after), "Message 50.")
        assert.isTrue(after.pieces.some((p) => p.source.kind === "summary"))
        // And present for message 25 after all: her summaries come to include it.
        yield* setAway(25, false)
        yield* h.settle
        const [has25] = yield* rows(
          `SELECT count(*) AS n FROM summary_inputs i JOIN summaries s ON s.id = i.summary_id
            WHERE s.audience_json = ? AND i.version_id = ?`,
          [audience, h.rows[25]!.version.id]
        )
        assert.isAbove(has25!.n, 0)
      }),
    { timeout: 120_000 }
  )

  lcmTest(
    "an edit of a view's summary is that view's",
    (server) =>
      Effect.gen(function* () {
        const { h, wren, assemble } = yield* chat(server, "separate")
        yield* h.settle
        const view = yield* h.reader.GetLcmState({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId,
          viewer: wren
        })
        const own = view.layer.find((s) => s.audience !== undefined)!
        yield* h.writer.EditSummary({
          userId: h.userId,
          summaryId: own.id,
          content: "EDITED-FOR-WREN.",
          expectedRowVersion: own.rowVersion,
          commitDraft: null
        })
        assert.include(sentText(yield* assemble(wren)), "EDITED-FOR-WREN.")
        const shared = yield* h.reader.GetLcmState({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: h.rows.at(-1)!.slotId
        })
        assert.isFalse(shared.layer.some((s) => s.content?.includes("EDITED-FOR-WREN.")))
      }),
    { timeout: 120_000 }
  )

  lcmTest(
    "the backfill estimate counts each diverged character's pass",
    (server) =>
      Effect.gen(function* () {
        const separate = yield* chat(server, "separate")
        const basis = yield* separate.h.reader.EstimateBackfill({
          userId: separate.h.userId,
          chatId: separate.h.chat.id,
          leafSlotId: separate.h.rows.at(-1)!.slotId
        })
        const views = basis.fromScratch.views ?? []
        assert.lengthOf(views, 1)
        assert.strictEqual(views[0]!.entity, separate.wren)
        assert.isAbove(views[0]!.l1Jobs, 0)
        const shared = yield* chat(server, "shared")
        const plain = yield* shared.h.reader.EstimateBackfill({
          userId: shared.h.userId,
          chatId: shared.h.chat.id,
          leafSlotId: shared.h.rows.at(-1)!.slotId
        })
        assert.notProperty(plain.fromScratch, "views")
        assert.isAbove(basis.fromScratch.l1Jobs, plain.fromScratch.l1Jobs)
        assert.strictEqual(
          basis.fromScratch.plannedRequests?.length,
          (plain.fromScratch.plannedRequests?.length ?? 0) + views[0]!.l1Jobs + views[0]!.condensations
        )
      }),
    { timeout: 120_000 }
  )
})
