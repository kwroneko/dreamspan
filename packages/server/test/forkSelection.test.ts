// Per-fork selection (spec/FORK-INDEPENDENCE-DELTA.md §2.2, §2.3, implementation unit 3):
// a fork's choice of swipe is a row of its own in `fork_overrides`, read through its lineage.
// A selection in one fork never shows in another; a fork made later inherits it, from any
// point; one made earlier doesn't. The scale of window reads is in pathScale.test.ts, the
// migration in forkOverridesMigration.test.ts.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

const config = testConfig()

const said = (content: string, writer: "human" | "model" = "model") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

/** A chat of `m0` (the user's) and `m1` (a reply, with an unselected swipe "two"), and helpers. */
const setup = Effect.gen(function* () {
  const api = yield* client()
  const user = yield* api.Whoami()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = user.id as UserId
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Forks",
    participants: [],
    greeting: null
  })
  const main = chat.currentForkId! as ForkId
  const append = (parent: SlotId | null, content: string, forkId: ForkId = main, branch = false) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId: parent,
      branch,
      version: said(content, parent === null ? "human" : "model"),
      commitDraft: null
    })
  const m0 = yield* append(null, "m0")
  const m1 = yield* append(m0.slotId, "one")
  const two = yield* writer.AddVersion({
    userId,
    slotId: m1.slotId,
    version: said("two"),
    select: false,
    commitDraft: null
  })
  /** The path's texts as `forkId` shows it. */
  const texts = (forkId: ForkId) =>
    Effect.map(reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 100 }), (path) =>
      path.entries.map((e) => e.version.content)
    )
  /** What `forkId` shows at a slot, and the slot's row version there. */
  const shown = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.GetSlot({ userId, slotId, forkId }), ({ entry }) => ({
      content: entry.version.content,
      versionId: entry.version.id,
      rowVersion: entry.rowVersion,
      shownForkId: entry.shownForkId
    }))
  const select = (slotId: SlotId, forkId: ForkId, versionId: VersionId) =>
    Effect.gen(function* () {
      const before = yield* shown(slotId, forkId)
      return yield* writer.SelectVersion({ userId, slotId, versionId, forkId, expectedVersionId: before.versionId })
    })
  const fork = (from: ForkId, at: SlotId | null) =>
    Effect.map(writer.CreateFork({ userId, chatId: chat.id, fromForkId: from, atSlotId: at }), (made) => made.fork.id)
  const rows = (sql: string, ...params: Array<string | number | null>) =>
    Effect.map(fixtureSql(config.dataDir, [{ sql, params }], { readOnly: true }), ([result]) => result!)
  return {
    api,
    userId,
    writer,
    reader,
    chatId: chat.id as ChatId,
    main,
    append,
    m0,
    m1,
    one: m1.version.id as VersionId,
    two: two.id as VersionId,
    texts,
    shown,
    select,
    fork,
    rows
  }
})

