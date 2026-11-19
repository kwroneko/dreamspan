// Kept planning facts (db/lcmFactStore.ts, planperf2) across the features combined beside them
// (combine1115): the summary model chosen for the account, for a chat and for one branch
// (smallui1), and a merge of another chat kept separate with its Undo (merge2). Kept facts hold
// no model, setting or audience projection, so each of these must plan from warm readers exactly
// as from facts read afresh. A request never reuses a stale summary over an input its branch
// deleted (msgactions1), with warm readers and across a separate merge. Synthetic data; the mock
// provider is never called.
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { cardDoc } from "./support/docs.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, PAIRS_8K } from "./support/lcmHarness.ts"

const filler = "The road ran on past the synthetic hills. ".repeat(8)

type Harness = Effect.Success<ReturnType<typeof lcmHarness>>

/** The chat's LCM stamp, and a hand-moved one that makes every reader read its facts again. */
const stamps = (h: Harness, chatId: string) => ({
  read: Effect.map(
    fixtureSql(h.dataDir, [{ sql: "SELECT lcm_stamp AS stamp FROM chats WHERE id=?", params: [chatId] }], {
      readOnly: true
    }),
    (rows) => rows[0]![0]!.stamp as number
  ),
  forget: fixtureSql(h.dataDir, [{ sql: "UPDATE chats SET lcm_stamp=lcm_stamp+1 WHERE id=?", params: [chatId] }])
})

/** The text of a reply's request by `speaker` after `parent` in `forkId` (a placeholder on a branch of its own). */
const requestText = (h: Harness, chatId: string, forkId: ForkId, parent: SlotId, speaker: EntityId | null = null) =>
  Effect.gen(function* () {
    const placeholder = yield* h.writer.AppendMessage({
      userId: h.userId,
      chatId: chatId as ChatId,
      forkId,
      parentSlotId: parent,
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
      chatId: chatId as ChatId,
      forkId: placeholder.forkId,
      slotId: placeholder.slotId,
      versionId: placeholder.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null
    })
    return JSON.stringify((JSON.parse(built.snapshot) as { request: { messages: unknown } }).request.messages)
  })

lcmTest(
  "deleting a summarized range's inputs on a warm branch leaves no stale summary text and plans as fresh",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 80, message: (n) => `Message ${n}. ${filler}` })
      const main = h.chat.currentForkId! as ForkId
      const leaf = h.rows.at(-1)!.slotId as SlotId
      const inputs = h.rows.map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      const left = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(0, 4), [], " LEFTMARK")
      const right = yield* completeFixture(
        h.dataDir,
        h.writer,
        h.userId,
        h.chat.id,
        inputs.slice(4, 8),
        [],
        " RIGHTMARK"
      )
      yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], [left, right], " TOPMARK")
      // A branch made before the deletion keeps its summaries.
      const tab = (yield* h.writer.CreateFork({
        userId: h.userId,
        chatId: h.chat.id,
        fromForkId: main,
        atSlotId: leaf
      })).fork.id as ForkId
      const { read: stamp, forget } = stamps(h, h.chat.id)
      const plans = (forkId: ForkId) =>
        Effect.all([
          h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: leaf }),
          h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: leaf, reason: "reply" })
        ])
      const compare = (name: string) =>
        Effect.gen(function* () {
          const kept = yield* Effect.all([plans(main), plans(tab)])
          yield* forget
          assert.deepStrictEqual(kept, yield* Effect.all([plans(main), plans(tab)]), `${name}: kept plans as fresh`)
        })
      const marks = /LEFTMARK|TOPMARK/
      yield* Effect.all([plans(main), plans(tab)])
      assert.match(yield* requestText(h, h.chat.id, main, leaf), marks, "the summaries are used before the deletion")
      // Warm readers, then two inputs of the first summary deleted at once on this branch.
      yield* Effect.all([plans(main), plans(tab)])
      const before = yield* stamp
      const items = yield* h.writer.DeleteMessages({
        userId: h.userId,
        forkId: main,
        slotIds: [h.rows[1]!.slotId, h.rows[2]!.slotId]
      })
      assert.isAbove(yield* stamp, before, "deleting summarized inputs moves the stamp")
      yield* compare("after deleting summarized inputs")
      const text = yield* requestText(h, h.chat.id, main, leaf)
      assert.notMatch(text, marks, "no stale summary over a deleted input, through its condensation")
      assert.notInclude(text, "Message 1. ")
      assert.match(yield* requestText(h, h.chat.id, tab, leaf), marks, "the other branch keeps its summaries")
      // Undo: restored, the summaries are fresh and used again.
      yield* Effect.all([plans(main), plans(tab)])
      yield* h.writer.RestoreBinItems({ userId: h.userId, itemIds: items.map((i) => i.id) })
      yield* compare("after restoring them")
      assert.match(yield* requestText(h, h.chat.id, main, leaf), marks)
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 180_000 }
)

