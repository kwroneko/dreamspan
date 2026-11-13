// Summaries at a separate join at the owner's shape (spec/THREADS.md TH7): a chat with one shared
// context and 300 branches whose threads part at its first message, the Lantern and the docks
// each 3,000 messages long with 20–50 versions on every docks message, the docks joined into the
// Lantern separately. Measures the join (it records its stretch), the summary plan after a reply
// (its stretch views: who missed what in the stretch), the summary UI for Wren and her next
// request through the real workers. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/threadSummariesScale.test.ts
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

it.live(
  "a separate join of two 3,000-message threads in a chat with 300 branches",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0 })
      const main = h.chat.currentForkId! as ForkId
      const chatId = h.chat.id as ChatId
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
      const event = (data: StateEventData) =>
        h.writer.AddStateEvent({
          userId: h.userId,
          chatId,
          forkId: main,
          slotId: null,
          versionId: null,
          scope: null,
          data
        })
      yield* event({ key: "participant.join", value: { entity: mira } })
      yield* event({ key: "participant.join", value: { entity: wren } })
      const say = (forkId: ForkId, parent: SlotId | null, content: string, branch = false) =>
        h.writer.AppendMessage({
          userId: h.userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
      const S = (yield* say(main, null, "The ferry docks at dusk.")).slotId as SlotId
      const rowVersion = (slotId: SlotId, forkId: ForkId) =>
        Effect.map(h.reader.GetSlot({ userId: h.userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
      const started = yield* h.api.StartThreads({
        chatId,
        forkId: main,
        slotId: S,
        expectedRowVersion: yield* rowVersion(S, main),
        threads: [
          { name: "At the Lantern", cast: [mira], writesAs: null },
          { name: "At the docks", cast: [wren], writesAs: null }
        ]
      })
      const docks = started.forkIds[1]!
      const first = (yield* say(docks, S, "Wren walks down to the water.")).slotId as SlotId
      const lantern = (yield* say(main, S, "Mira takes a room at the Lantern.")).slotId as SlotId
      const cast = JSON.stringify([mira, wren])
      // One line of 3,000 messages under `head` in `fork`, read by the one of the two who was there.
      const line = (prefix: string, head: SlotId, fork: ForkId, speaker: EntityId, away: EntityId, text: string) => [
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,presence_json,created_at,updated_at,authoring_fork_id)
            SELECT '${prefix}-v'||x, '${prefix}-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, '${text}, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, ?, ?, x, x, '${fork}' FROM n`,
          params: [speaker, cast, JSON.stringify({ away: [away] })]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
            SELECT '${prefix}-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE '${prefix}-s'||(x-1) END,
              (SELECT depth FROM slots WHERE id = ?) + x, '${prefix}-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
          params: [chatId, head, head, fork, head]
        },
        { sql: `UPDATE forks SET tip_slot_id = '${prefix}-s2999' WHERE id = ?`, params: [fork] }
      ]
      yield* fixtureSql(config.dataDir, [
        ...line("docks", first, docks, wren, mira, "The docks at night"),
        ...line("lantern", lantern, main, mira, wren, "The Lantern at night"),
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999),
              k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
            INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,
              cast_json,presence_json,created_at,updated_at,authoring_fork_id)
            SELECT 'docks-v'||x||'-'||j, 'docks-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
              'verbatim', 'generated', ?, ?, x, x, '${docks}' FROM n JOIN k ON j < 20 + (x % 31)`,
          params: [wren, cast, JSON.stringify({ away: [mira] })]
        }
      ])
      // 300 branches: made from the Lantern after the split, so they're its own branches.
      for (let b = 0; b < 300; b++) {
        const made = yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: main, atSlotId: lantern })
        yield* say(made.fork.id as ForkId, lantern, `Branch ${b} turns aside.`, true)
      }
      const library = yield* h.reader.ShellLibrary({ userId: h.userId })
      yield* h.writer.StoreForkSummaries({ userId: h.userId, chats: library.fresh })

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
      const preview = yield* h.api.PreviewChatMerge({
        chatId,
        forkId: main,
        at: null,
        source: { chatId, forkId: docks },
        includeLeftOut: false,
        timelines: "separate"
      })
      assert.strictEqual(preview.messages, 3_000)
      const joined = yield* time(
        "JoinThreads, separately",
        h.api.JoinThreads({
          chatId,
          forkId: main,
          at: null,
          includeLeftOut: false,
          timelines: "separate",
          joins: [{ forkId: docks, title: preview.sourceTitle, framing: null, digest: preview.digest }]
        }),
        1
      )
      const J = joined.entries[0]!.slotId as SlotId
      const after = yield* say(main, J, "Morning comes to the harbor.")
      const leafSlotId = after.slotId as SlotId
      const [[recorded]] = (yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: `SELECT count(*) AS n FROM thread_stretch_slots t JOIN chat_merges m ON m.id = t.merge_id
              WHERE m.slot_id = ? AND t.opens = 0`,
            params: [J]
          }
        ],
        { readOnly: true }
      )) as unknown as [[{ n: number }]]
      assert.strictEqual(recorded.n, 3_001, "the Lantern's 3,000 messages after S and the join")

      const plan = yield* time(
        "PlanSummaries after a reply",
        h.summarizer.planNow({ userId: h.userId, chatId, leafSlotId }, "reply"),
        1
      )
      assert.isNotEmpty(plan, "the shared plan begins")
      yield* time("GetLcmState for Wren", h.reader.GetLcmState({ userId: h.userId, chatId, leafSlotId, viewer: wren }))
      const placeholder = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId,
        forkId: main,
        parentSlotId: leafSlotId,
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
      const built = yield* time(
        "AssembleContext for Wren",
        h.reader.AssembleContext({
          userId: h.userId,
          chatId,
          slotId: placeholder.slotId,
          versionId: placeholder.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: placeholder.forkId
        })
      )
      assert.notInclude(built.snapshot, "The Lantern at night, line 2999.")
      // The agent's search as Wren's reply runs it (TH8): the path, the join's 3,000 rows, her knowledge.
      const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
      const search = (query: string) =>
        Effect.suspend(() =>
          historyTools
            .find((tool) => tool.id === "search_chat")!
            .execute(
              {
                userId: h.userId,
                chatId,
                forkId: placeholder.forkId as ForkId,
                slotId: placeholder.slotId,
                versionId: placeholder.version.id,
                leafSlotId,
                viewers: generationOf(snapshot).viewers,
                rolloutId: "test",
                toolCallId: "test",
                cache: new Map(),
                reader: h.reader,
                writer: h.writer
              } satisfies ToolContext,
              { query } as never
            )
        )
      const found = yield* time("search_chat for Wren", search("docks night 2999"))
      assert.include(found.text, "(At the docks #")
      assert.include((yield* search("Lantern night 2999")).text, "No earlier messages match")

      process.stdout.write(`THREAD_SUMMARIES_SCALE ${JSON.stringify(samples)}\n`)
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      assert.isBelow(ms("JoinThreads, separately"), 1_500)
      assert.isBelow(ms("PlanSummaries after a reply"), 6_000)
      assert.isBelow(ms("GetLcmState for Wren"), 500)
      assert.isBelow(ms("AssembleContext for Wren"), 3_000)
      assert.isBelow(ms("search_chat for Wren"), 3_000)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
