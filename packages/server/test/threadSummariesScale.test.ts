// Summaries at a separate join at the owner's shape (spec/THREADS.md TH7): a chat with one shared
// context and 300 branches whose threads part at its first message, the Lantern and the docks
// each 3,000 messages long with 20–50 versions on every docks message, the docks joined into the
// Lantern separately. Measures the join (it records its stretch), the summary plan after a reply
// (its stretch views: who missed what in the stretch), the summary UI for Wren and her next
// request through the real workers. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1
//   npx vitest run --project server-slow packages/server/test/threadSummariesScale.test.ts
import { Worker } from "node:worker_threads"
import { databaseFile } from "../src/db/connection.ts"
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect, Stream } from "effect"
import { ExecutionRegistry } from "../src/execution.ts"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"
import { eventually } from "./support/generation.ts"
import { sse } from "./support/mockProvider.ts"

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
            SELECT '${prefix}-v'||printf('%0${34 - prefix.length}d',x), '${prefix}-s'||x, 0, 'complete', CASE WHEN x % 2 = 0 THEN NULL ELSE ? END,
              CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END, '${text}, line '||x||'.', 'verbatim',
              CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, ?, ?, x, x, '${fork}' FROM n`,
          params: [speaker, cast, JSON.stringify({ away: [away] })]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2999)
            INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,chain_id)
            SELECT '${prefix}-s'||x, ?, CASE WHEN x = 1 THEN ? ELSE '${prefix}-s'||(x-1) END,
              (SELECT depth FROM slots WHERE id = ?) + x, '${prefix}-v'||printf('%0${34 - prefix.length}d',x), x, ?, (SELECT chain_id FROM slots WHERE id = ?) FROM n`,
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
            SELECT 'docks-v'||printf('%029d',x)||'-'||j, 'docks-s'||x, j, 'complete', ?, 'model', 'Another telling of line '||x||', take '||j||'.',
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
      const sharedPlan = yield* time(
        "PlanSummaries shared read",
        h.reader.PlanSummaries({ userId: h.userId, chatId, leafSlotId, reason: "reply" }),
        1
      )
      const planned = [
        {
          audience: null as string | null,
          chunks: sharedPlan.chunks.length,
          refresh: sharedPlan.refresh.length,
          condensations: sharedPlan.condensations.length
        }
      ]
      for (const audience of sharedPlan.views ?? []) {
        const view = yield* time(
          "PlanSummaries private read",
          h.reader.PlanSummaries({ userId: h.userId, chatId, leafSlotId, reason: "reply", audience }),
          1
        )
        planned.push({
          audience,
          chunks: view.chunks.length,
          refresh: view.refresh.length,
          condensations: view.condensations.length
        })
      }
      process.stdout.write(`THREAD_SUMMARIES_PASSES ${JSON.stringify(planned)}\n`)
      assert.lengthOf(sharedPlan.views ?? [], 2, "only the two characters who missed a line need extra passes")
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
      const spent = new Map<string, number>()
      const profiled = new Proxy(h.reader, {
        get: (target, key) => {
          const op = (target as unknown as Record<string, unknown>)[key as string]
          if (typeof op !== "function") return op
          return (input: unknown) => {
            const started = performance.now()
            return (op as (i: unknown) => Effect.Effect<unknown>)(input).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  spent.set(key as string, (spent.get(key as string) ?? 0) + performance.now() - started)
                  spent.set(`${key as string}#`, (spent.get(`${key as string}#`) ?? 0) + 1)
                })
              )
            )
          }
        }
      })
      const context = (): ToolContext => ({
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
        reader: profiled,
        writer: h.writer
      })
      const prepareHook = historyTools.find((tool) => tool.id === "read_messages")!.snapshot!
      for (const [operation, forkId, leaf, viewer] of [
        ["prepare, no join on path", docks, "docks-s2999", wren],
        ["prepare, unknown join on path", main, leafSlotId, mira]
      ] as const) {
        const paths = spent.get("ReadPath#") ?? 0
        yield* time(
          operation,
          Effect.suspend(() =>
            prepareHook.prepare(
              {
                ...context(),
                forkId,
                leafSlotId: leaf as SlotId,
                viewers: [viewer]
              },
              undefined
            )
          )
        )
        assert.strictEqual(spent.get("ReadPath#") ?? 0, paths, "unaffected preflight reads no message windows")
      }
      const searchTool = historyTools.find((tool) => tool.id === "search_chat")!
      const readTool = historyTools.find((tool) => tool.id === "read_messages")!
      const search = (query: string) => Effect.suspend(() => searchTool.execute(context(), { query } as never))
      const found = yield* time("search_chat for Wren", search("docks night 2999"))
      assert.include(found.text, "The docks at night, line 2999.")
      assert.notMatch(found.text, /At the docks #|Message [0-9]/)
      assert.strictEqual((yield* search("Lantern night 2999")).text, "No earlier messages match.")

      const address = /Message (v[a-f0-9]{24})/.exec(found.text)![1]!
      const read = yield* time(
        "read_messages for Wren, cold",
        Effect.suspend(() => readTool.execute(context(), { from: address, count: 20 } as never))
      )
      assert.include(read.text, "The docks at night, line 2999.")
      assert.notInclude(read.text, "The Lantern at night")
      const warm = context()
      // What a reply's generation prepares (one path read), and what its snapshot keeps of it.
      const state = yield* time(
        "prepare private history snapshot, cold",
        Effect.suspend(() => searchTool.snapshot!.prepare(context(), undefined)),
        1
      )
      const view = (state as { prepared: ReadonlyMap<string, unknown> }).prepared.get("history.private") as {
        messages: ReadonlyArray<{ content: string }>
      }
      const frozen = JSON.stringify(searchTool.snapshot!.freeze!(state))
      assert.notInclude(frozen, "The docks at night")
      process.stdout.write(
        `THREAD_TOOLS_SNAPSHOT ${JSON.stringify({ frozenBytes: Buffer.byteLength(frozen), projectedTextBytes: Buffer.byteLength(JSON.stringify(view)), messages: view.messages.length, textBytes: view.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) })}\n`
      )
      assert.strictEqual(Buffer.byteLength(frozen), 77)
      // Reconstruct the preceding implementation from the same in-memory view. Both forms go
      // through the real StartRollout handler in the helper worker, alternating five times.
      const rows = view.messages as ReadonlyArray<{ key: string; n: number; content: string }>
      const oldFrozen = {
        seed: (view as { seed?: string }).seed,
        keys: rows.map((r) => r.key),
        numbers: rows.flatMap((r, i) => (r.n === (rows[i - 1]?.n ?? 0) + 1 ? [] : [[i, r.n]]))
      }
      const withState = (kept: unknown) => JSON.stringify({ ...snapshot, agentToolState: { "history.private": kept } })
      const holds = yield* Effect.promise(
        () =>
          new Promise<Array<{ label: string; bytes: number; ms: number }>>((resolve, reject) => {
            const worker = new Worker(new URL("./support/historySnapshotWorker.ts", import.meta.url), {
              workerData: {
                dbPath: databaseFile(config.dataDir),
                input: {
                  userId: h.userId,
                  chatId,
                  forkId: placeholder.forkId,
                  slotId: placeholder.slotId,
                  versionId: placeholder.version.id,
                  leafSlotId,
                  rolloutId: "unused",
                  snapshot: "unused",
                  connectionId: snapshot.inputs.model!.connectionId,
                  modelId: snapshot.inputs.model!.modelId,
                  issues: [],
                  variables: [],
                  frozenMessages: []
                },
                snapshots: [
                  { label: "before", snapshot: withState(oldFrozen) },
                  { label: "after", snapshot: withState(JSON.parse(frozen)) }
                ]
              }
            })
            let result: Array<{ label: string; bytes: number; ms: number }> | undefined
            worker.once("message", (message: { samples: typeof result }) => {
              result = message.samples
            })
            worker.once("error", reject)
            worker.once("exit", (code) =>
              code === 0 && result !== undefined ? resolve(result) : reject(new Error(`history worker exited ${code}`))
            )
          })
      )
      process.stdout.write(
        `THREAD_HISTORY_WRITER ${JSON.stringify({
          messages: rows.length,
          idBytes: rows.map((r) => r.key.length).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
          beforeFrozenBytes: Buffer.byteLength(JSON.stringify(oldFrozen)),
          afterFrozenBytes: Buffer.byteLength(frozen),
          samples: holds,
          medians: ["before", "after"].map((label) => ({
            label,
            ms: median(holds.filter((r) => r.label === label).map((r) => r.ms))
          }))
        })}\n`
      )
      assert.isBelow(median(holds.filter((r) => r.label === "after").map((r) => r.ms)), 100)
      // The run reads what was prepared; a Resume, step edit or replay thaws the frozen form.
      yield* searchTool.snapshot!.prepare(warm, state)
      yield* time("read_messages for Wren, cached", readTool.execute(warm, { from: address, count: 20 } as never))
      yield* time("search_chat for Wren, cached", searchTool.execute(warm, { query: "docks night 2999" } as never))
      const thawed = yield* time(
        "read_messages for Wren, thawed on Resume",
        Effect.suspend(() => {
          const resumed = context()
          return searchTool
            .snapshot!.prepare(resumed, JSON.parse(frozen))
            .pipe(Effect.andThen(readTool.execute(resumed, { from: address, count: 20 } as never)))
        })
      )
      assert.strictEqual(thawed.text, read.text)

      // Actual Generate -> first received text delta, with an immediate loopback provider.
      // Paired control forces the preceding eager path preparation; all other work is the
      // same. This measures the preflight's contribution without a real provider's latency.
      const registry = yield* ExecutionRegistry
      const firstTokens = new Map<string, number>()
      const completed = new Set<string>()
      let subscribed = false
      yield* h.api.SubscribeChat({ chatId }).pipe(
        Stream.runForEach((batch) =>
          Effect.sync(() => {
            subscribed = true
            for (const e of batch) {
              if (e._tag === "Delta" && e.text.length && !firstTokens.has(e.versionId))
                firstTokens.set(e.versionId, performance.now())
              if (e._tag === "Version" && e.version.status !== "generating") completed.add(e.version.id)
            }
          })
        ),
        Effect.forkScoped
      )
      yield* eventually(() => subscribed)
      // The reply comes as a story's default contract sends it: one send_message call, whose
      // executed message is the body's first text (a plain answer there is never the reply).
      h.mock.setHandler((_request, res) =>
        sse(res, [
          {
            id: "send",
            object: "chat.completion.chunk",
            model: "served-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_send",
                      type: "function",
                      function: { name: "send_message", arguments: JSON.stringify({ message: "Morning light." }) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: "send",
            object: "chat.completion.chunk",
            model: "served-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
          },
          {
            id: "send",
            object: "chat.completion.chunk",
            model: "served-model",
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }
        ])
      )
      const tokenSamples: Array<{ shape: string; preflight: string; ms: number }> = []
      for (const [shape, source, leaf, speaker] of [
        ["no join on path", docks, "docks-s2999", wren],
        ["unknown join", main, leafSlotId, mira],
        ["known join", main, leafSlotId, wren]
      ] as const) {
        for (let n = 0; n < 3; n++)
          for (const preflight of ["eager control", "probe"] as const)
            yield* Effect.gen(function* () {
              if (preflight === "eager control")
                yield* registry.rolloutTools.register({
                  ...readTool,
                  snapshot: {
                    ...prepareHook,
                    prepare: (ctx, frozen) =>
                      prepareHook.prepare(
                        {
                          ...ctx,
                          reader: {
                            ...ctx.reader,
                            HistoryProjectionNeeded: (() =>
                              Effect.succeed(true)) as ToolContext["reader"]["HistoryProjectionNeeded"]
                          }
                        },
                        frozen
                      )
                  }
                })
              const forkId = (yield* h.writer.CreateFork({
                userId: h.userId,
                chatId,
                fromForkId: source,
                atSlotId: leaf as SlotId
              })).fork.id as ForkId
              for (const data of [
                { key: "agent.enabled", value: { on: true } },
                { key: "agent.tools", value: { tools: ["read_messages"] } },
                { key: "context.per_speaker", value: "separate" },
                { key: "lcm.settings", value: { enabled: false } }
              ] as const)
                yield* h.writer.AddStateEvent({
                  userId: h.userId,
                  chatId,
                  forkId,
                  slotId: data.key === "lcm.settings" ? null : (leaf as SlotId),
                  versionId: null,
                  scope: null,
                  data
                })
              const start = performance.now()
              const generated = yield* h.api.Generate({
                chatId,
                forkId,
                parentSlotId: leaf as SlotId,
                branch: false,
                speakerEntityId: speaker
              })
              assert.strictEqual(generated._tag, "Posted")
              if (generated._tag !== "Posted") return
              const id = generated.entry.version.id
              yield* eventually(() => completed.has(id), 30_000)
              assert.isTrue(firstTokens.has(id), "the subscription received a first text delta")
              tokenSamples.push({ shape, preflight, ms: firstTokens.get(id)! - start })
            }).pipe(Effect.scoped)
      }
      process.stdout.write(
        `THREAD_FIRST_TOKEN ${JSON.stringify({
          samples: tokenSamples,
          medians: [...new Set(tokenSamples.map((s) => s.shape))].flatMap((shape) =>
            ["eager control", "probe"].map((preflight) => ({
              shape,
              preflight,
              ms: median(tokenSamples.filter((s) => s.shape === shape && s.preflight === preflight).map((s) => s.ms))
            }))
          )
        })}\n`
      )

      // The first text of a reply under the send tool, well inside the wait above (about 1 s
      // with a known join, 0.25 s without, on a quiet host).
      for (const shape of new Set(tokenSamples.map((s) => s.shape)))
        assert.isBelow(
          median(tokenSamples.filter((s) => s.shape === shape && s.preflight === "probe").map((s) => s.ms)),
          3_000,
          `first text delta, ${shape}`
        )
      process.stdout.write(`THREAD_TOOLS_PROFILE ${JSON.stringify(Object.fromEntries(spent))}\n`)
      process.stdout.write(`THREAD_SUMMARIES_SCALE ${JSON.stringify(samples)}\n`)
      const ms = (operation: string) => samples.find((s) => s.operation === operation)!.ms
      assert.isBelow(ms("JoinThreads, separately"), 1_500)
      assert.isBelow(ms("PlanSummaries after a reply"), 6_000)
      assert.isBelow(ms("GetLcmState for Wren"), 500)
      assert.isBelow(ms("AssembleContext for Wren"), 3_000)
      assert.isBelow(ms("search_chat for Wren"), 3_000)
      assert.isBelow(ms("prepare, no join on path"), 100)
      assert.isBelow(ms("prepare, unknown join on path"), 100)
      assert.isBelow(ms("read_messages for Wren, cold"), 3_000)
      assert.isBelow(ms("read_messages for Wren, cached"), 100)
      assert.isBelow(ms("read_messages for Wren, thawed on Resume"), 3_000)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
