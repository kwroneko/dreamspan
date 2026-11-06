// Merging at the owner's shape (spec/CHAT-MERGE.md §9): a chat of 3,000 messages with 20–50
// versions on every third, 200 branches, and a source branch of 1,000 messages of its own; and an
// unrelated chat of 3,000 messages. Measures the preview, the write and the next reply's assembly
// through the real workers, and checks what the merge brought. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1 [CHATMERGE_SCALE_OUT=…jsonl]
//   npx vitest run --project server-slow packages/server/test/chatMergeScale.test.ts
import { appendFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

it.live(
  "merging at 3,000 messages, 200 branches and 20–50 swipes",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 1, settings: { enabled: false } })
      const main = h.chat.currentForkId! as ForkId
      const chatId = h.chat.id as ChatId
      const sql = (statements: Parameters<typeof fixtureSql>[1]) => fixtureSql(config.dataDir, statements)
      /** `n` messages after `tip` on `forkId`, alternating sides; the fork's tip moves to the last. */
      const extend = (chat: string, forkId: string, tip: string, tag: string, n: number) =>
        Effect.gen(function* () {
          yield* sql([
            {
              sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${n})
                INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
                SELECT ?||'-v'||x, ?||'-s'||x, 0, 'complete', NULL, CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END,
                  'The lantern road goes on, ' || ? || ' line '||x||'.', 'verbatim',
                  CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, x, x FROM n`,
              params: [tag, tag, tag]
            },
            {
              sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${n})
                INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
                SELECT ?||'-s'||x, ?,
                  CASE WHEN x = 1 THEN ? ELSE ?||'-s'||(x-1) END,
                  (SELECT depth FROM slots WHERE id = ?) + x, ?||'-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
              params: [tag, chat, tip, tag, tip, tag, forkId, tip]
            },
            { sql: "UPDATE forks SET tip_slot_id = ? WHERE id = ?", params: [`${tag}-s${n}`, forkId] }
          ])
          return `${tag}-s${n}` as SlotId
        })
      const started = performance.now()
      const first = h.rows[0]!.slotId
      const tip = yield* extend(chatId, main, first, "main", 2_999)
      // 20–50 versions on every third message.
      yield* sql([
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 3 UNION ALL SELECT x+3 FROM n WHERE x < 2997),
              k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
            SELECT 'main-v'||x||'-'||j, 'main-s'||x, j, 'complete', NULL, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', x, x FROM n JOIN k ON j < 20 + (x % 31)`
        }
      ])
      // 200 branches, each with a message of its own.
      const slotAt = (depth: number) => (depth === 0 ? first : (`main-s${depth}` as SlotId))
      for (let b = 0; b < 200; b++) {
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
      // The source: a branch from #2,001 with 1,000 messages of its own.
      const base = slotAt(2_000)
      const side = yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: main, atSlotId: base })
      const sideFirst = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId,
        forkId: side.fork.id,
        parentSlotId: base,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "The side road starts here.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      yield* extend(chatId, side.fork.id, sideFirst.slotId, "side", 999)
      // An unrelated chat of 3,000 messages.
      const other = yield* h.writer.CreateChat({
        userId: h.userId,
        kind: "rp",
        status: "active",
        title: "Far docks",
        participants: [],
        greeting: null
      })
      const otherFirst = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: other.id,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "The far docks wake.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      yield* extend(other.id, other.currentForkId!, otherFirst.slotId, "far", 2_999)
      const fixtureMs = performance.now() - started
      const [counts] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT (SELECT count(*) FROM slots) AS slots, (SELECT count(*) FROM versions) AS versions, (SELECT count(*) FROM forks) AS forks"
          }
        ],
        { readOnly: true }
      )
      console.log("CHATMERGE_READY", JSON.stringify(counts![0]), Math.round(fixtureMs))

      const samples: Array<{ operation: string; ms: number }> = []
      const time = <A, E, R>(operation: string, runs: number, effect: Effect.Effect<A, E, R>) =>
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
      // A model whose window holds the merged section, as a long-context model's does.
      const wide = yield* h.api.AddUserModel({
        connectionId: h.connection.id,
        key: "wide-model",
        overrides: { context: 200_000, settings: { samplers: { openai_max_context: 200_000, openai_max_tokens: 512 } } }
      })
      const assembleAfter = (leaf: { slotId: SlotId; version: { id: VersionId } }) =>
        Effect.map(
          h.reader.AssembleContext({
            userId: h.userId,
            chatId,
            forkId: main,
            slotId: leaf.slotId,
            versionId: leaf.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null,
            model: { connection: h.connection.id, model: wide.id }
          }),
          ({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot
        )

      // A branch of the same chat: only the 1,000 after the base come in.
      const branchRequest = {
        userId: h.userId,
        chatId,
        forkId: main,
        at: null,
        source: { chatId, forkId: side.fork.id as ForkId },
        includeLeftOut: false
      }
      const seen = yield* time("preview branch", 3, h.reader.PreviewChatMerge(branchRequest))
      assert.strictEqual(seen.shared, 2_001)
      assert.strictEqual(seen.messages, 1_000)
      assert.strictEqual(seen.start?.number, 2_002)
      const made = yield* time(
        "merge branch",
        1,
        h.writer.MergeChat({ ...branchRequest, title: seen.sourceTitle, framing: null, digest: seen.digest })
      )
      assert.strictEqual(made.position, 3_000)
      const reply = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId,
        forkId: main,
        parentSlotId: made.slotId,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "After the merge.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const built = yield* time("assemble after merge", 3, assembleAfter(reply))
      const text = built.request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")
      assert.include(text, "[Here “")
      assert.include(text, "side line 999.")

      // An unrelated chat, its span from #2,501, merged below #2,800 (an insert in the middle).
      const farRequest = {
        userId: h.userId,
        chatId,
        forkId: main,
        at: slotAt(2_799),
        source: { chatId: other.id as ChatId, forkId: other.currentForkId! as ForkId },
        start: slotAt(2_500),
        includeLeftOut: false
      }
      const far = yield* time("preview unrelated", 3, h.reader.PreviewChatMerge(farRequest))
      assert.strictEqual(far.shared, 0)
      assert.strictEqual(far.messages, 3_000)
      assert.isAbove(far.leftOut, 0)
      assert.isAtMost(far.tokens, far.budget + 200)
      const all = yield* time(
        "preview unrelated, all included",
        3,
        h.reader.PreviewChatMerge({ ...farRequest, includeLeftOut: true })
      )
      assert.strictEqual(all.leftOut, 3_000 - far.verbatim)
      const farMade = yield* time(
        "merge unrelated mid-history",
        1,
        h.writer.MergeChat({ ...farRequest, title: far.sourceTitle, framing: null, digest: far.digest })
      )
      assert.strictEqual(farMade.position, 2_800)
      yield* time("assemble after two merges", 3, assembleAfter(reply))
      yield* time(
        "merged messages page",
        3,
        h.reader.MergeMessages({
          userId: h.userId,
          chatId,
          mergeId: (yield* h.reader.GetMerge({ userId: h.userId, chatId, slotId: farMade.slotId })).id,
          offset: 2_800,
          limit: 200
        })
      )
      const result = { ...counts![0], fixtureMs: Math.round(fixtureMs), samples, tip }
      console.log("CHATMERGE_SCALE", JSON.stringify(result))
      if (process.env.CHATMERGE_SCALE_OUT)
        appendFileSync(process.env.CHATMERGE_SCALE_OUT, JSON.stringify(result) + "\n")
      for (const sample of samples) assert.isBelow(sample.ms, 5_000, sample.operation)
    }).pipe(Effect.scoped, Effect.provide(server.layer)) as Effect.Effect<void, unknown, never>
  },
  30 * 60_000
)
