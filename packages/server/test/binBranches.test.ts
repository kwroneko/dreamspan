// The branches a "delete for good" affects (`BinItemBranches`, ARCHITECTURE §3.11): the ones that
// show the text, with where the message is in each, and the ones that hold it only in the bin,
// through the real workers.
import { assert, describe, it } from "@effect/vitest"
import type { BinBranch } from "@rp/shared/bin.ts"
import { type ChatId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("bin-branches"), readers: 2, allowNetworkFs: false, ...testWorkers })

const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const reader = yield* Database.Reader
  const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })).id
  const card = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Mira",
    subtitle: "",
    doc: cardDoc("Mira"),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  const say = (content: string) =>
    new NewVersion({
      speakerEntityId: card.entityId,
      writer: "model",
      content,
      status: "complete",
      macroMode: "verbatim",
      origin: "generated"
    })
  const chatOf = (title: string) =>
    Effect.gen(function* () {
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title,
        participants: [card.entityId],
        greeting: null
      })
      const chatId = chat.id as ChatId
      const send = (forkId: ForkId, parentSlotId: SlotId | null, content: string) =>
        Effect.map(
          writer.AppendMessage({
            userId,
            chatId,
            forkId,
            parentSlotId,
            branch: false,
            version: say(content),
            commitDraft: null
          }),
          (sent) => sent.slotId
        )
      const fork = (from: ForkId, at: SlotId | null) =>
        Effect.map(
          writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }),
          (made) => made.fork.id as ForkId
        )
      return { chatId, main: chat.currentForkId as ForkId, send, fork }
    })
  const branches = (itemIds: ReadonlyArray<string>) => reader.BinItemBranches({ userId, itemIds })
  return { writer, reader, userId, card, say, chatOf, branches }
})

/** The fields a test compares, by fork. */
const view = (branch: BinBranch) => ({
  state: branch.state,
  shows: branch.shows,
  position: branch.position,
  link: branch.link
})