lcmTest(
  "the account, chat and branch summary model plan the same from kept facts as from fresh ones",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 80, message: (n) => `Message ${n}. ${filler}` })
      const main = h.chat.currentForkId! as ForkId
      const leaf = h.rows.at(-1)!.slotId as SlotId
      const inputs = h.rows.map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      // Kept facts worth keeping: two level-1 summaries and their parent.
      const left = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(0, 4))
      const right = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(4, 8))
      yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], [left, right])
      const { read: stamp, forget } = stamps(h, h.chat.id)
      const plans = (forkId: ForkId, slot: SlotId) =>
        Effect.all([
          h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: slot }),
          h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: slot, reason: "reply" })
        ])
      /** Warm readers, the change, then the kept plan against a fresh one; the kept plan. */
      const step = <A, E, R>(name: string, write: Effect.Effect<A, E, R>, forkId = main, slot = leaf) =>
        Effect.gen(function* () {
          yield* plans(forkId, slot)
          const before = yield* stamp
          yield* write
          assert.strictEqual(yield* stamp, before, `${name}: a model choice is no summary fact`)
          const kept = yield* plans(forkId, slot)
          yield* forget
          assert.deepStrictEqual(kept, yield* plans(forkId, slot), `${name}: kept facts plan as fresh ones`)
          return kept
        })
      const local = (name: string) =>
        h.api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name,
            baseUrl: "http://127.0.0.1:9/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
      const narrow = yield* local("Narrow")
      const spare = yield* local("Spare")
      const small = yield* h.api.AddUserModel({
        connectionId: narrow.id,
        key: "small-summary",
        overrides: { context: 760, settings: { samplers: { openai_max_tokens: 200 } } }
      })
      const mid = yield* h.api.AddUserModel({
        connectionId: spare.id,
        key: "mid-summary",
        overrides: { context: 1050, settings: { samplers: { openai_max_tokens: 200 } } }
      })
      const chunkSizes = (plan: Effect.Success<ReturnType<typeof plans>>) =>
        plan[1].chunks.map((c) => c.inputs.length).join(",") + (plan[0].blocked ? " blocked" : "")

      const initial = yield* step("no summary model of its own", Effect.void)
      assert.isNull(initial[0].blocked)
      assert.isAbove(initial[1].chunks.length, 0, "the long tail asks for summaries")

      const account = yield* step(
        "the account's summary model",
        h.api.ChangeGenerationDefaults({ change: { summarizer: { connection: narrow.id, model: small.id } } })
      )
      assert.notDeepEqual(chunkSizes(account), chunkSizes(initial), "the small model's window caps the chunks")

      const revised = yield* step(
        "the account's model given a larger window",
        h.api.EditModel({
          modelId: small.id,
          overrides: { context: 900, settings: { samplers: { openai_max_tokens: 200 } } },
          expectedRowVersion: small.rowVersion
        })
      )
      assert.notDeepEqual(chunkSizes(revised), chunkSizes(account), "the model's revision is read on every plan")

      const chat = yield* step(
        "the chat's own summary model",
        h.api.ChangeCast({
          chatId: h.chat.id as ChatId,
          slotId: null,
          change: { _tag: "SummaryModel", model: { connection: spare.id, model: mid.id } }
        })
      )
      assert.notDeepEqual(chunkSizes(chat), chunkSizes(revised), "the chat's choice comes before the account's")

      const unbound = yield* step(
        "the chat's summary model taken off",
        h.api.ChangeCast({ chatId: h.chat.id as ChatId, slotId: null, change: { _tag: "SummaryModel", model: null } })
      )
      assert.deepStrictEqual(chunkSizes(unbound), chunkSizes(revised), "back to the account's")

      // One branch's own choice: that branch plans with it, the other keeps its plan.
      const at = h.rows[70]!.slotId as SlotId
      const tab = (yield* h.writer.CreateFork({ userId: h.userId, chatId: h.chat.id, fromForkId: main, atSlotId: at }))
        .fork.id as ForkId
      const tabBefore = yield* step("a new branch", Effect.void, tab, at)
      const mainBefore = yield* plans(main, leaf)
      const tabBound = yield* step(
        "the branch's own summary model",
        h.api.ChangeCast({
          chatId: h.chat.id as ChatId,
          forkId: tab,
          slotId: at,
          change: { _tag: "SummaryModel", model: { connection: spare.id, model: mid.id } }
        }),
        tab,
        at
      )
      assert.notDeepEqual(chunkSizes(tabBound), chunkSizes(tabBefore))
      assert.deepStrictEqual(yield* plans(main, leaf), mainBefore, "another branch's choice leaves this plan")

      // The branch's chosen model's connection deleted: it falls through to the account's.
      const fellThrough = yield* step(
        "the branch's model deleted with its connection",
        h.api.DeleteConnection({ connectionId: spare.id }),
        tab,
        at
      )
      assert.deepStrictEqual(chunkSizes(fellThrough), chunkSizes(tabBefore))

      const cleared = yield* step(
        "the account's summary model taken off",
        h.api.ChangeGenerationDefaults({ change: { summarizer: null } })
      )
      assert.deepStrictEqual(cleared, initial, "no summary model of its own again")
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 180_000 }
)

