// Moving messages at the owner's shape (owner, 2026-11-16): a 5,000-message path with 20–50
// versions on every message, 300 branches and 400 moves in the main line (some of them moved
// several places, up and down, across branch points), then 60 branches made at and around moved
// messages, which follow the main line's order there with rows of their own. Measures the writer
// (MoveMessage, UndoMove, CreateFork, InsertMessage, AppendMessage, DeleteMessages) and the reads
// (GetPath windows, AssembleContext, ListForks) against a branch without moves, through the real
// workers. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/messageMoveScale.test.ts
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!
const MESSAGES = 5_000

it.live(
  "moves at 5,000 messages, 300 branches, 20–50 swipes and 400 moves",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0, settings: { enabled: false } })
      const main = h.chat.currentForkId! as ForkId
      const chatId = h.chat.id as ChatId
      const userId = h.userId
      const sql = (statements: Parameters<typeof fixtureSql>[1]) => fixtureSql(config.dataDir, statements)
      const mira = (yield* h.writer.CreateEntity({
        userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).entityId as EntityId
      yield* h.writer.AddStateEvent({
        userId,
        chatId,
        forkId: main,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: mira } }
      })
      const first = (yield* h.append("The lantern road begins.")).slotId
      const last = MESSAGES - 1
      yield* sql([
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${last})
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x, 'main-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, 'The lantern road goes on, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, x, x, '${main}' FROM n`,
          params: [mira]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${last})
            INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
            SELECT 'main-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE 'main-s'||(x-1) END,
              (SELECT depth FROM slots WHERE id = ?) + x, 'main-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
          params: [chatId, first, first, main, first]
        },
        { sql: `UPDATE forks SET tip_slot_id = 'main-s${last}' WHERE id = ?`, params: [main] },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${last}),
              k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              created_at,updated_at,authoring_fork_id)
            SELECT 'main-v'||x||'-'||j, 'main-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', x, x, '${main}' FROM n JOIN k ON j < 20 + (x % 31)`,
          params: [mira]
        }
      ])
      const slotAt = (depth: number) => (depth === 0 ? first : (`main-s${depth}` as SlotId))
      const said = (content: string) =>
        new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      const fork = (from: ForkId, at: SlotId | null) =>
        Effect.map(
          h.writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }),
          (made) => made.fork.id as ForkId
        )

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
      /** Every run of `effect`, timed one by one: the writer's samples. */
      const each: Record<string, Array<number>> = {}
      const timed = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const start = performance.now()
          const result = yield* effect
          ;(each[operation] ??= []).push(performance.now() - start)
          return result
        })

      // 300 branches made before any move, each with a message of its own.
      const plain: Array<ForkId> = []
      for (let b = 0; b < 300; b++) {
        const at = slotAt(100 + ((b * 137) % 4_850))
        const made = yield* fork(main, at)
        yield* h.writer.AppendMessage({
          userId,
          chatId,
          forkId: made,
          parentSlotId: at,
          branch: false,
          commitDraft: null,
          version: said(`Branch ${b} turns aside.`)
        })
        plain.push(made)
      }
      const quiet = yield* fork(main, slotAt(last))

      // 400 moves in the main line, across the branch points: 200 messages moved one to four places.
      const move = (slotId: SlotId, direction: "up" | "down") =>
        timed(
          "MoveMessage",
          h.writer.MoveMessage({ userId, chatId, forkId: main, slotId, direction, expectedRowVersion: 0 })
        )
      let moves = 0
      const moved: Array<SlotId> = []
      for (let k = 0; moves < 400; k++) {
        const slot = slotAt(50 + ((k * 211) % 4_900))
        const direction = k % 3 === 0 ? "up" : "down"
        for (let step = 0; step < 1 + (k % 4) && moves < 400; step++) {
          yield* move(slot, direction)
          moves++
        }
        moved.push(slot)
      }
      const undone = yield* h.writer.MoveMessage({
        userId,
        chatId,
        forkId: main,
        slotId: slotAt(2_500),
        direction: "down",
        expectedRowVersion: 0
      })
      yield* timed("UndoMove", h.writer.UndoMove({ userId, chatId, forkId: main, undo: undone.undo }))

      // 60 branches at moved messages and next to them: each follows the main line's order there.
      const following: Array<ForkId> = []
      for (const [i, slot] of moved.slice(0, 30).entries()) {
        following.push(yield* timed("CreateFork at a moved message", fork(main, slot)))
        following.push(yield* timed("CreateFork beside a moved message", fork(main, slotAt(60 + ((i * 211) % 4_900)))))
      }
      // The worst case: a message moved to the very top, and a branch made there, which leaves
      // everything below it out.
      const top = slotAt(4_000)
      const [row] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT count(*) AS n FROM fork_overrides WHERE kind = 'move'" }],
        { readOnly: true }
      )
      const rowsBefore = (row![0] as { n: number }).n
      const topFork = yield* fork(main, slotAt(last))
      for (let i = 0; i < 4; i++)
        yield* h.writer.MoveMessage({
          userId,
          chatId,
          forkId: topFork,
          slotId: top,
          direction: "up",
          expectedRowVersion: 0
        })
      yield* sql([
        // Straight to the top: a move above the first message, as moving it up 4,000 times would write.
        {
          sql: `UPDATE fork_overrides SET value_id = NULL WHERE fork_id = ? AND kind = 'move' AND target_id = ?`,
          params: [topFork, top]
        }
      ])
      const atTop = yield* timed("CreateFork at a message moved to the top", fork(topFork, top))
      const path = yield* h.reader.GetPath({ userId, chatId, forkId: atTop, leafSlotId: null, limit: 10 })
      assert.deepStrictEqual(
        path.entries.map((e) => e.slotId),
        [top]
      )

      // The writer with moves in force: inserting, sending and deleting in the main line.
      for (let i = 0; i < 5; i++) {
        yield* timed(
          "InsertMessage",
          h.writer.InsertMessage({
            userId,
            chatId,
            forkId: main,
            anchorSlotId: moved[i * 7]!,
            expectedRowVersion: 0,
            body: { _tag: "Write", speaker: mira, content: `Inserted ${i}.` }
          })
        )
        const tip = (yield* h.reader.GetPath({ userId, chatId, forkId: main, leafSlotId: null, limit: 1 })).tipSlotId
        yield* timed(
          "AppendMessage",
          h.writer.AppendMessage({
            userId,
            chatId,
            forkId: main,
            parentSlotId: tip,
            branch: false,
            commitDraft: null,
            version: said(`Sent ${i}.`)
          })
        )
        yield* timed(
          "DeleteMessages",
          h.writer.DeleteMessages({ userId, forkId: main, slotIds: [moved[i * 7 + 3]!] as never })
        )
      }
      for (const [operation, ms] of Object.entries(each)) samples.push({ operation, ms: median(ms) })
      for (const [operation, ms] of Object.entries(each))
        samples.push({ operation: `${operation} (max)`, ms: Math.max(...ms) })

      // Reads: windows, assembly and the branch list, against a branch without moves.
      const window = (forkId: ForkId) => h.reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 })
      yield* time("GetPath newest 100, no moves", window(quiet))
      const newest = yield* time("GetPath newest 100, 400 moves", window(main))
      const older = (forkId: ForkId, leaf: SlotId) =>
        h.reader.GetPath({ userId, chatId, forkId, leafSlotId: leaf, limit: 100 })
      yield* time("GetPath at 2,500, no moves", older(quiet, slotAt(2_500)))
      yield* time("GetPath at 2,500, 400 moves", older(main, newest.entries[0]!.slotId))
      const full = (forkId: ForkId) =>
        Effect.gen(function* () {
          let leaf: SlotId | null = null
          let n = 0
          for (;;) {
            const page: { entries: ReadonlyArray<unknown>; olderLeafSlotId: SlotId | null } = yield* h.reader.GetPath({
              userId,
              chatId,
              forkId,
              leafSlotId: leaf,
              limit: 1000
            })
            n += page.entries.length
            if (page.olderLeafSlotId === null) return n
            leaf = page.olderLeafSlotId
          }
        })
      assert.isAtLeast(yield* time("GetPath whole, no moves", full(quiet), 1), MESSAGES)
      assert.isAtLeast(yield* time("GetPath whole, 400 moves", full(main), 1), MESSAGES)

      const wide = yield* h.api.AddUserModel({
        connectionId: h.connection.id,
        key: "wide-model",
        overrides: { context: 200_000, settings: { samplers: { openai_max_context: 200_000, openai_max_tokens: 512 } } }
      })
      const assemble = (forkId: ForkId) =>
        Effect.gen(function* () {
          const tip = (yield* h.reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 1 })).tipSlotId
          const row = yield* h.writer.AppendMessage({
            userId,
            chatId,
            forkId,
            parentSlotId: tip,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: mira,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          return h.reader
            .AssembleContext({
              userId,
              chatId,
              forkId,
              slotId: row.slotId,
              versionId: row.version.id,
              now: 1,
              timeZone: "UTC",
              frozen: null,
              model: { connection: h.connection.id, model: wide.id }
            })
            .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
        })
      const sentLines = (snapshot: ContextSnapshot) => snapshot.request.messages.length
      const quietAssembly = yield* assemble(quiet)
      const mainAssembly = yield* assemble(main)
      assert.isAbove(sentLines(yield* time("AssembleContext, no moves", quietAssembly)), 1_000)
      assert.isAbove(sentLines(yield* time("AssembleContext, 400 moves", mainAssembly)), 1_000)
      yield* time("AssembleContext, a branch at a moved message", yield* assemble(following[0]!))
      yield* time("ListForks, 363 branches", h.api.ListForks({ chatId }), 1)
      yield* time("ListForks, 363 branches, settled", h.api.ListForks({ chatId }))

      const [after] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT count(*) AS n FROM fork_overrides WHERE kind = 'move'" }],
        { readOnly: true }
      )
      process.stdout.write(
        `MOVE_SCALE ${JSON.stringify({ samples, moveRows: (after![0] as { n: number }).n, rowsBefore })}\n`
      )
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      // The writer holds no transaction past the bound other writes are held to (1.5 s).
      for (const operation of Object.keys(each)) assert.isBelow(ms(`${operation} (max)`), 1_500, operation)
      // Moves add a bounded share to reads.
      for (const [moves, none] of [
        ["GetPath newest 100, 400 moves", "GetPath newest 100, no moves"],
        ["GetPath at 2,500, 400 moves", "GetPath at 2,500, no moves"],
        ["GetPath whole, 400 moves", "GetPath whole, no moves"],
        ["AssembleContext, 400 moves", "AssembleContext, no moves"]
      ] as const)
        assert.isBelow(ms(moves), ms(none) * 1.5 + 200, moves)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  1_800_000
)