describe("the branches deleting for good affects", () => {
  it.live("names the forks that show it with its position, those it's in the bin for, and no purged one", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, card, say, chatOf, branches } = yield* setup
      const { chatId, main, send, fork } = yield* chatOf("Harbor")
      // main: root → a → b → c
      const root = yield* send(main, null, "root")
      const a = yield* send(main, root, "a")
      const b = yield* send(main, a, "b")
      yield* send(main, b, "c")
      // side shows b one place further down: a message inserted below a, above it.
      const side = yield* fork(main, b)
      yield* writer.SetForkName({ userId, forkId: side, name: "Side road" })
      const rowVersion = (yield* reader.GetSlot({ userId, slotId: a, forkId: side })).entry.rowVersion
      yield* writer.InsertMessage({
        userId,
        chatId,
        forkId: side,
        anchorSlotId: a,
        expectedRowVersion: rowVersion,
        body: { _tag: "Write", speaker: card.entityId, content: "inserted" }
      })
      yield* send(side, b, "g")
      // far went another way at a, so it never had b.
      const far = yield* fork(main, a)
      yield* send(far, a, "f")
      // binned shows b, but is in the bin itself.
      const binned = yield* fork(main, b)
      yield* send(binned, b, "k")
      const binnedItem = yield* writer.DeleteFork({ userId, forkId: binned })
      // purged had b, and is gone for good.
      const purged = yield* fork(main, b)
      yield* send(purged, b, "p")
      const purgedItem = yield* writer.DeleteFork({ userId, forkId: purged })
      yield* writer.PurgeBinItem({ userId, itemId: purgedItem.id })
      // twice deleted b in its own view, at its tip: its tip went up to a.
      const twice = yield* fork(main, b)
      yield* writer.DeleteMessage({ userId, slotId: b, forkId: twice })
      // And main deletes it: the item asked about.
      const item = yield* writer.DeleteMessage({ userId, slotId: b, forkId: main })

      const listed = yield* branches([item.id])
      const byFork = new Map(listed.map((branch) => [branch.forkId, branch]))
      assert.sameMembers([...byFork.keys()], [side, main, twice, binned])
      assert.strictEqual(listed.length, 4)
      assert.isFalse(byFork.has(far))
      assert.isFalse(byFork.has(purged))
      // The live one that shows it first, then those it's in the bin for, the deleted branch last.
      assert.deepStrictEqual(
        listed.map((branch) => branch.state),
        ["shown", "deletedHere", "deletedHere", "branchInBin"]
      )
      // Message 4 in side (the inserted one above it), linked at itself.
      assert.deepStrictEqual(view(byFork.get(side)!), {
        state: "shown",
        shows: true,
        position: 3,
        link: { slotId: b, position: 3 }
      })
      // Where it deleted it, message 3, it opens at a, the message above it.
      assert.deepStrictEqual(view(byFork.get(main)!), {
        state: "deletedHere",
        shows: false,
        position: 2,
        link: { slotId: a, position: 1 }
      })
      // Off twice's path now (its tip went up), numbered on the path to it, opened at a.
      assert.deepStrictEqual(view(byFork.get(twice)!), {
        state: "deletedHere",
        shows: false,
        position: 2,
        link: { slotId: a, position: 1 }
      })
      assert.deepStrictEqual(view(byFork.get(binned)!), {
        state: "branchInBin",
        shows: true,
        position: null,
        link: null
      })
      // `shows` is exactly what the purge confirms.
      assert.sameMembers(
        listed.filter((branch) => branch.shows).map((branch) => branch.forkId),
        (yield* reader.BinItemForks({ userId, itemIds: [item.id] })).map((shown) => shown.forkId)
      )
      // Named as the branch list names them: the name, "Original", else "Branch k" among the live ones.
      const sideBranch = byFork.get(side)!
      assert.deepStrictEqual([sideBranch.name, sideBranch.original, sideBranch.number], ["Side road", false, 1])
      assert.deepStrictEqual([byFork.get(main)!.original, byFork.get(main)!.number], [true, null])
      assert.strictEqual(byFork.get(twice)!.number, 3)
      assert.strictEqual(sideBranch.tipExcerpt, "g")
      assert.strictEqual(sideBranch.chatTitle, "Harbor")
      const current = (yield* reader.ListForks({ userId, chatId })).find((f) => f.current)!.id
      for (const branch of listed) assert.strictEqual(branch.current, branch.forkId === current)

      // A fork deleted on its own affects only itself; a purged item, nothing.
      assert.deepStrictEqual(
        (yield* branches([binnedItem.id])).map((branch) => [branch.forkId, branch.state, branch.link]),
        [[binned, "branchInBin", null]]
      )
      assert.deepStrictEqual(yield* branches([purgedItem.id]), [])

      // Another chat's branches go with it.
      const other = yield* chatOf("Lighthouse")
      const first = yield* other.send(other.main, null, "hello")
      const otherFork = yield* other.fork(other.main, first)
      const chatItem = yield* writer.DeleteChat({ userId, chatId: other.chatId })
      const gone = yield* branches([chatItem.id])
      assert.sameMembers(
        gone.map((branch) => branch.forkId),
        [other.main, otherFork]
      )
      for (const branch of gone) assert.deepStrictEqual([branch.state, branch.link], ["chatInBin", null])

      // The swipes of a message: a fork whose own message deletion holds them in the bin counts too.
      const again = yield* writer.AddVersion({
        userId,
        slotId: a,
        version: say("a again"),
        select: false,
        commitDraft: null
      })
      yield* writer.DeleteMessage({ userId, slotId: a, forkId: far })
      const swipe = yield* writer.DeleteVersion({ userId, versionId: again.id, forkId: side })
      const swiped = new Map((yield* branches([swipe.id])).map((branch) => [branch.forkId, branch]))
      assert.strictEqual(swiped.get(side)!.state, "deletedHere")
      assert.strictEqual(swiped.get(far)!.state, "deletedHere")
      assert.deepStrictEqual(view(swiped.get(main)!), {
        state: "shown",
        shows: true,
        position: 1,
        link: { slotId: a, position: 1 }
      })
    }).pipe(Effect.provide(database()))
  )
})
