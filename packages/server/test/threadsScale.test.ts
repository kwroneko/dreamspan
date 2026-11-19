// Parallel threads at the owner's shape (spec/THREADS.md TH2): a 3,000-message path with 20–50
// versions on every message and 300 branches, Mira and Wren present throughout, set to separate
// contexts. Threads start at message 1,000, so about 2,000 played messages get Wren's
// correction, and nine more splits start at branch tips (ten in all). Measures StartThreads,
// ListForks, ThreadsOf, Wren's and Mira's next reply in the first thread, Undo and restore,
// through the real workers. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/threadsScale.test.ts
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")

it.live(
  "threads at 3,000 messages, 300 branches, 20–50 swipes and ten splits",
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
      yield* sql([
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x, 'main-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, 'The lantern road goes on, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, ?, x, x, '${main}' FROM n`,
          params: [mira, cast]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
            SELECT 'main-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE 'main-s'||(x-1) END,
              (SELECT depth FROM slots WHERE id = ?) + x, 'main-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
          params: [chatId, first, first, main, first]
        },
        { sql: "UPDATE forks SET tip_slot_id = 'main-s2999' WHERE id = ?", params: [main] },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999),
              k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x||'-'||j, 'main-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', ?, x, x, '${main}' FROM n JOIN k ON j < 20 + (x % 31)`,
          params: [mira, cast]
        }
      ])
      const slotAt = (depth: number) => (depth === 0 ? first : (`main-s${depth}` as SlotId))
      const branches: Array<{ fork: ForkId; tip: SlotId }> = []
      for (let b = 0; b < 300; b++) {
        const at = slotAt(100 + ((b * 137) % 2_850))
        const made = yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: main, atSlotId: at })
        const row = yield* h.writer.AppendMessage({
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
        branches.push({ fork: made.fork.id as ForkId, tip: row.slotId as SlotId })
      }

      const samples: Array<{ operation: string; ms: number }> = []
      const time = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>, runs = 3) =>
        Effect.gen(function* () {
          const times: Array<number> = []
          let result: A | undefined
          for (let i = 0; i < runs; i++) {
            const start = performance.now()
            result = yield* effect
            times.push(performance.now() - start)
          }
          samples.push({ operation, ms: median(times) })
          return result as A
        })
      const rowVersion = (slotId: SlotId, forkId: ForkId) =>
        Effect.map(h.reader.GetSlot({ userId: h.userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
      const threads = [
        { name: "At the Lantern", cast: [mira], writesAs: null },
        { name: "At the docks", cast: [wren], writesAs: null }
      ]

      // The shell stores the forks' summaries as it lists them; reads then cost stored rows.
      const settle = Effect.gen(function* () {
        const library = yield* h.reader.ShellLibrary({ userId: h.userId })
        yield* h.writer.StoreForkSummaries({ userId: h.userId, chats: library.fresh })
      })
      yield* time("ListForks before threads, unsettled", h.api.ListForks({ chatId }), 1)
      yield* settle
      yield* time("ListForks before threads", h.api.ListForks({ chatId }))
      // Nine splits at branch tips (nothing played after them), then the one at message 1,000.
      for (const { fork, tip } of branches.slice(0, 9))
        yield* h.api.StartThreads({
          chatId,
          forkId: fork,
          slotId: tip,
          expectedRowVersion: yield* rowVersion(tip, fork),
          threads
        })
      const S = slotAt(1_000)
      const expected = yield* rowVersion(S, main)
      const started = yield* time(
        "StartThreads at 1,000",
        h.api.StartThreads({ chatId, forkId: main, slotId: S, expectedRowVersion: expected, threads }),
        1
      )
      const [corrections] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT count(*) AS n FROM fork_overrides WHERE kind = 'presence_away' AND flag = 1" }],
        { readOnly: true }
      )
      assert.isAtLeast((corrections![0] as { n: number }).n, 1_999)

      // Each split touched only its branch's summary: the next listing computes those ten.
      yield* time("ThreadsOf, ten summaries to compute", h.api.ThreadsOf({ chatId, forkId: main }), 1)
      yield* settle
      const forks = yield* time("ListForks", h.api.ListForks({ chatId }))
      assert.strictEqual(forks.filter((f) => f.threads !== undefined).length, 20)
      const sets = yield* time("ThreadsOf", h.api.ThreadsOf({ chatId, forkId: main }))
      assert.strictEqual(sets[0]!.splitId, started.splitId)

      // TH3 shell additions: the open chat and a bounded page across many chats.
      for (let i = 0; i < 30; i++) yield* h.api.CreateChat({ title: `Synthetic neighbor ${i}` })
      yield* settle
      const shell = yield* time(
        "ShellForks: ten splits, 300 branches, 31 chats",
        h.api.GetShellForks({
          entity: null,
          chat: chatId,
          search: "",
          sort: "recent",
          sections: [
            { id: "threads", limit: 100 },
            { id: "other", limit: 500 }
          ]
        })
      )
      assert.strictEqual(shell.sections[0]!.rows.length, 20)
      assert.isTrue(shell.sections[0]!.rows.every((row) => row.thread !== undefined))
      const page = yield* time(
        "ShellForks: bounded global page",
        h.api.GetShellForks({
          entity: null,
          chat: null,
          search: "",
          sort: "recent",
          sections: [{ id: "all", limit: 100 }]
        })
      )
      assert.strictEqual(page.sections[0]!.rows.length, 100)
      assert.isBelow(new TextEncoder().encode(JSON.stringify(page)).length, 600_000)

      const wide = yield* h.api.AddUserModel({
        connectionId: h.connection.id,
        key: "wide-model",
        overrides: { context: 200_000, settings: { samplers: { openai_max_context: 200_000, openai_max_tokens: 512 } } }
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
            forkId: row.forkId,
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
      const forWren = sentText(yield* time("first thread: Wren", assemble(wrenRow)))
      assert.include(forWren, "line 1000.")
      assert.notInclude(forWren, "line 2000.")
      const forMira = sentText(yield* time("first thread: Mira", assemble(miraRow)))
      assert.include(forMira, "line 2000.")

      const item = yield* time("UndoThreads", h.api.UndoThreads({ chatId, splitId: started.splitId }), 1)
      assert.include(sentText(yield* assemble(wrenRow)), "line 2000.")
      yield* time("restore", h.api.RestoreBinItem({ itemId: item.id }), 1)
      assert.notInclude(sentText(yield* assemble(wrenRow)), "line 2000.")

      process.stdout.write(`THREADS_SCALE ${JSON.stringify(samples)}\n`)
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      assert.isBelow(ms("StartThreads at 1,000"), 10_000)
      assert.isBelow(ms("ListForks"), ms("ListForks before threads") * 1.5 + 200, "threads add a bounded share")
      assert.isBelow(ms("ThreadsOf"), 300)

      assert.isBelow(
        ms("first thread: Wren"),
        ms("first thread: Mira") * 1.5 + 500,
        "the correction adds a bounded share"
      )
      assert.isBelow(ms("UndoThreads"), 10_000)
      assert.isBelow(ms("restore"), 10_000)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
