// Fork-owned versions, amends and flags (spec/FORK-INDEPENDENCE-DELTA.md §2.2, implementation
// unit 4). A swipe belongs to its message, so it's in every fork's picker there (CHATS.md
// "Forks", owner 2026-10-26); only which one is selected is per fork. Amending a user's message
// that another fork shows gives the amending fork a copy standing in for it (a `replace`
// override), so the other fork keeps its text and history; with no other fork showing it, the
// amend is in place. Stars and "hidden from the arrows" are the fork's own. The migration is in
// forkVersionsMigration.test.ts.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

const config = testConfig()

const said = (content: string, writer: "human" | "model" = "model", status: "complete" | "generating" = "complete") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status,
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

/**
 * A chat of `m0` ("hello", the user's, with an unselected version "hello again"), `m1` (a
 * reply "one", with a swipe "two") and `m2` (the user's "go on"), in fork `main`, and helpers.
 */
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
    title: "Copies",
    participants: [],
    greeting: null
  })
  const chatId = chat.id as ChatId
  const main = chat.currentForkId! as ForkId
  const append = (parent: SlotId | null, content: string, forkId: ForkId = main, human = parent === null) =>
    writer.AppendMessage({
      userId,
      chatId,
      forkId,
      parentSlotId: parent,
      branch: false,
      version: said(content, human ? "human" : "model"),
      commitDraft: null
    })
  const m0 = yield* append(null, "hello")
  const again = yield* writer.AddVersion({
    userId,
    slotId: m0.slotId,
    version: said("hello again", "human"),
    select: false,
    commitDraft: null
  })
  const m1 = yield* append(m0.slotId, "one")
  const two = yield* writer.AddVersion({
    userId,
    slotId: m1.slotId,
    version: said("two"),
    select: false,
    commitDraft: null
  })
  const m2 = yield* append(m1.slotId, "go on", main, true)
  /** The path's texts as `forkId` shows it. */
  const texts = (forkId: ForkId) =>
    Effect.map(reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }), (path) =>
      path.entries.map((e) => e.version.content)
    )
  /** What `forkId` shows at a slot. */
  const shown = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.GetSlot({ userId, slotId, forkId }), ({ entry }) => entry)
  /** The picker at a slot in `forkId`: each version's id, text and flags, in order. */
  const picker = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.ListVersions({ userId, slotId, forkId }), (versions) =>
      versions.map((v) => ({ id: v.id, content: v.content, starred: v.starred, hidden: v.hidden }))
    )
  /** Amends what `forkId` shows at a slot, as a tab showing it would. */
  const amend = (slotId: SlotId, forkId: ForkId, content: string) =>
    Effect.gen(function* () {
      const { version } = yield* shown(slotId, forkId)
      return yield* writer.AmendVersion({
        userId,
        versionId: version.id,
        forkId,
        content,
        expectedRowVersion: version.rowVersion
      })
    })
  const select = (slotId: SlotId, forkId: ForkId, versionId: VersionId) =>
    Effect.gen(function* () {
      const before = yield* shown(slotId, forkId)
      return yield* writer.SelectVersion({ userId, slotId, versionId, forkId, expectedVersionId: before.version.id })
    })
  const fork = (from: ForkId, at: SlotId | null) =>
    Effect.map(writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }), (made) => made.fork.id)
  const rows = (sql: string, ...params: Array<string | number | null>) =>
    Effect.map(fixtureSql(config.dataDir, [{ sql, params }], { readOnly: true }), ([result]) => result!)
  /** A version's earlier texts, oldest first. */
  const history = (versionId: string) =>
    Effect.map(rows("SELECT content FROM version_history WHERE version_id = ? ORDER BY id", versionId), (found) =>
      found.map((row) => row.content as string)
    )
  return {
    api,
    userId,
    writer,
    reader,
    chatId,
    main,
    append,
    m0,
    m1,
    m2,
    hello: m0.version.id as VersionId,
    again: again.id as VersionId,
    one: m1.version.id as VersionId,
    two: two.id as VersionId,
    texts,
    shown,
    picker,
    amend,
    select,
    fork,
    rows,
    history
  }
})

