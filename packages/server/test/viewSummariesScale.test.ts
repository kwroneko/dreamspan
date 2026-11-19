// Summaries kept per view at the owner's shape (spec/CHARACTER-CONTEXT.md §9.2 C7): the C3 scale
// fixture (a 3,000-message path, 20–50 versions on every message, 300 branches; Mira and Wren
// present throughout except 500 messages Wren was away for) with LCM on. Measures planning the
// shared summaries and Wren's own, summarizing everything through the real worker, then Wren's
// layer read and her reply's assembly with her summaries. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/viewSummariesScale.test.ts
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer, PAIRS_8K } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")

/** Lines 1,001–1,500, the stretch Wren missed. */
const MISSED_LINE = /line (100[1-9]|10[1-9]\d|1[1-4]\d\d|1500)\b/

/** A summary says whether its request carried the missed stretch, or a summary of it. */
const summarize = (request: Recorded) => {
  const body = JSON.stringify(request.body)
  return { text: MISSED_LINE.test(body) || body.includes("SAW-MISSED") ? "SAW-MISSED." : "CLEAN." }
}

it.live(
  "summaries per view at 3,000 messages, 300 branches and 20–50 swipes",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0, settings: { enabled: false }, summarizer: summarize })
      const main = h.chat.currentForkId! as ForkId
      const chatId = h.chat.id as ChatId
      const sql = (statements: Parameters<typeof fixtureSql>[1]) => fixtureSql(config.dataDir, statements)
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
      const mira = yield* card("Mira")
      const wren = yield* card("Wren")
      const event = (slotId: SlotId | null, data: StateEventData) =>
        h.writer.AddStateEvent({ userId: h.userId, chatId, forkId: main, slotId, versionId: null, scope: null, data })
      yield* event(null, { key: "participant.join", value: { entity: mira } })
      yield* event(null, { key: "participant.join", value: { entity: wren } })
      yield* event(null, { key: "context.per_speaker", value: "separate" })
      const first = (yield* h.append("The lantern road begins.")).slotId
      const cast = JSON.stringify([mira, wren])
      const away = JSON.stringify({ away: [wren] })
      const started = performance.now()
      yield* sql([
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,presence_json,created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x, 'main-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, 'The lantern road goes on, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, ?,
              CASE WHEN x BETWEEN 1001 AND 1500 THEN ? END, x, x, ? FROM n`,
          params: [mira, cast, away, main]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
            SELECT 'main-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE 'main-s'||(x-1) END,
              (SELECT depth FROM slots WHERE id = ?) + x, 'main-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
          params: [chatId, first, first, main, first]
        },
        { sql: "UPDATE forks SET tip_slot_id = 'main-s2999' WHERE id = ?", params: [main] },
        // 20–50 versions on every message.
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999),
              k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,presence_json,created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x||'-'||j, 'main-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', ?, CASE WHEN x BETWEEN 1001 AND 1500 THEN ? END, x, x, ? FROM n JOIN k ON j < 20 + (x % 31)`,
          params: [mira, cast, away, main]
        }
      ])
      // 300 branches, each with a message of its own.
      const slotAt = (depth: number) => (depth === 0 ? first : (`main-s${depth}` as SlotId))
      for (let b = 0; b < 300; b++) {
        const at = slotAt(100 + ((b * 137) % 2_850))
        const made = yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: main, atSlotId: at })
        yield* h.writer.AppendMessage({
          userId: h.userId,
          chatId,
          forkId: made.fork.id,
          parentSlotId: at,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content: `Branch ${b} turns aside.`,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
      }
      process.stdout.write(`VIEWS_READY ${Math.round(performance.now() - started)}\n`)
      yield* event(null, {
        key: "lcm.settings",
        value: { enabled: true, leafInput: 500, leafTarget: 100, ...PAIRS_8K }
      })

      const samples: Array<{ operation: string; ms: number }> = []
      const time = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const times: Array<number> = []
          let result: A | undefined
          for (let i = 0; i < 3; i++) {
            const start = performance.now()
            result = yield* effect
            times.push(performance.now() - start)
          }
          samples.push({ operation, ms: median(times) })
          return result as A
        })
      const tip = slotAt(2_999)
      const position = { userId: h.userId, chatId, forkId: main, leafSlotId: tip, reason: "reply" as const }
      const shared = yield* time("PlanSummaries shared", h.reader.PlanSummaries(position))
      const audience = JSON.stringify([wren])
      assert.deepStrictEqual(shared.views, [audience], "Wren missed something; Mira didn't")
      const hers = yield* time("PlanSummaries Wren", h.reader.PlanSummaries({ ...position, audience }))
      assert.isAbove(hers.chunks.length, 0)

      // Everything summarized through the real worker, as replies and their cascades would.
      const settleStart = performance.now()
      const ran: Array<unknown> = []
      for (let pass = 0; pass < 60; pass++) {
        const made = yield* h.summarizer.planNow(
          { userId: h.userId, chatId, leafSlotId: tip },
          pass ? "completion" : "reply"
        )
        const done = yield* h.drain
        ran.push(...done)
        if (!made.length && !done.length) break
      }
      samples.push({ operation: `settle (${ran.length} jobs)`, ms: performance.now() - settleStart })
      const [groups] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: `SELECT audience_json AS audience, count(*) AS n FROM summaries WHERE chat_id = ? AND sealed = 1
              AND status IN ('complete', 'truncated') GROUP BY audience_json`,
            params: [chatId]
          }
        ],
        { readOnly: true }
      )
      process.stdout.write(`VIEWS_SUMMARIES ${JSON.stringify(groups)}\n`)
      assert.isTrue(groups!.some((g) => g.audience === audience))

      const layer = yield* time(
        "GetLcmState Wren",
        h.reader.GetLcmState({ userId: h.userId, chatId, forkId: main, leafSlotId: tip, viewer: wren })
      )
      assert.isTrue(layer.layer.some((s) => s.audience !== undefined))
      assert.isFalse(layer.layer.some((s) => s.content?.includes("SAW-MISSED")))
      yield* time(
        "GetLcmState shared",
        h.reader.GetLcmState({ userId: h.userId, chatId, forkId: main, leafSlotId: tip })
      )

      const placeholder = (speaker: EntityId) =>
        h.writer.AppendMessage({
          userId: h.userId,
          chatId,
          forkId: main,
          parentSlotId: tip,
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
      const assemble = (row: Effect.Success<ReturnType<typeof placeholder>>) =>
        Effect.map(
          h.reader.AssembleContext({
            userId: h.userId,
            chatId,
            forkId: main,
            slotId: row.slotId,
            versionId: row.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          }),
          ({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot
        )
      const forWren = yield* time("assemble Wren", assemble(yield* placeholder(wren)))
      assert.notMatch(sentText(forWren), MISSED_LINE)
      assert.notInclude(sentText(forWren), "SAW-MISSED")
      assert.isTrue(forWren.pieces.some((p) => p.source.kind === "summary"))
      const forMira = yield* time("assemble Mira", assemble(yield* placeholder(mira)))
      assert.include(sentText(forMira), "SAW-MISSED")

      process.stdout.write(`VIEWS_SCALE ${JSON.stringify(samples)}\n`)
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      assert.isBelow(ms("PlanSummaries Wren"), 5_000)
      assert.isBelow(ms("GetLcmState Wren"), 2_000)
      assert.isBelow(ms("assemble Wren"), ms("assemble Mira") * 1.5 + 500, "a view's layer adds a bounded share")
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
