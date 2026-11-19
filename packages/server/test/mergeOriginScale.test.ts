// Merging another chat with separate origins at the owner's shape (merge2, item 056): both chats
// have 3,000 messages with 20–50 versions on every third and 300 branches. Measures the preview,
// the write and each side's next request through the real workers, beside a merge read together,
// and checks what each side reads. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1 [MERGE_ORIGIN_SCALE_OUT=…jsonl]
//   npx vitest run --project server-slow packages/server/test/mergeOriginScale.test.ts
import { appendFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"
import { sentText } from "./support/threadStory.ts"

const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

it.live(
  "a merge kept separate at 3,000 messages, 300 branches and 20–50 swipes on both sides",
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0, settings: { enabled: false } })
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
          (c) => c.entityId as EntityId
        )
      const mira = yield* card("Mira")
      const kai = yield* card("Kai")
      const say = (chatId: ChatId, forkId: ForkId, parent: SlotId | null, speaker: EntityId, content: string) =>
        h.writer.AppendMessage({
          userId: h.userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
      /** A chat of `n` messages by `speaker` (cast: `speaker`), 20–50 versions on every third, 300 branches. */
      const build = (title: string, speaker: EntityId, tag: string, n: number) =>
        Effect.gen(function* () {
          const chat = yield* h.writer.CreateChat({
            userId: h.userId,
            kind: "rp",
            status: "active",
            title,
            participants: [speaker],
            greeting: null
          })
          const chatId = chat.id as ChatId
          const forkId = chat.currentForkId! as ForkId
          const first = yield* say(chatId, forkId, null, speaker, `${tag} begins.`)
          const cast = JSON.stringify([speaker])
          yield* sql([
            {
              sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${n - 1})
                INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id,cast_json)
                SELECT ?||'-v'||x, ?||'-s'||x, 0, 'complete', ?, 'model', ? || ' line '||x||'.', 'verbatim', 'generated', x, x, ?, ? FROM n`,
              params: [tag, tag, speaker, tag, forkId, cast]
            },
            {
              sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${n - 1})
                INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
                SELECT ?||'-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE ?||'-s'||(x-1) END,
                  (SELECT depth FROM slots WHERE id = ?) + x, ?||'-v'||x, x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
              params: [tag, chatId, first.slotId, tag, first.slotId, tag, forkId, first.slotId]
            },
            { sql: "UPDATE forks SET tip_slot_id = ? WHERE id = ?", params: [`${tag}-s${n - 1}`, forkId] },
            {
              sql: `WITH RECURSIVE n(x) AS (SELECT 3 UNION ALL SELECT x+3 FROM n WHERE x < ${n - 3}),
                  k(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM k WHERE j < 49)
                INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id,cast_json)
                SELECT ?||'-v'||x||'-'||j, ?||'-s'||x, j, 'complete', ?, 'model', 'Another telling of ' || ? || ' line '||x||', take '||j||'.',
                  'verbatim', 'generated', x, x, ?, ? FROM n JOIN k ON j < 20 + (x % 31)`,
              params: [tag, tag, speaker, tag, forkId, cast]
            }
          ])
          for (let b = 0; b < 300; b++) {
            const at = `${tag}-s${100 + ((b * 137) % (n - 150))}` as SlotId
            const made = yield* h.writer.CreateFork({ userId: h.userId, chatId, fromForkId: forkId, atSlotId: at })
            yield* say(chatId, made.fork.id as ForkId, at, speaker, `${tag} branch ${b} turns aside.`)
          }
          return { chatId, forkId, tip: `${tag}-s${n - 1}` as SlotId }
        })
      const started = performance.now()
      const ledger = yield* build("Ledger", mira, "HOME", 3_000)
      const pier = yield* build("Pier", kai, "DOCKS", 3_000)
      // Overlap the casts so the preview/write must check destination participation at
      // scale (including its many retained swipes). Mira never read Pier's earlier rows.
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: pier.chatId,
        forkId: pier.forkId,
        slotId: pier.tip,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: mira } }
      })
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
      console.log("MERGE_ORIGIN_READY", JSON.stringify(counts![0]), Math.round(fixtureMs))

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
      const wide = yield* h.api.AddUserModel({
        connectionId: h.connection.id,
        key: "wide-model",
        overrides: { context: 200_000, settings: { samplers: { openai_max_context: 200_000, openai_max_tokens: 512 } } }
      })
      /** The request of a reply by `speaker` at the Ledger's tip, through a 200k-token window. */
      const requestBy = (forkId: ForkId, speaker: EntityId) =>
        Effect.gen(function* () {
          const path = yield* h.reader.ReadPath({
            userId: h.userId,
            chatId: ledger.chatId,
            forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })
          const placeholder = yield* h.writer.AppendMessage({
            userId: h.userId,
            chatId: ledger.chatId,
            forkId,
            parentSlotId: path.entries.at(-1)!.slotId,
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
            chatId: ledger.chatId,
            forkId: placeholder.forkId,
            slotId: placeholder.slotId,
            versionId: placeholder.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null,
            model: { connection: h.connection.id, model: wide.id }
          })
          return JSON.parse(built.snapshot) as ContextSnapshot
        })
      const before = yield* time("Mira's request before the merge", 3, requestBy(ledger.forkId, mira))

      // A branch of the Ledger from its tip, merged together, for comparison.
      const together = (yield* h.writer.CreateFork({
        userId: h.userId,
        chatId: ledger.chatId,
        fromForkId: ledger.forkId,
        atSlotId: ledger.tip
      })).fork.id as ForkId
      const request = (forkId: ForkId, timelines: "together" | "separate") => ({
        userId: h.userId,
        chatId: ledger.chatId,
        forkId,
        at: ledger.tip,
        source: { chatId: pier.chatId, forkId: pier.forkId },
        includeLeftOut: false,
        timelines
      })
      const seenTogether = yield* time("preview together", 3, h.reader.PreviewChatMerge(request(together, "together")))
      yield* time(
        "merge together",
        1,
        h.writer.MergeChat({
          ...request(together, "together"),
          title: "Pier",
          framing: null,
          digest: seenTogether.digest
        })
      )
      const seen = yield* time("preview separate", 3, h.reader.PreviewChatMerge(request(ledger.forkId, "separate")))
      assert.strictEqual(seen.messages, 3_000)
      assert.strictEqual(seen.views?.find((v) => v.entity === kai)?.from, "merged")
      assert.strictEqual(seen.views?.find((v) => v.entity === mira)?.from, "both")
      const made = yield* time(
        "merge separate",
        1,
        h.writer.MergeChat({ ...request(ledger.forkId, "separate"), title: "Pier", framing: null, digest: seen.digest })
      )
      assert.strictEqual(made.position, 3_000)

      const forMira = yield* time("Mira's request after the separate merge", 3, requestBy(ledger.forkId, mira))
      const forKai = yield* time("Kai's request after the separate merge", 3, requestBy(ledger.forkId, kai))
      yield* time("Mira's request after the together merge", 3, requestBy(together, mira))
      const kaiTogether = yield* time("Kai's request after the together merge", 3, requestBy(together, kai))
      const miraText = sentText(forMira)
      const kaiText = sentText(forKai)
      assert.include(miraText, "HOME line 2999.")
      assert.notInclude(miraText, "DOCKS line")
      assert.include(kaiText, "DOCKS line 2999.")
      assert.notInclude(kaiText, "HOME line")
      assert.include(sentText(kaiTogether), "HOME line 2999.")
      const history = (s: ContextSnapshot) =>
        s.request.messages.filter((m) => JSON.stringify(m.content).includes("HOME"))
      // With two characters in the cast, each line carries its speaker's name, so fewer lines fit
      // the window; what Mira reads is still this chat's lines, in order, up to the newest.
      const after = history(forMira).map((m) => ({ ...m, content: String(m.content).replace(/^Mira: /, "") }))
      assert.isAtLeast(after.length, 900)
      assert.deepStrictEqual(after, history(before).slice(-after.length), "Mira reads this chat's own lines")
      // Read together, the merged section takes part of the window; the lines that still fit are the same.
      const read = history(yield* requestBy(together, mira)).filter((m) => !String(m.content).includes("DOCKS"))
      assert.deepStrictEqual(read, history(forMira).slice(-read.length), "the same lines as read together")

      const result = { ...counts![0], fixtureMs: Math.round(fixtureMs), samples }
      console.log("MERGE_ORIGIN_SCALE", JSON.stringify(result))
      if (process.env.MERGE_ORIGIN_SCALE_OUT)
        appendFileSync(process.env.MERGE_ORIGIN_SCALE_OUT, JSON.stringify(result) + "\n")
      for (const sample of samples) assert.isBelow(sample.ms, 5_000, sample.operation)
    }).pipe(Effect.scoped, Effect.provide(server.layer)) as Effect.Effect<void, unknown, never>
  },
  30 * 60_000
)