describe("swipes at a shared message", () => {
  it.live("a swipe made in one fork is in the other fork's picker, unselected there", () =>
    Effect.gen(function* () {
      const { writer, userId, m1, main, one, two, texts, shown, picker, fork } = yield* setup
      const g = yield* fork(main, m1.slotId)
      const three = yield* writer.AddVersion({
        userId,
        slotId: m1.slotId,
        forkId: main,
        version: said("three"),
        select: true,
        commitDraft: null
      })
      assert.deepStrictEqual(yield* texts(main), ["hello", "three", "go on"])
      assert.deepStrictEqual(yield* texts(g), ["hello", "one"])
      // Swipes belong to the message (owner, 2026-10-26): G's picker has it, G still shows "one".
      for (const forkId of [main, g])
        assert.deepStrictEqual(
          (yield* picker(m1.slotId, forkId)).map((v) => v.id),
          [one, two, three.id]
        )
      assert.strictEqual((yield* shown(m1.slotId, g)).versionCount, 3)
    }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("amending a shared message", () => {
  it.live("amending in one fork leaves the other fork's text and history", () =>
    Effect.gen(function* () {
      const { writer, userId, m0, main, hello, again, texts, shown, picker, amend, fork, history, rows } = yield* setup
      const g = yield* fork(main, m0.slotId)
      const copy = yield* amend(m0.slotId, main, "hello there")
      assert.notStrictEqual(copy.id, hello)
      assert.strictEqual(copy.sourceVersionId, hello)
      assert.strictEqual(copy.origin, "edited")
      assert.strictEqual(copy.rowVersion, 2)
      assert.deepStrictEqual((yield* texts(main))[0], "hello there")
      assert.deepStrictEqual(yield* texts(g), ["hello"])
      // The original is untouched: its text, its history; the copy's history is the original's.
      assert.deepStrictEqual(yield* history(hello), [])
      assert.deepStrictEqual(yield* history(copy.id), ["hello"])
      const [owned] = yield* rows("SELECT fork_id, content FROM versions WHERE id = ?", hello)
      assert.deepStrictEqual(owned, { fork_id: null, content: "hello" })
      // In the picker the copy is where its original was, and the count is the message's own.
      assert.deepStrictEqual(yield* picker(m0.slotId, main), [
        { id: copy.id, content: "hello there", starred: false, hidden: false },
        { id: again, content: "hello again", starred: false, hidden: false }
      ])
      assert.deepStrictEqual(
        (yield* picker(m0.slotId, g)).map((v) => v.content),
        ["hello", "hello again"]
      )
      assert.strictEqual((yield* shown(m0.slotId, main)).versionCount, 2)
      assert.strictEqual((yield* shown(m0.slotId, main)).version.ordinal, 0)
      // A tab of main that still shows the original is stale; one of G amends G's.
      assert.strictEqual(
        yield* outcome(
          writer.AmendVersion({ userId, versionId: hello, forkId: main, content: "late", expectedRowVersion: 1 })
        ),
        "StaleWrite"
      )
      // The copy is main's alone now: amending it again is in place.
      const twice = yield* amend(m0.slotId, main, "hello there!")
      assert.strictEqual(twice.id, copy.id)
      assert.strictEqual(twice.rowVersion, 3)
      assert.deepStrictEqual(yield* history(copy.id), ["hello", "hello there"])
      assert.deepStrictEqual(yield* texts(g), ["hello"])
      assert.deepStrictEqual(yield* history(hello), [])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("an amend no other fork can see is in place; once a fork is made through it, it copies", () =>
    Effect.gen(function* () {
      const { m1, m2, main, texts, shown, amend, fork, history } = yield* setup
      // G leaves at m1, before m2: its path doesn't hold m2.
      const g = yield* fork(main, m1.slotId)
      const own = (yield* shown(m2.slotId, main)).version.id
      const inPlace = yield* amend(m2.slotId, main, "go on, then")
      assert.strictEqual(inPlace.id, own)
      assert.deepStrictEqual(yield* history(own), ["go on"])
      assert.deepStrictEqual(yield* texts(g), ["hello", "one"])
      // A fork made at m2 shows it too, so the next amend is a copy and the child keeps its text.
      const child = yield* fork(main, m2.slotId)
      const copy = yield* amend(m2.slotId, main, "go on, please")
      assert.notStrictEqual(copy.id, own)
      assert.deepStrictEqual((yield* texts(child)).at(-1), "go on, then")
      assert.deepStrictEqual((yield* texts(main)).at(-1), "go on, please")
      assert.deepStrictEqual(yield* history(copy.id), ["go on", "go on, then"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("a fork made after an amend inherits it, from the tip and from an earlier point, and keeps it", () =>
    Effect.gen(function* () {
      const { m0, m1, main, hello, texts, shown, amend, fork } = yield* setup
      const before = yield* fork(main, m1.slotId)
      const copy = yield* amend(m0.slotId, main, "hi")
      const fromTip = yield* fork(main, null)
      const fromEarlier = yield* fork(main, m0.slotId)
      const fromMiddle = yield* fork(main, m1.slotId)
      assert.deepStrictEqual(yield* texts(before), ["hello", "one"])
      assert.deepStrictEqual(yield* texts(fromEarlier), ["hi"])
      assert.deepStrictEqual(yield* texts(fromMiddle), ["hi", "one"])
      assert.deepStrictEqual(yield* texts(fromTip), [])
      // The children show main's copy, so main's next amend copies again, and they keep "hi".
      const again = yield* amend(m0.slotId, main, "hi again")
      assert.notStrictEqual(again.id, copy.id)
      assert.strictEqual(again.sourceVersionId, hello)
      assert.deepStrictEqual(yield* texts(fromMiddle), ["hi", "one"])
      assert.deepStrictEqual((yield* texts(main))[0], "hi again")
      // A child amending what it inherited gets its own copy; main keeps its own.
      const childs = yield* amend(m0.slotId, fromEarlier, "hey")
      assert.notStrictEqual(childs.id, copy.id)
      assert.deepStrictEqual(yield* texts(fromEarlier), ["hey"])
      assert.deepStrictEqual(yield* texts(fromMiddle), ["hi", "one"])
      assert.strictEqual((yield* shown(m0.slotId, main)).version.content, "hi again")
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("selecting in the picker names the message's own version, whichever the fork shows", () =>
    Effect.gen(function* () {
      const { m0, main, hello, again, texts, shown, amend, select, fork, rows } = yield* setup
      const g = yield* fork(main, m0.slotId)
      const copy = yield* amend(m0.slotId, main, "hello there")
      // The tab saw the copy; it selects another version, then the copy again.
      yield* select(m0.slotId, main, again)
      assert.deepStrictEqual((yield* texts(main))[0], "hello again")
      yield* select(m0.slotId, main, copy.id)
      assert.deepStrictEqual((yield* texts(main))[0], "hello there")
      assert.strictEqual((yield* shown(m0.slotId, main)).version.id, copy.id)
      const selections = yield* rows(
        "SELECT value_id FROM fork_overrides WHERE fork_id = ? AND kind = 'select' AND target_id = ?",
        main,
        m0.slotId
      )
      assert.deepStrictEqual(selections, [{ value_id: hello }])
      assert.deepStrictEqual(yield* texts(g), ["hello"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("readers in the amending fork read the copy: the assembler, events on the original, tips, branches", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chatId, m0, main, hello, amend, fork } = yield* setup
      const g = yield* fork(main, m0.slotId)
      yield* amend(m0.slotId, main, "hello there")
      // The assembler, on a reply under the message in each fork.
      const context = (forkId: ForkId) =>
        Effect.gen(function* () {
          const reply = yield* writer.AppendMessage({
            userId,
            chatId,
            forkId,
            parentSlotId: m0.slotId,
            branch: true,
            version: said("", "model", "generating"),
            commitDraft: null
          })
          const { snapshot } = yield* reader.AssembleContext({
            userId,
            chatId,
            slotId: reply.slotId,
            versionId: reply.version.id,
            forkId: reply.forkId,
            now: 0,
            timeZone: "UTC",
            frozen: null
          })
          return (JSON.parse(snapshot) as ContextSnapshot).request.messages.map((m) => m.content).join("\n")
        })
      assert.include(yield* context(g), "hello")
      assert.notInclude(yield* context(g), "hello there")
      assert.include(yield* context(main), "hello there")
      // An event attached to the original applies where the fork shows its copy.
      yield* writer.AddStateEvent({
        userId,
        chatId,
        slotId: m0.slotId,
        versionId: hello,
        scope: null,
        data: { key: "var.set", value: { name: "mood", value: "bright" } }
      })
      const vars = (forkId: ForkId) =>
        Effect.map(
          reader.StateEventsAt({ userId, chatId, slotId: m0.slotId, forkId }),
          (events) => events.filter((e) => e.data.key === "var.set").length
        )
      assert.deepStrictEqual([yield* vars(main), yield* vars(g)], [1, 1])
      // A fork's tip text, and the alternates' first words, are the copy's in main.
      const fromMain = yield* fork(main, m0.slotId)
      const fromG = yield* fork(g, m0.slotId)
      const listed = yield* reader.ListForks({ userId, chatId })
      assert.strictEqual(listed.find((f) => f.id === fromMain)!.tipExcerpt, "hello there")
      assert.strictEqual(listed.find((f) => f.id === fromG)!.tipExcerpt, "hello")
      const branches = (forkId: ForkId) =>
        Effect.map(reader.ListBranches({ userId, slotId: m0.slotId, forkId }), (found) => found.map((b) => b.preview))
      assert.deepStrictEqual(yield* branches(main), ["hello there"])
      assert.deepStrictEqual(yield* branches(g), ["hello"])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live(
    "deleting a copy deletes the swipe; restoring brings the copy back; deleting for good erases every copy",
    () =>
      Effect.gen(function* () {
        const { writer, userId, m0, main, hello, texts, amend, fork, rows, history } = yield* setup
        const g = yield* fork(main, m0.slotId)
        const copy = yield* amend(m0.slotId, main, "hello there")
        const item = yield* writer.DeleteVersion({ userId, versionId: copy.id, forkId: main })
        const [binned] = yield* rows("SELECT target_id FROM bin_items WHERE id = ?", item.id)
        assert.strictEqual(binned!.target_id, hello)
        assert.deepStrictEqual(yield* texts(main), ["hello again", "one", "go on"])
        // Only `main` deleted it: `g` still shows the swipe.
        assert.deepStrictEqual(yield* texts(g), ["hello"])
        yield* writer.RestoreBinItem({ userId, itemId: item.id })
        // The selection stays where the delete moved it; the copy is back in its original's place.
        yield* writer.SelectVersion({
          userId,
          slotId: m0.slotId,
          versionId: hello,
          forkId: main,
          expectedVersionId: (yield* rows(
            "SELECT value_id FROM fork_overrides WHERE fork_id = ? AND kind = 'select'",
            main
          ))[0]!.value_id as VersionId
        })
        assert.deepStrictEqual((yield* texts(main))[0], "hello there")
        const again = yield* writer.DeleteVersion({ userId, versionId: copy.id, forkId: main })
        yield* writer.PurgeBinItem({ userId, itemId: again.id })
        const [purged] = yield* rows(
          "SELECT content, purged_at IS NOT NULL AS purged FROM versions WHERE id = ?",
          copy.id
        )
        assert.deepStrictEqual(purged, { content: "", purged: 1 })
        assert.deepStrictEqual(yield* history(copy.id), [])
      }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("flags per fork", () => {
  it.live("a star or a picker flag set in one fork leaves the other's; a fork made after inherits them", () =>
    Effect.gen(function* () {
      const { writer, userId, m0, m1, main, one, two, picker, shown, amend, fork, rows } = yield* setup
      const g = yield* fork(main, m1.slotId)
      const set = yield* writer.SetVersionFlags({ userId, versionId: two, forkId: main, starred: true, hidden: true })
      assert.strictEqual(set.forkId, main)
      assert.deepStrictEqual([set.version.starred, set.version.hidden], [true, true])
      const flags = (forkId: ForkId) =>
        Effect.map(picker(m1.slotId, forkId), (versions) => versions.map((v) => [v.id, v.starred, v.hidden]))
      assert.deepStrictEqual(yield* flags(main), [
        [one, false, false],
        [two, true, true]
      ])
      assert.deepStrictEqual(yield* flags(g), [
        [one, false, false],
        [two, false, false]
      ])
      const later = yield* fork(main, m1.slotId)
      assert.deepStrictEqual(yield* flags(later), yield* flags(main))
      // Toggling at a fork nobody forked from since leaves one row a flag; the child keeps its.
      yield* writer.SetVersionFlags({ userId, versionId: two, forkId: main, starred: false })
      yield* writer.SetVersionFlags({ userId, versionId: two, forkId: later, starred: false })
      yield* writer.SetVersionFlags({ userId, versionId: two, forkId: later, starred: true })
      yield* writer.SetVersionFlags({ userId, versionId: two, forkId: later, starred: false })
      const stars = yield* rows(
        "SELECT fork_id, flag FROM fork_overrides WHERE kind = 'star' AND target_id = ? ORDER BY seq",
        two
      )
      assert.deepStrictEqual(stars, [
        { fork_id: main, flag: 1 },
        { fork_id: main, flag: 0 },
        { fork_id: later, flag: 0 }
      ])
      // Setting what the fork already shows writes nothing.
      yield* writer.SetVersionFlags({ userId, versionId: two, forkId: g, starred: false })
      assert.lengthOf(yield* rows("SELECT 1 FROM fork_overrides WHERE fork_id = ? AND kind = 'star'", g), 0)
      // A flag on a copy is on its original, and shows on the copy.
      const copy = yield* amend(m0.slotId, main, "hello there")
      yield* writer.SetVersionFlags({ userId, versionId: copy.id, forkId: main, starred: true })
      assert.strictEqual((yield* shown(m0.slotId, main)).version.starred, true)
      assert.deepStrictEqual(
        (yield* picker(m0.slotId, g)).map((v) => v.starred),
        [false, false]
      )
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.live("the API publishes a fork's flags and amends for that fork, and tabs on another leave them", () =>
    Effect.gen(function* () {
      const { api, chatId, m0, m1, main, two, fork } = yield* setup
      const g = yield* fork(main, m1.slotId)
      const flagged = yield* api.SetVersionFlags({ versionId: two, forkId: g, starred: true })
      assert.strictEqual(flagged.starred, true)
      const inMain = yield* api.ListVersions({ slotId: m1.slotId, forkId: main })
      assert.isFalse(inMain.find((v) => v.id === two)!.starred)
      const inG = yield* api.ListVersions({ slotId: m1.slotId, forkId: g })
      assert.isTrue(inG.find((v) => v.id === two)!.starred)
      const entry = (yield* api.ReadPath({ chatId, forkId: g, leafSlotId: null, range: { _tag: "Bottom" }, limit: 9 }))
        .entries[0]!
      const copy = yield* api.AmendVersion({
        versionId: entry.version.id,
        forkId: g,
        content: "hi from g",
        expectedRowVersion: entry.version.rowVersion
      })
      assert.notStrictEqual(copy.id, entry.version.id)
      const read = (forkId: ForkId) =>
        Effect.map(api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 9 }), (path) =>
          path.entries.find((e) => e.slotId === m0.slotId)!
        )
      assert.strictEqual((yield* read(g)).version.content, "hi from g")
      assert.strictEqual((yield* read(main)).version.content, "hello")
      // The entry's row version in G moved with the replacement, so tabs on G take it.
      assert.isAbove((yield* read(g)).rowVersion, entry.rowVersion)
    }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("the database keeps versions and their flags the message's", () => {
  it.live("a version's flags are frozen; replacements, flags and selections name the message's own versions", () =>
    Effect.gen(function* () {
      const { m0, m1, main, two, amend, fork } = yield* setup
      yield* fork(main, m0.slotId)
      const copy = yield* amend(m0.slotId, main, "hello there")
      assert.isNotNull(copy.sourceVersionId)
      const db = new DatabaseSync(databaseFile(config.dataDir))
      try {
        assert.throws(
          () => db.prepare("UPDATE versions SET starred = 1 WHERE id = ?").run(two),
          "a version keeps the flags it was inserted with"
        )
        assert.throws(
          () => db.prepare("UPDATE versions SET hidden = 1 WHERE id = ?").run(two),
          "a version keeps the flags it was inserted with"
        )
        assert.throws(
          () => db.prepare("UPDATE versions SET fork_id = NULL WHERE id = ?").run(copy.id),
          "a version keeps its fork"
        )
        const override = (kind: string, target: string, slot: string, value: string | null, flag: number | null) =>
          db
            .prepare(
              `INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
              SELECT ?, s.chat_id, ?, 999, ?, ?, s.id, s.depth, ?, ? FROM slots s WHERE s.id = ?`
            )
            .run(`x-${kind}-${target}`, main, kind, target, value, flag, slot)
        // A replacement stands a copy of that version in for it, never another swipe…
        assert.throws(
          () => override("replace", two, m1.slotId, m1.version.id, null),
          "a replacement stands a copy in for one of its message's own versions"
        )
        // …and never for a copy.
        assert.throws(
          () => override("replace", copy.id, m0.slotId, null, null),
          "a replacement stands a copy in for one of its message's own versions"
        )
        assert.throws(() => override("star", copy.id, m0.slotId, null, 1), "a flag is set on one of its message's own")
        assert.throws(() => override("star", two, m1.slotId, null, null), "a flag is set on one of its message's own")
        assert.throws(
          () => override("select", m0.slotId, m0.slotId, copy.id, null),
          "a selection names one of its message's own versions"
        )
        // A fork's own version stands in for one of its message's own, in its chat.
        assert.throws(
          () =>
            db
              .prepare(
                `INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, source_version_id,
                  fork_id, created_at, updated_at)
                VALUES ('stray', ?, 99, 'complete', 'human', 'x', 'verbatim', 'edited', ?, ?, 0, 0)`
              )
              .run(m0.slotId, copy.id, main),
          "a fork's own version is in its chat and stands in for one of its message's own"
        )
      } finally {
        db.close()
      }
    }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("summaries over an amended message", () => {
  it.live("an amend in one fork makes its summaries stale there and leaves the other fork's fresh", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, append, m2, amend, fork } = yield* setup
      const slots = [m2]
      for (let n = 0; n < 4; n++)
        slots.push(yield* append(slots.at(-1)!.slotId, `turn ${n} ` + "x".repeat(400), main, true))
      const covered = slots.slice(0, 3)
      const summary = yield* completeFixture(
        config.dataDir,
        writer,
        userId,
        chatId,
        covered.map((s) => ({ slotId: s.slotId, versionId: s.version.id, amendCount: 0 }))
      )
      const g = yield* fork(main, slots.at(-1)!.slotId)
      const gTip = yield* append(slots.at(-1)!.slotId, "g goes on", g, true)
      // LCM's reads are addressed by a leaf (forkAt), so each fork gets a tip of its own.
      const mainTip = (yield* append(slots.at(-1)!.slotId, "main goes on", main, true)).slotId
      const fresh = (leafSlotId: SlotId) =>
        Effect.map(
          reader.GetLcmCoverage({ userId, chatId, leafSlotId, fromDepth: 0, toDepth: 20, includeResolved: true }),
          (coverage) => coverage.summaries.find((x) => x.id === summary.id)?.fresh
        )
      assert.deepStrictEqual([yield* fresh(gTip.slotId), yield* fresh(mainTip)], [true, true])
      const copy = yield* amend(covered[1]!.slotId, main, "an amended turn")
      assert.notStrictEqual(copy.id, covered[1]!.version.id)
      assert.deepStrictEqual([yield* fresh(gTip.slotId), yield* fresh(mainTip)], [true, false])
    }).pipe(Effect.provide(serverLayer(config)))
  )
})

describe("the assembler's swipe counts", () => {
  it.live("a copy is counted as its original: amending in one fork changes no fork's swipe macros", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chatId, m2, main, amend, fork } = yield* setup
      // A reply after the user's "go on" that reads that message's swipe number and count.
      const macro = yield* writer.AppendMessage({
        userId,
        chatId,
        forkId: main,
        parentSlotId: m2.slotId,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "swipe {{currentSwipeId}} of {{lastSwipeId}}",
          status: "complete",
          macroMode: "template",
          origin: "generated"
        }),
        commitDraft: null
      })
      const g = yield* fork(main, macro.slotId)
      const context = (forkId: ForkId) =>
        Effect.gen(function* () {
          const reply = yield* writer.AppendMessage({
            userId,
            chatId,
            forkId,
            parentSlotId: macro.slotId,
            branch: true,
            version: said("", "model", "generating"),
            commitDraft: null
          })
          const { snapshot } = yield* reader.AssembleContext({
            userId,
            chatId,
            slotId: reply.slotId,
            versionId: reply.version.id,
            forkId: reply.forkId,
            now: 0,
            timeZone: "UTC",
            frozen: null
          })
          const text = (JSON.parse(snapshot) as ContextSnapshot).request.messages.map((m) => m.content).join("\n")
          return /swipe \S+ of \S+/.exec(text)?.[0]
        })
      assert.strictEqual(yield* context(g), "swipe 1 of 1")
      // Main amends "go on", which G shows too: main gets a copy in its place.
      yield* amend(m2.slotId, main, "go on, slowly")
      assert.deepStrictEqual([yield* context(main), yield* context(g)], ["swipe 1 of 1", "swipe 1 of 1"])
    }).pipe(Effect.provide(serverLayer(config)))
  )
})
