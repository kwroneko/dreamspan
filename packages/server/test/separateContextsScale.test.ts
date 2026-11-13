// Separate contexts at the owner's shape (spec/CHARACTER-CONTEXT.md §9.2 C3): a 3,000-message
// path with 20–50 versions on every message and 300 branches, Mira and Wren present
// throughout except a 500-message stretch Wren was away for. Measures the next reply's
// assembly for each, separate and shared, through the real reader worker, and the
// summary-layer check over the whole path. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/separateContextsScale.test.ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { AssemblySources } from "../src/assembler/pipeline.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { sqlSources } from "../src/db/assemblySources.ts"
import { databaseFile } from "../src/db/connection.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")

it.live(
  "separate contexts at 3,000 messages, 300 branches and 20–50 swipes",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0, settings: { enabled: false } })
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
              cast_json,presence_json,created_at,updated_at, authoring_fork_id)
            SELECT 'main-v'||x, 'main-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, 'The lantern road goes on, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, ?,
              CASE WHEN x BETWEEN 1001 AND 1500 THEN ? END, x, x , '${main}' FROM n`,
          params: [mira, cast, away]
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
              cast_json,presence_json,created_at,updated_at, authoring_fork_id)
            SELECT 'main-v'||x||'-'||j, 'main-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', ?, CASE WHEN x BETWEEN 1001 AND 1500 THEN ? END, x, x , '${main}' FROM n JOIN k ON j < 20 + (x % 31)`,
          params: [mira, cast, away]
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
      const [counts] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT (SELECT count(*) FROM slots) AS slots, (SELECT count(*) FROM versions) AS versions, (SELECT count(*) FROM forks) AS forks"
          }
        ],
        { readOnly: true }
      )
      process.stdout.write(`CONTEXTS_READY ${JSON.stringify(counts![0])} ${Math.round(performance.now() - started)}\n`)

      // A model whose window holds the whole path, so the filter, not the budget, decides.
      const wide = yield* h.api.AddUserModel({
        connectionId: h.connection.id,
        key: "wide-model",
        overrides: { context: 200_000, settings: { samplers: { openai_max_context: 200_000, openai_max_tokens: 512 } } }
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
      const placeholder = (speaker: EntityId) =>
        h.writer.AppendMessage({
          userId: h.userId,
          chatId,
          forkId: main,
          parentSlotId: slotAt(2_999),
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
            frozen: null,
            model: { connection: h.connection.id, model: wide.id }
          }),
          ({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot
        )
      const wrenRow = yield* placeholder(wren)
      const miraRow = yield* placeholder(mira)
      const forWren = sentText(yield* time("separate: Wren", assemble(wrenRow)))
      assert.include(forWren, "line 1000.")
      assert.notInclude(forWren, "line 1200.")
      assert.include(forWren, "line 2999.")
      const forMira = sentText(yield* time("separate: Mira", assemble(miraRow)))
      assert.include(forMira, "line 1200.")

      // The same reply in one shared context, for comparison.
      yield* event(slotAt(2_999), { key: "context.per_speaker", value: "shared" })
      const shared = sentText(yield* time("shared: Wren", assemble(wrenRow)))
      assert.include(shared, "line 1200.")

      // The summary-layer check over the whole path, straight on the database.
      const knew = yield* time(
        "knewThrough 3,000",
        Effect.gen(function* () {
          const db = yield* SqlClient.SqlClient
          const sources = sqlSources(db, {
            userId: h.userId,
            chatId,
            slotId: wrenRow.slotId,
            versionId: wrenRow.version.id
          })
          return yield* Effect.gen(function* () {
            const read = yield* AssemblySources
            return yield* read.knewThrough!(slotAt(2_999), wren, 2_999)
          }).pipe(Effect.provide(sources.layer))
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(config.dataDir), readonly: true })))
      )
      assert.isFalse(knew)

      // C9: one range overlay corrects 17,000+ shared swipes, without copying any messages.
      // A peer made before the mark/correction retains its exact request, even at owner scale.
      yield* event(slotAt(2_999), { key: "context.per_speaker", value: "separate" })
      const peer = (yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: main, atSlotId: slotAt(2_999) }))
        .fork.id
      const peerRow = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId,
        forkId: peer,
        parentSlotId: slotAt(2_999),
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: wren,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      const peerRequest = () =>
        Effect.map(
          h.reader.AssembleContext({
            userId: h.userId,
            chatId,
            forkId: peer,
            slotId: peerRow.slotId,
            versionId: peerRow.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null,
            model: { connection: h.connection.id, model: wide.id }
          }),
          (built) => (JSON.parse(built.snapshot) as ContextSnapshot).request
        )
      const peerBefore = yield* peerRequest()
      const shape = () =>
        fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT (SELECT count(*) FROM versions) AS versions, (SELECT count(*) FROM fork_overrides WHERE kind='presence_range') AS ranges, (SELECT sum(length(value_id)) FROM fork_overrides WHERE kind='presence_range') AS bytes"
            }
          ],
          { readOnly: true }
        )
      const shapeBefore = yield* shape()
      const mark = yield* event(slotAt(1_000), {
        key: "away.set",
        value: { entity: wren, away: true, source: "decision" }
      })
      const undoStart = performance.now()
      const undone = yield* h.writer.CorrectPresence({ userId: h.userId, chatId, forkId: main, eventId: mark.id })
      samples.push({ operation: "CorrectPresence", ms: performance.now() - undoStart })
      assert.isAbove(undone!.corrected.length, 10_000)
      yield* event(slotAt(2_999), { key: "context.per_speaker", value: "separate" })
      assert.include(sentText(yield* time("corrected separate: Wren", assemble(wrenRow))), "line 1200.")
      assert.deepStrictEqual(yield* peerRequest(), peerBefore, "untouched peer request and cache prefix")
      const shapeAfter = yield* shape()
      assert.strictEqual(shapeAfter[0]![0]!.versions, shapeBefore[0]![0]!.versions, "no swipe copies")
      assert.strictEqual(Number(shapeAfter[0]![0]!.ranges) - Number(shapeBefore[0]![0]!.ranges), 1)
      assert.isBelow(
        Number(shapeAfter[0]![0]!.bytes),
        2_000,
        "constant-size overlay for 3,000 messages and 20–50 swipes"
      )
      process.stdout.write(`BRANCH_CORRECTION_SHAPE ${JSON.stringify(shapeAfter[0]![0])}\n`)

      // C6: a second 3,000-message line, also with 20–50 swipes per position, frozen
      // into the owner-shape destination. Bring the older rows too, so projection reads
      // all 3,000 rows rather than just the small verbatim budget at the end.
      const source = yield* h.writer.CreateChat({
        userId: h.userId,
        kind: "rp",
        status: "active",
        title: "Scale docks",
        participants: [mira, wren],
        greeting: null
      })
      const sourceFirst = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: source.id,
        forkId: source.currentForkId!,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: mira,
          writer: "model",
          content: "MERGE-KNOWN: first dock line.",
          status: "complete",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      yield* sql([
        {
          sql: `INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,cast_json,presence_json,created_at,updated_at, authoring_fork_id)
          SELECT 'source-'||v.id, 'source-'||v.slot_id, v.ordinal, 'complete', ?, 'model',
            CASE WHEN cast(substr(v.slot_id,7) AS INTEGER)%2=0 THEN 'MERGE-KNOWN: ' ELSE 'MERGE-SECRET: ' END || v.content,
            'verbatim', 'generated', ?, CASE WHEN cast(substr(v.slot_id,7) AS INTEGER)%2=1 THEN ? END, v.created_at, v.updated_at
          , '${source.currentForkId!}' FROM version_records v WHERE v.slot_id LIKE 'main-s%'`,
          params: [mira, cast, away]
        },
        {
          sql: `INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
          SELECT 'source-'||s.id, ?, CASE WHEN s.id='main-s1' THEN ? ELSE 'source-'||s.parent_slot_id END,
            s.depth, 'source-'||s.selected_version_id, s.created_at, ?, ? FROM slots s WHERE s.id LIKE 'main-s%'`,
          params: [source.id, sourceFirst.slotId, source.currentForkId!, sourceFirst.slotId]
        },
        { sql: "UPDATE forks SET tip_slot_id='source-main-s2999' WHERE id=?", params: [source.currentForkId!] }
      ])
      const request = {
        userId: h.userId,
        chatId,
        forkId: main,
        at: null,
        source: { chatId: source.id, forkId: source.currentForkId! },
        includeLeftOut: true
      }
      const preview = yield* h.reader.PreviewChatMerge(request)
      const merged = yield* h.writer.MergeChat({
        ...request,
        title: preview.sourceTitle,
        framing: null,
        digest: preview.digest
      })
      const mergedReply = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId,
        forkId: main,
        parentSlotId: merged.slotId,
        branch: true,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: wren,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      const separateMerged = yield* time("merged separate: 3,000 rows", assemble(mergedReply))
      assert.include(sentText(separateMerged), "MERGE-KNOWN")
      assert.notInclude(sentText(separateMerged), "MERGE-SECRET")
      const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(separateMerged) })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt")
        assert.deepStrictEqual((JSON.parse(rebuilt.snapshot) as ContextSnapshot).request, separateMerged.request)
      yield* event(merged.slotId, { key: "context.per_speaker", value: "shared" })
      const sharedMerged = yield* time("merged shared: 3,000 rows", assemble(mergedReply))
      assert.include(sentText(sharedMerged), "MERGE-SECRET")
      assert.isBelow(
        samples.find((s) => s.operation === "merged separate: 3,000 rows")!.ms,
        samples.find((s) => s.operation === "merged shared: 3,000 rows")!.ms * 1.5 + 300
      )
      process.stdout.write(`CONTEXTS_SCALE ${JSON.stringify(samples)}\n`)
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      assert.isBelow(ms("separate: Wren"), ms("shared: Wren") * 1.5 + 200, "the filter adds at most a bounded share")
      assert.isBelow(ms("knewThrough 3,000"), 1_000)
      assert.isBelow(ms("CorrectPresence"), 1_000)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
