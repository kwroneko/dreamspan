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
import { historyTools } from "../src/agent/tools/history.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import type { ForkId } from "@rp/shared/chat.ts"
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

  lcmTest(
    "two characters with split presence each read nothing of the other's private stretch, anywhere",
    (server) =>
      Effect.gen(function* () {
        // Wren is away for 20–39 (Mira's private stretch), Mira for 60–79 (Wren's). A summary
        // says which private stretch its request carried, so a leak through a summary shows.
        const markers = ["MIRAPRIVATE", "WRENPRIVATE"] as const
        const h = yield* lcmHarness(server, {
          messages: 200,
          message: (n) =>
            `Message ${n}. ` +
            (n >= 20 && n < 40 ? "MIRAPRIVATE scene. " : n >= 60 && n < 80 ? "WRENPRIVATE scene. " : "") +
            "The road ran on. ".repeat(10),
          summarizer: (request) => {
            const body = JSON.stringify(request.body)
            return {
              text: [...markers.filter((m) => body.includes(m)).map((m) => `SAW-${m}`), "Summary of the road."].join(
                " "
              )
            }
          }
        })
        const card = (name: string) =>
          Effect.map(
            h.writer.CreateEntity({
              userId: h.userId,
              kind: "card",
              label: name,
              subtitle: "",
              doc: cardDoc(name),
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            }),
            (made) => made.entityId as EntityId
          )
        const wren = yield* card("Wren")
        const mira = yield* card("Mira")
        const event = (data: StateEventData) =>
          h.writer.AddStateEvent({
            userId: h.userId,
            chatId: h.chat.id,
            slotId: null,
            versionId: null,
            scope: null,
            data
          })
        yield* event({ key: "participant.join", value: { entity: wren } })
        yield* event({ key: "participant.join", value: { entity: mira } })
        yield* event({ key: "context.per_speaker", value: "separate" })
        yield* fixtureSql(h.dataDir, [
          {
            sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
            params: [JSON.stringify([wren, mira]), h.chat.id]
          },
          ...h.rows.flatMap((row, n) =>
            n >= 20 && n < 40
              ? [
                  {
                    sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
                    params: [JSON.stringify({ away: [wren] }), row.version.id]
                  }
                ]
              : n >= 60 && n < 80
                ? [
                    {
                      sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
                      params: [JSON.stringify({ away: [mira] }), row.version.id]
                    }
                  ]
                : []
          )
        ])
        yield* h.settle
        const leaf = h.rows.at(-1)!.slotId
        const forkId = h.chat.currentForkId! as ForkId
        for (const [me, own, other] of [
          [wren, "WRENPRIVATE", "MIRAPRIVATE"],
          [mira, "MIRAPRIVATE", "WRENPRIVATE"]
        ] as const) {
          // The reply's request.
          const row = yield* h.writer.AppendMessage({
            userId: h.userId,
            chatId: h.chat.id,
            parentSlotId: leaf,
            branch: true,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: me,
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
          const request = sentText(JSON.parse(built.snapshot) as ContextSnapshot)
          assert.notInclude(request, other)
          assert.include(request, "Summary of the road.")
          // The character's read tools.
          const context: ToolContext = {
            userId: h.userId,
            chatId: h.chat.id,
            forkId,
            slotId: row.slotId,
            versionId: row.version.id,
            leafSlotId: leaf,
            viewers: [me],
            rolloutId: "test",
            toolCallId: "test",
            cache: new Map(),
            reader: h.reader,
            writer: h.writer
          }
          const tool = (id: string, args: object) =>
            Effect.map(historyTools.find((t) => t.id === id)!.execute(context, args as never), (r) =>
              // A miss quotes the query back; what was found is the rest.
              r.text.replaceAll(`“${"query" in args ? String(args.query) : ""}”`, "")
            )
          assert.notInclude(yield* tool("search_chat", { query: other }), other)
          for (let from = 1; from <= 200; from += 20)
            assert.notInclude(yield* tool("read_messages", { from, count: 20 }), other)
          assert.notInclude(yield* tool("search_summaries", { query: other }), other)
          assert.include(yield* tool("search_summaries", { query: own }), own, "its own summaries are its tools'")
          const listed = yield* tool("search_summaries", { query: "road", limit: 20 })
          const ranges = [...listed.matchAll(/Messages (\d+)–(\d+)/g)].map((m) => `${m[1]}–${m[2]}`)
          assert.isAbove(ranges.length, 0)
          for (const range of ranges)
            assert.notInclude(yield* tool("expand_summary", { messages: range, max_tokens: 8000 }), other)
          // The summary UI and the history search, as this character.
          const state = yield* h.reader.GetLcmState({
            userId: h.userId,
            chatId: h.chat.id,
            leafSlotId: leaf,
            viewer: me
          })
          assert.isFalse(state.layer.some((s) => s.content?.includes(other)))
          const search = (find: string) =>
            h.reader.PreviewHistory({
              userId: h.userId,
              chatId: h.chat.id,
              forkId,
              viewer: me,
              search: {
                pairs: [{ find, replace: "x" }],
                matchCase: true,
                wholeWord: false,
                regex: false,
                preserveCase: false,
                messages: false,
                swipes: false,
                summaries: true
              }
            })
          assert.lengthOf((yield* search(other)).hits, 0, "no summary of the other's stretch is listed")
          assert.isAbove((yield* search(own)).hits.length, 0)
        }
      }),
    { timeout: 180_000 }
  )

  lcmTest(
    "undoing a scene check's away makes stale exactly the view summaries it changes, on every branch",
    (server) =>
      Effect.gen(function* () {
        const { h, wren, rows } = yield* chat(server, "separate")
        const mira = (yield* h.writer.CreateEntity({
          userId: h.userId,
          kind: "card",
          label: "Mira",
          subtitle: "",
          doc: cardDoc("Mira"),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })).entityId as EntityId
        const forkId = h.chat.currentForkId! as ForkId
        const event = (slot: number | null, data: StateEventData) =>
          h.writer.AddStateEvent({
            userId: h.userId,
            chatId: h.chat.id,
            forkId,
            slotId: slot === null ? null : h.rows[slot]!.slotId,
            versionId: null,
            scope: null,
            data
          })
        yield* event(null, { key: "participant.join", value: { entity: mira } })
        // Wren's absence for 20–39 was the scene check's; Mira was away for 60–79.
        const mark = yield* event(19, { key: "away.set", value: { entity: wren, away: true, source: "decision" } })
        yield* event(39, { key: "away.set", value: { entity: wren, away: false } })
        yield* fixtureSql(h.dataDir, [
          {
            sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
            params: [JSON.stringify([wren, mira]), h.chat.id]
          },
          ...h.rows.flatMap((row, n) =>
            n >= 60 && n < 80
              ? [
                  {
                    sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
                    params: [JSON.stringify({ away: [mira] }), row.version.id]
                  }
                ]
              : []
          )
        ])
        yield* h.settle
        // A branch from message 150 inherits the summaries.
        const branch = yield* h.writer.CreateFork({
          userId: h.userId,
          chatId: h.chat.id,
          fromForkId: forkId,
          atSlotId: h.rows[150]!.slotId
        })
        const aside = yield* h.writer.AppendMessage({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: branch.fork.id,
          parentSlotId: h.rows[150]!.slotId,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content: "The branch turns aside.",
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
        /** Every summary's freshness on a path, as each view and the shared reads list them. */
        const freshness = (fork: ForkId, leafSlotId: typeof aside.slotId) =>
          Effect.gen(function* () {
            const seen = new Map<string, { fresh: boolean; audience: string | null; from: number; to: number }>()
            for (const viewer of [undefined, wren, mira]) {
              const coverage = yield* h.reader.GetLcmCoverage({
                userId: h.userId,
                chatId: h.chat.id,
                forkId: fork,
                leafSlotId,
                fromDepth: 0,
                toDepth: 250,
                ...(viewer ? { viewer } : {})
              })
              for (const s of coverage.summaries)
                seen.set(s.id, {
                  fresh: s.fresh,
                  audience: s.audience ? JSON.stringify(s.audience) : null,
                  from: s.from,
                  to: s.to
                })
            }
            return seen
          })
        const paths = [
          [forkId, h.rows.at(-1)!.slotId],
          [branch.fork.id, aside.slotId]
        ] as const
        const before = yield* Effect.forEach(paths, ([f, l]) => freshness(f, l))
        assert.isTrue([...before[0]!.values()].every((s) => s.fresh))
        const audiences = new Set([...before[0]!.values()].map((s) => s.audience))
        assert.isTrue(
          audiences.has(JSON.stringify([wren])) && audiences.has(JSON.stringify([mira])),
          JSON.stringify([...audiences])
        )

        const corrected = yield* h.writer.CorrectPresence({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          eventId: mark.id
        })
        assert.isAbove(corrected!.corrected.length, 0)
        const after = yield* Effect.forEach(paths, ([f, l]) => freshness(f, l))
        for (const [n, path] of after.entries()) {
          const changed = [...path].filter(([id, s]) => before[n]!.get(id)?.fresh !== s.fresh).map(([id]) => id)
          // Wren's own summaries over 21–40 (positions, from 1), and those built on them.
          const expected = [...path]
            .filter(([, s]) => s.audience === JSON.stringify([wren]) && s.from <= 40 && s.to >= 21)
            .map(([id]) => id)
          assert.isAbove(expected.length, 0)
          assert.sameMembers(changed, expected, n === 0 ? "main" : "the branch")
        }
        const [superseded] = yield* rows(
          "SELECT count(*) AS n FROM summaries WHERE chat_id = ? AND audience_json IS NULL AND status = 'superseded'",
          [h.chat.id]
        )
        assert.strictEqual(superseded!.n, 0, "no shared summary is replaced")
      }),
    { timeout: 180_000 }
  )

  lcmTest(
    "the summary UI tells a character's own work from the shared work over the same messages",
    (server) =>
      Effect.gen(function* () {
        const { h, wren } = yield* chat(server, "separate")
        yield* h.settle
        // A failed shared job and a failed one of Wren's over exactly the same messages, after
        // everything that covers them (so neither reads as resolved).
        const job = (id: string, audience: string | null) => ({
          sql: `INSERT INTO summarization_jobs(id,chat_id,level,first_slot_id,last_slot_id,status,target_token_count,error,created_at,updated_at,audience_json)
            VALUES(?,?,1,?,?,'failed',100,'refused',?,?,?)`,
          params: [id, h.chat.id, h.rows[25]!.slotId, h.rows[26]!.slotId, 9e15, 9e15, audience]
        })
        yield* fixtureSql(h.dataDir, [job("job-shared", null), job("job-wren", JSON.stringify([wren]))])
        const leafSlotId = h.rows.at(-1)!.slotId
        const view = yield* h.reader.GetLcmState({ userId: h.userId, chatId: h.chat.id, leafSlotId, viewer: wren })
        const ours = view.jobs.filter((j) => j.id === "job-shared" || j.id === "job-wren")
        assert.deepStrictEqual(ours.map((j) => [j.id, j.from, j.to, j.audience ?? null]).sort(), [
          ["job-shared", 26, 27, null],
          ["job-wren", 26, 27, [wren]]
        ])
        const shared = yield* h.reader.GetLcmState({ userId: h.userId, chatId: h.chat.id, leafSlotId })
        assert.deepStrictEqual(
          shared.jobs.filter((j) => j.id.startsWith("job-")).map((j) => [j.id, "audience" in j]),
          [["job-shared", false]]
        )
      }),
    { timeout: 120_000 }
  )
})