lcmTest(
  "a separate merge, its Undo and a branch made before it plan the same from kept facts as from fresh ones",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 24, message: (n) => `HOME ${n}. ${filler}` })
      const { api, writer, reader, userId } = h
      const ledger = h.chat.id as ChatId
      const main = h.chat.currentForkId! as ForkId
      const card = (name: string) =>
        Effect.map(
          writer.CreateEntity({
            userId,
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
      yield* writer.AddStateEvent({
        userId,
        chatId: ledger,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: mira } }
      })
      const tipOf = (chatId: string, fork: ForkId) =>
        Effect.map(
          reader.ReadPath({
            userId,
            chatId: chatId as ChatId,
            forkId: fork,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          }),
          (path) => (path.entries.at(-1)?.slotId ?? null) as SlotId | null
        )
      const say = (chatId: string, fork: ForkId, speaker: EntityId, content: string) =>
        Effect.flatMap(tipOf(chatId, fork), (parent) =>
          writer.AppendMessage({
            userId,
            chatId: chatId as ChatId,
            forkId: fork,
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
        )
      for (let n = 0; n < 16; n++) yield* say(ledger, main, mira, `HOME Mira ${n}. ${filler}`)
      const inputs = h.rows.map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      const left = yield* completeFixture(h.dataDir, writer, userId, ledger, inputs.slice(0, 6), [], " HOMELEFTMARK")
      const right = yield* completeFixture(h.dataDir, writer, userId, ledger, inputs.slice(6, 12))
      yield* completeFixture(h.dataDir, writer, userId, ledger, [], [left, right], " HOMETOPMARK")
      // A branch made before the merge, which never shows it.
      const childAt = h.rows[18]!.slotId as SlotId
      const child = (yield* writer.CreateFork({ userId, chatId: ledger, fromForkId: main, atSlotId: childAt })).fork
        .id as ForkId

      // The Pier: Kai's chat with summaries of its own.
      const pier = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Pier",
        participants: [kai],
        greeting: null
      })
      const P = pier.currentForkId! as ForkId
      yield* writer.AddStateEvent({
        userId,
        chatId: pier.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "lcm.settings", value: { enabled: true, leafInput: 500, leafTarget: 100, ...PAIRS_8K } }
      })
      const docks: Array<Effect.Success<ReturnType<typeof say>>> = []
      for (let n = 0; n < 20; n++) docks.push(yield* say(pier.id, P, kai, `DOCKS ${n}. ${filler}`))
      yield* completeFixture(
        h.dataDir,
        writer,
        userId,
        pier.id,
        docks.slice(0, 6).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      )

      const { read: stamp, forget } = stamps(h, ledger)
      /** Every plan of a branch's tip: shared, then each view of its own, by both reasons. */
      const plansOf = (fork: ForkId) =>
        Effect.gen(function* () {
          const leafSlotId = (yield* tipOf(ledger, fork))!
          const at = { userId, chatId: ledger, forkId: fork, leafSlotId }
          const shared = yield* Effect.all([
            reader.PlanSummaries(at),
            reader.PlanSummaries({ ...at, reason: "reply" as const })
          ])
          const views: Array<unknown> = []
          for (const audience of shared[0].views ?? [])
            views.push(
              yield* Effect.all([
                reader.PlanSummaries({ ...at, audience }),
                reader.PlanSummaries({ ...at, audience, reason: "reply" as const })
              ])
            )
          return { shared, views }
        })
      const both = Effect.all([plansOf(main), plansOf(child)])
      /** Kept plans of both branches against fresh ones; the kept plans. */
      const compare = (name: string) =>
        Effect.gen(function* () {
          const kept = yield* both
          yield* forget
          assert.deepStrictEqual(kept, yield* both, `${name}: kept facts plan as fresh ones`)
          return kept
        })

      yield* both
      const [beforeMain, beforeChild] = yield* compare("before the merge")
      assert.lengthOf(beforeMain.views, 0, "no view of its own before a separate join")

      // The merge, kept separate, on warm readers.
      yield* both
      const moved = yield* stamp
      const request = {
        chatId: ledger,
        forkId: main,
        at: null,
        source: { chatId: pier.id, forkId: P },
        includeLeftOut: false,
        timelines: "separate" as const
      }
      const seen = yield* api.PreviewChatMerge(request)
      const merged = yield* api.MergeChat({ ...request, title: seen.sourceTitle, framing: null, digest: seen.digest })
      assert.isAbove(yield* stamp, moved, "the merge moves the destination's stamp")
      const [afterMain, afterChild] = yield* compare("after the merge")
      assert.isAbove(afterMain.views.length, 0, "the separate join gives the characters views of their own")
      assert.deepStrictEqual(afterChild, beforeChild, "the branch made before the merge plans as before")

      // Both chats' characters write on after it; appending keeps the facts.
      yield* both
      const appended = yield* stamp
      for (let n = 0; n < 6; n++) yield* say(ledger, main, n % 2 ? kai : mira, `After ${n}. ${filler}`)
      assert.strictEqual(yield* stamp, appended)
      yield* compare("after messages following the merge")

      // A summarized destination input deleted after the join: no character's request keeps the
      // stale summary (or its condensation), and kept facts plan as fresh ones.
      const home = /HOMELEFTMARK|HOMETOPMARK/
      const tip = (yield* tipOf(ledger, main))!
      assert.match(yield* requestText(h, ledger, main, tip, mira), home, "Mira reads the Ledger's summaries")
      assert.notMatch(yield* requestText(h, ledger, main, tip, kai), home, "Kai never reads them")
      yield* both
      const deleting = yield* stamp
      const binned = yield* writer.DeleteMessages({ userId, forkId: main, slotIds: [h.rows[3]!.slotId] })
      assert.isAbove(yield* stamp, deleting, "deleting a summarized input moves the stamp")
      yield* compare("after deleting a summarized input across the merge")
      for (const speaker of [mira, kai])
        assert.notMatch(
          yield* requestText(h, ledger, main, tip, speaker),
          home,
          "no stale summary over the deleted input"
        )
      yield* both
      yield* writer.RestoreBinItems({ userId, itemIds: binned.map((i) => i.id) })
      yield* compare("after restoring it")
      assert.match(yield* requestText(h, ledger, main, tip, mira), home)

      // Undo: the join deleted on the branch that made it.
      yield* both
      const undoing = yield* stamp
      yield* writer.DeleteMessage({ userId, slotId: merged.entry.slotId, forkId: main })
      // The join is no summary's input, so its deletion keeps the facts: what changes is read live.
      assert.strictEqual(yield* stamp, undoing, "the Undo keeps the summary facts")
      const [undoneMain, undoneChild] = yield* compare("after the merge's Undo")
      assert.lengthOf(undoneMain.views, 0, "no view of its own once the join is gone")
      assert.deepStrictEqual(undoneChild, beforeChild, "the branch made before the merge plans as before")
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 240_000 }
)