describe("per-fork selection", () => {
  it.live("a selection in one fork leaves another fork at the same message as it was", () =>
    Effect.gen(function* () {
      const { m1, main, one, two, texts, shown, select, fork, writer, userId } = yield* setup
      const g = yield* fork(main, m1.slotId)
      const gBefore = yield* shown(m1.slotId, g)
      yield* select(m1.slotId, main, two)
      assert.deepStrictEqual(yield* texts(main), ["m0", "two"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "one"])
      // G's row version didn't move, so nothing G's tab does is refused for F's choice.
      assert.deepStrictEqual(yield* shown(m1.slotId, g), gBefore)
      const f = yield* shown(m1.slotId, main)
      assert.isAbove(f.rowVersion, gBefore.rowVersion)
      assert.strictEqual(f.shownForkId, main)
      // A tab of G that saw "two" is stale; one that saw "one" selects in G only.
      assert.strictEqual(
        yield* outcome(
          writer.SelectVersion({ userId, slotId: m1.slotId, versionId: one, forkId: g, expectedVersionId: two })
        ),
        "StaleWrite"
      )
      yield* select(m1.slotId, g, two)
      yield* select(m1.slotId, main, one)
      assert.deepStrictEqual(yield* texts(main), ["m0", "one"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "two"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a fork made after a selection inherits it, one made before doesn't, and neither reaches back", () =>
    Effect.gen(function* () {
      const { m1, main, one, two, texts, select, fork } = yield* setup
      const before = yield* fork(main, m1.slotId)
      yield* select(m1.slotId, main, two)
      const after = yield* fork(main, m1.slotId)
      assert.deepStrictEqual(yield* texts(before), ["m0", "one"])
      assert.deepStrictEqual(yield* texts(after), ["m0", "two"])
      // Choices after the fork was made stay apart, both ways.
      yield* select(m1.slotId, main, one)
      assert.deepStrictEqual(yield* texts(after), ["m0", "two"])
      yield* select(m1.slotId, after, one)
      yield* select(m1.slotId, main, two)
      assert.deepStrictEqual(yield* texts(after), ["m0", "one"])
      assert.deepStrictEqual(yield* texts(before), ["m0", "one"])
      // A grandchild reads its grandparent only up to when its parent was made.
      const grandchild = yield* fork(after, m1.slotId)
      assert.deepStrictEqual(yield* texts(grandchild), ["m0", "one"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a fork from an earlier point inherits the selections above its point", () =>
    Effect.gen(function* () {
      const { writer, userId, m0, m1, main, append, texts, select, fork } = yield* setup
      const alt = yield* writer.AddVersion({
        userId,
        slotId: m0.slotId,
        version: said("m0 again", "human"),
        select: false,
        commitDraft: null
      })
      const m2 = yield* append(m1.slotId, "m2")
      yield* select(m0.slotId, main, alt.id as VersionId)
      const early = yield* fork(main, m1.slotId)
      assert.deepStrictEqual(yield* texts(early), ["m0 again", "one"])
      // And at the root, from before the first message, nothing is above it to inherit.
      const root = yield* fork(main, null)
      assert.deepStrictEqual(yield* texts(root), [])
      yield* append(null, "fresh start", root)
      assert.deepStrictEqual(yield* texts(main), ["m0 again", "one", "m2"])
      assert.strictEqual(m2.forkId, main)
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a fork's own selection is updated in place only while no fork was made from it since", () =>
    Effect.gen(function* () {
      const { m1, main, one, two, texts, select, fork, rows } = yield* setup
      const count = (forkId: ForkId) =>
        Effect.map(
          rows(
            "SELECT count(*) AS n FROM fork_overrides WHERE fork_id = ? AND kind = 'select' AND target_id = ?",
            forkId,
            m1.slotId
          ),
          ([row]) => row!.n as number
        )
      yield* select(m1.slotId, main, two)
      yield* select(m1.slotId, main, one)
      yield* select(m1.slotId, main, two)
      // Swiping back and forth at a tip nobody forked from leaves one row.
      assert.strictEqual(yield* count(main), 1)
      const child = yield* fork(main, m1.slotId)
      yield* select(m1.slotId, main, one)
      // The child reads the row it saw, so the parent's next choice is a row of its own…
      assert.strictEqual(yield* count(main), 2)
      assert.deepStrictEqual(yield* texts(child), ["m0", "two"])
      // …which, with no fork made since it, is updated in place again.
      yield* select(m1.slotId, main, two)
      yield* select(m1.slotId, main, one)
      assert.strictEqual(yield* count(main), 2)
      assert.deepStrictEqual(yield* texts(child), ["m0", "two"])
      assert.deepStrictEqual(yield* texts(main), ["m0", "one"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a chain of 70 forks inherits its ancestors' choices, and making it copies nothing", () =>
    Effect.gen(function* () {
      const { m0, m1, main, one, two, texts, select, fork, rows, writer, userId } = yield* setup
      const alt = yield* writer.AddVersion({
        userId,
        slotId: m0.slotId,
        version: said("m0 again", "human"),
        select: false,
        commitDraft: null
      })
      yield* select(m1.slotId, main, two)
      const chain: Array<ForkId> = [main]
      for (let i = 0; i < 70; i++) {
        const next = yield* fork(chain.at(-1)!, m1.slotId)
        if (i === 10) yield* select(m0.slotId, next, alt.id as VersionId)
        chain.push(next)
      }
      // Only the fork that chose has a row of its own; the others read theirs through the chain.
      const own = yield* rows(
        `SELECT fork_id, count(*) AS n FROM fork_overrides WHERE fork_id IN (${chain.map(() => "?").join(",")})
          GROUP BY fork_id`,
        ...chain
      )
      assert.sameDeepMembers(own, [
        { fork_id: main, n: 1 },
        { fork_id: chain[11], n: 1 }
      ])
      // Each fork's point lies in every ancestor's range (db/forkLabels.ts).
      const labels = yield* rows(
        `SELECT hex(point) AS point, hex(label_end) AS end FROM fork_labels WHERE fork_id IN (${chain.map(() => "?").join(",")})`,
        ...chain
      )
      assert.lengthOf(labels, chain.length)
      for (const forkId of chain.slice(11)) assert.deepStrictEqual(yield* texts(forkId), ["m0 again", "two"])
      for (const forkId of chain.slice(1, 11)) assert.deepStrictEqual(yield* texts(forkId), ["m0", "two"])
      // Nothing done at the top of the chain reaches down it.
      yield* select(m1.slotId, main, one)
      assert.deepStrictEqual(yield* texts(chain.at(-1)!), ["m0 again", "two"])
      assert.deepStrictEqual(yield* texts(main), ["m0", "one"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a slot's own selection is frozen: the database refuses any change to it", () =>
    Effect.gen(function* () {
      const { m1, two } = yield* setup
      const db = new DatabaseSync(databaseFile(config.dataDir))
      try {
        assert.throws(
          () => db.prepare("UPDATE slots SET selected_version_id = ? WHERE id = ?").run(two, m1.slotId),
          "a slot keeps the selection it was inserted with"
        )
        // A selection names a version of its slot.
        const { id: other } = db.prepare("SELECT id FROM versions WHERE slot_id <> ? LIMIT 1").get(m1.slotId) as {
          id: string
        }
        assert.throws(
          () =>
            db
              .prepare(
                `INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
                SELECT 'x', s.chat_id, c.current_fork_id, 1, 'select', s.id, s.id, s.depth, ?
                FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ?`
              )
              .run(other, m1.slotId),
          "a selection names a version of its slot"
        )
      } finally {
        db.close()
      }
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("deleting a swipe moves the fork that deleted it, and no other (unit 5)", () =>
    Effect.gen(function* () {
      const { writer, userId, m1, main, one, two, texts, select, fork } = yield* setup
      const three = yield* writer.AddVersion({
        userId,
        slotId: m1.slotId,
        version: said("three"),
        select: false,
        commitDraft: null
      })
      const g = yield* fork(main, m1.slotId)
      const h = yield* fork(main, m1.slotId)
      yield* select(m1.slotId, main, three.id as VersionId)
      yield* select(m1.slotId, g, three.id as VersionId)
      yield* select(m1.slotId, h, two)
      yield* writer.DeleteVersion({ userId, versionId: three.id, forkId: main })
      // The previous swipe, as ST does, in the fork that deleted it; the others keep theirs.
      assert.deepStrictEqual(yield* texts(main), ["m0", "two"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "three"])
      assert.deepStrictEqual(yield* texts(h), ["m0", "two"])
      yield* writer.DeleteVersion({ userId, versionId: two, forkId: main })
      assert.deepStrictEqual(yield* texts(main), ["m0", "one"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "three"])
      assert.deepStrictEqual(yield* texts(h), ["m0", "two"])
      assert.strictEqual(one, m1.version.id)
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("an event attached to a version applies in the forks that show it", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chatId, m1, main, two, select, fork } = yield* setup
      const g = yield* fork(main, m1.slotId)
      yield* writer.AddStateEvent({
        userId,
        chatId,
        forkId: main,
        slotId: m1.slotId,
        versionId: two,
        scope: null,
        data: { key: "var.set", value: { name: "mood", value: "bright" } }
      })
      const vars = (forkId: ForkId) =>
        Effect.map(
          reader.StateEventsAt({ userId, chatId, slotId: m1.slotId, forkId }),
          (events) => events.filter((e) => e.data.key === "var.set").length
        )
      assert.deepStrictEqual([yield* vars(main), yield* vars(g)], [0, 0])
      yield* select(m1.slotId, main, two)
      assert.deepStrictEqual([yield* vars(main), yield* vars(g)], [1, 0])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a swipe or an edit selects in its fork and makes it current; the API publishes what that fork shows", () =>
    Effect.gen(function* () {
      const { api, chatId, m1, main, fork, texts } = yield* setup
      const g = yield* fork(main, m1.slotId)
      // G is current (made by forking); a written version in main makes main current.
      const slot = (yield* api.ReadPath({
        chatId,
        forkId: main,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 9
      })).entries.at(-1)!
      const written = yield* api.WriteVersion({
        slotId: m1.slotId,
        forkId: main,
        content: "mine",
        expectedRowVersion: slot.rowVersion
      })
      assert.strictEqual(written.shownForkId, main)
      assert.strictEqual((yield* api.GetChat({ chatId })).currentForkId, main)
      assert.deepStrictEqual(yield* texts(main), ["m0", "mine"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "one"])
      // The row version a tab of main holds is main's: a write against G's is stale there.
      const inG = (yield* api.ReadPath({
        chatId,
        forkId: g,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 9
      })).entries.at(-1)!
      assert.strictEqual(
        yield* outcome(
          api.WriteVersion({
            slotId: m1.slotId,
            forkId: main,
            content: "late",
            expectedRowVersion: inG.rowVersion
          })
        ),
        "StaleWrite"
      )
      const inGWritten = yield* api.WriteVersion({
        slotId: m1.slotId,
        forkId: g,
        content: "g's",
        expectedRowVersion: inG.rowVersion
      })
      assert.strictEqual(inGWritten.shownForkId, g)
      assert.deepStrictEqual(yield* texts(main), ["m0", "mine"])
      assert.deepStrictEqual(yield* texts(g), ["m0", "g's"])
    }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("summaries per fork's selection", () => {
  it.live("a swipe in one fork leaves the other's summaries fresh, and only its planner has work", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const user = yield* api.Whoami()
      const userId = user.id as UserId
      const writer = yield* Writer
      const reader = yield* Reader
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic",
        overrides: { context: 4096 }
      })
      const preset = yield* writer.CreateEntity({
        userId,
        kind: "preset",
        label: "Synthetic",
        subtitle: "",
        schemaVersion: 1,
        origin: "user",
        sourcePath: null,
        doc: importStPreset(JSON.stringify({ openai_max_context: 4096, openai_max_tokens: 256 })).document!
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
      })
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Summaries",
        participants: [],
        greeting: null
      })
      const main = chat.currentForkId! as ForkId
      const slots: Array<{ slotId: SlotId; versionId: VersionId }> = []
      for (let n = 0; n < 12; n++) {
        const row = yield* writer.AppendMessage({
          userId,
          chatId: chat.id,
          forkId: main,
          parentSlotId: slots.at(-1)?.slotId ?? null,
          branch: false,
          commitDraft: null,
          version: said(`slot ${n} ` + "x".repeat(1100), "human")
        })
        slots.push({ slotId: row.slotId, versionId: row.version.id as VersionId })
      }
      // A summary of the first four messages, as both forks show them.
      const covered = slots.slice(0, 4)
      const summary = yield* completeFixture(
        config.dataDir,
        writer,
        userId,
        chat.id,
        covered.map((s) => ({ slotId: s.slotId, versionId: s.versionId, amendCount: 0 }))
      )
      const g = (yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: main,
        atSlotId: slots.at(-1)!.slotId
      })).fork.id
      const gTip = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: g,
        parentSlotId: slots.at(-1)!.slotId,
        branch: false,
        commitDraft: null,
        version: said("g goes on " + "y".repeat(1100), "human")
      })
      const mainTip = slots.at(-1)!.slotId
      const plan = (leafSlotId: SlotId) =>
        reader.PlanSummaries({ userId, chatId: chat.id, leafSlotId, reason: "reply" })
      /** Whether the summary is fresh on the path to `leafSlotId`, as the fork through it shows it. */
      const fresh = (leafSlotId: SlotId) =>
        Effect.map(
          reader.GetLcmCoverage({
            userId,
            chatId: chat.id,
            leafSlotId,
            fromDepth: 0,
            toDepth: 20,
            includeResolved: true
          }),
          (coverage) => coverage.summaries.find((s) => s.id === summary.id)?.fresh
        )
      const gPlan = yield* plan(gTip.slotId)
      assert.deepStrictEqual([yield* fresh(gTip.slotId), yield* fresh(mainTip)], [true, true])

      // Main swipes a covered message: a new version, selected in main only.
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: covered[2]!.slotId,
        forkId: main,
        version: said("a different turn " + "z".repeat(1100), "human"),
        select: true,
        commitDraft: null
      })
      // Main is current now: its summary reads stale, G's still fresh.
      assert.isFalse((yield* reader.GetSummary({ userId, summaryId: summary.id })).fresh)
      assert.deepStrictEqual([yield* fresh(gTip.slotId), yield* fresh(mainTip)], [true, false])
      // G's planner sees nothing new; main's plans over the swipe.
      assert.deepStrictEqual(yield* plan(gTip.slotId), gPlan)
      const mainPlan = yield* plan(mainTip)
      assert.include(JSON.stringify(mainPlan), swipe.id)
      assert.notInclude(JSON.stringify(gPlan), swipe.id)

      // A reply in main plans in main, also once G is current again: at a message both paths
      // hold, a plan without a fork reads G's choices, one in main reads main's.
      yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: g,
        parentSlotId: gTip.slotId,
        branch: false,
        commitDraft: null,
        version: said("g again", "human")
      })
      const shared = slots.at(-2)!.slotId
      const sharedPlan = (forkId?: ForkId) =>
        reader.PlanSummaries({
          userId,
          chatId: chat.id,
          leafSlotId: shared,
          reason: "reply",
          ...(forkId ? { forkId } : {})
        })
      assert.notInclude(JSON.stringify(yield* sharedPlan()), swipe.id)
      assert.include(JSON.stringify(yield* sharedPlan(main)), swipe.id)
    }).pipe(Effect.provide(serverLayer(config)))
  )
})
