// A workshop beside a story as a parallel thread of its story branch (spec/WORKSHOP-BRANCHES.md),
// each test one of the owner's statements (DESIGN §7.7, 2026-11-17): branching the story branches
// its workshops, the branches go on apart, a workshop shows only beside its own story branch, it
// reads its paired branch wherever it's open, and the bin takes a story branch's workshop
// branches with it. Synthetic chats only.
import { canonicalJson } from "@dreamspan/shared/editing.ts"
import { assert, layer } from "@effect/vitest"
import { type Chat, type ChatId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id as UserId
  const story = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Ledger",
    participants: [],
    greeting: null
  })
  const main = story.currentForkId as ForkId
  /** Appends to the end of fork `forkId` of chat `chatId`. */
  const append = (chatId: ChatId, forkId: ForkId, content: string) =>
    Effect.gen(function* () {
      const path = yield* reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 200 })
      return yield* writer.AppendMessage({
        userId,
        chatId,
        forkId,
        parentSlotId: path.entries.at(-1)?.slotId ?? null,
        branch: false,
        commitDraft: null,
        version: said(content)
      })
    })
  const texts = (chatId: ChatId, forkId: ForkId) =>
    Effect.map(reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 200 }), (path) =>
      path.entries.filter((e) => e.version.origin !== "greeting").map((e) => e.version.content)
    )
  /** The workshop's live branch that goes with story branch `storyFork`. */
  const pairedIn = (workshop: Chat, storyFork: ForkId) =>
    Effect.map(api.ListWorkshopBranches({ chatId: workshop.id }), (branches) =>
      branches.filter((b) => b.story?.forkId === storyFork).map((b) => b.forkId)
    )
  const branchStory = (atSlotId: SlotId, workshops?: Record<string, "then" | "now">, from: ForkId = main) =>
    Effect.gen(function* () {
      const payload = { userId, chatId: story.id, fromForkId: from, atSlotId }
      const preview = yield* reader.PreviewForkNotes(payload)
      const made = yield* writer.CreateFork({
        ...payload,
        notes: {
          comparison: canonicalJson(preview),
          choices: [],
          ...(workshops
            ? {
                workshops: Object.entries(workshops).map(([workshop, choice]) => ({
                  workshop: workshop as ChatId,
                  choice
                }))
              }
            : {})
        }
      })
      return { preview, fork: made.fork.id as ForkId }
    })
  // The owner's day: the story moves on, and the workshop talks about it as it does.
  const s1 = yield* append(story.id, main, "The caravan leaves at dawn.")
  const workshop = yield* api.CreateWorkshop({ attachTo: story.id })
  const w = workshop.currentForkId as ForkId
  yield* append(workshop.id, w, "W1: is the dawn start believable?")
  const s2 = yield* append(story.id, main, "Bandits wait at the pass.")
  yield* append(workshop.id, w, "W2: the bandits feel sudden.")
  const s3 = yield* append(story.id, main, "The caravan turns back.")
  yield* append(workshop.id, w, "W3: turning back ends the arc.")
  return { api, writer, reader, userId, story, main, workshop, w, s1, s2, s3, append, texts, pairedIn, branchStory }
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })("workshop branches", (it) => {
  it.effect("branching the story branches its workshop; the two go on apart; going back finds A's as it was", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const b = yield* h.branchStory(h.s1.slotId)
      const [onB] = yield* h.pairedIn(h.workshop, b.fork)
      assert.isDefined(onB)
      // Made at message 1: what the workshop said then, not later.
      assert.deepStrictEqual(yield* h.texts(h.workshop.id, onB!), ["W1: is the dawn start believable?"])
      yield* h.append(h.workshop.id, onB!, "W4 on B: the ambush could come later.")
      yield* h.append(h.workshop.id, h.w, "W5 on A: keep the turn back.")
      // Back on A: its workshop as it was, with only what was said on A since.
      assert.deepStrictEqual(yield* h.texts(h.workshop.id, h.w), [
        "W1: is the dawn start believable?",
        "W2: the bandits feel sudden.",
        "W3: turning back ends the arc.",
        "W5 on A: keep the turn back."
      ])
      assert.deepStrictEqual(yield* h.texts(h.workshop.id, onB!), [
        "W1: is the dawn start believable?",
        "W4 on B: the ambush could come later."
      ])
      // Branching the workshop's own branch doesn't touch the story.
      assert.lengthOf(yield* h.api.ListForks({ chatId: h.story.id }), 2)
    })
  )

  it.effect("branching at the display end keeps workshop messages about a deleted story tip", () =>
    Effect.gen(function* () {
      const h = yield* setup
      yield* h.writer.DeleteMessage({ userId: h.userId, forkId: h.main, slotId: h.s3.slotId })
      const { preview, fork } = yield* h.branchStory(h.s2.slotId)
      assert.isEmpty(preview.workshops)
      const [paired] = yield* h.pairedIn(h.workshop, fork)
      assert.isDefined(paired)
      assert.deepStrictEqual(yield* h.texts(h.workshop.id, paired!), yield* h.texts(h.workshop.id, h.w))
    })
  )

  it.effect("the dialog offers then and now, lists what then leaves out, and each choice does what it says", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const preview = yield* h.reader.PreviewForkNotes({
        userId: h.userId,
        chatId: h.story.id,
        fromForkId: h.main,
        atSlotId: h.s1.slotId
      })
      const [row] = preview.workshops
      assert.strictEqual(row?.workshop, h.workshop.id)
      assert.strictEqual(row!.leftOut.count, 2)
      assert.deepStrictEqual(
        row!.leftOut.first.map((m) => m.line),
        ["W2: the bandits feel sudden.", "W3: turning back ends the arc."]
      )
      const then = yield* h.branchStory(h.s1.slotId, { [h.workshop.id]: "then" })
      const now = yield* h.branchStory(h.s1.slotId, { [h.workshop.id]: "now" })
      const [onThen] = yield* h.pairedIn(h.workshop, then.fork)
      const [onNow] = yield* h.pairedIn(h.workshop, now.fork)
      assert.lengthOf(yield* h.texts(h.workshop.id, onThen!), 1)
      assert.lengthOf(yield* h.texts(h.workshop.id, onNow!), 3)
      // A message copied with "As it is now" recorded the original branch past the fork point: a
      // run continuing it on the new branch reads the new branch's end, not a message it doesn't show.
      const copied = yield* h.reader.GetPath({
        userId: h.userId,
        chatId: h.workshop.id,
        forkId: onNow!,
        leafSlotId: null,
        limit: 50
      })
      const last = copied.entries.at(-1)!
      const atNow = yield* h.reader.WorkshopStoryPosition({
        userId: h.userId,
        chatId: h.workshop.id,
        forkId: onNow!,
        versionId: last.version.id
      })
      assert.strictEqual(atNow?.forkId, now.fork)
      assert.strictEqual(atNow?.leafSlotId, h.s1.slotId)
      // On A the same message keeps the position it recorded.
      const atA = yield* h.reader.WorkshopStoryPosition({
        userId: h.userId,
        chatId: h.workshop.id,
        forkId: h.w,
        versionId: last.version.id
      })
      assert.strictEqual(atA?.leafSlotId, h.s3.slotId)
      // At the story's end nothing is left out: no row.
      const atEnd = yield* h.reader.PreviewForkNotes({
        userId: h.userId,
        chatId: h.story.id,
        fromForkId: h.main,
        atSlotId: h.s3.slotId
      })
      assert.lengthOf(atEnd.workshops, 0)
      // A workshop that changed while the dialog was open: the server asks to review again.
      const stale = yield* h.reader.PreviewForkNotes({
        userId: h.userId,
        chatId: h.story.id,
        fromForkId: h.main,
        atSlotId: h.s2.slotId
      })
      yield* h.append(h.workshop.id, h.w, "W6: said while the dialog was open.")
      assert.strictEqual(
        yield* outcome(
          h.api.CreateFork({
            chatId: h.story.id,
            fromForkId: h.main,
            atSlotId: h.s2.slotId,
            notes: { comparison: canonicalJson(stale), choices: [] }
          })
        ),
        "ForkNotesChanged"
      )
    })
  )

  it.effect("a sibling story branch doesn't list a workshop started on another", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const b = yield* h.branchStory(h.s2.slotId)
      const onlyB = yield* h.api.CreateWorkshop({ attachTo: h.story.id, attachFork: b.fork })
      const besideA = yield* h.api.ListAttachedWorkshops({ chatId: h.story.id, forkId: h.main })
      const besideB = yield* h.api.ListAttachedWorkshops({ chatId: h.story.id, forkId: b.fork })
      assert.deepStrictEqual(
        besideA.map((c) => c.id),
        [h.workshop.id]
      )
      assert.sameMembers(
        besideB.map((c) => c.id),
        [h.workshop.id, onlyB.id]
      )
      // A third branch made from A later: the workshop started on B isn't part of it.
      const c = yield* h.branchStory(h.s1.slotId)
      assert.notInclude(
        (yield* h.api.ListAttachedWorkshops({ chatId: h.story.id, forkId: c.fork })).map((chat) => chat.id),
        onlyB.id
      )
    })
  )

  it.effect("opened in its own pane or the center, a workshop branch still reads its paired story branch", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const b = yield* h.branchStory(h.s1.slotId)
      const [onB] = yield* h.pairedIn(h.workshop, b.fork)
      yield* h.append(h.story.id, b.fork, "On B, the caravan pushes through.")
      // No browser position anywhere: the server places each reply by the pairing.
      const atB = yield* h.reader.WorkshopStoryPosition({ userId: h.userId, chatId: h.workshop.id, forkId: onB! })
      assert.strictEqual(atB?.forkId, b.fork)
      const bPath = yield* h.reader.GetPath({
        userId: h.userId,
        chatId: h.story.id,
        forkId: b.fork,
        leafSlotId: null,
        limit: 50
      })
      assert.strictEqual(atB?.leafSlotId, bPath.entries.at(-1)!.slotId)
      const atA = yield* h.reader.WorkshopStoryPosition({ userId: h.userId, chatId: h.workshop.id, forkId: null })
      assert.strictEqual(atA?.forkId, h.main)
      assert.strictEqual(atA?.leafSlotId, h.s3.slotId)
      // Each message records where its story branch stood when it was written.
      const said = yield* h.append(h.workshop.id, onB!, "W on B, after the push.")
      const recorded = yield* h.reader.WorkshopStoryPosition({
        userId: h.userId,
        chatId: h.workshop.id,
        forkId: onB!,
        versionId: said.version.id
      })
      assert.strictEqual(recorded?.leafSlotId, bPath.entries.at(-1)!.slotId)
      // The header link names the pairing on any device.
      const branches = yield* h.api.ListWorkshopBranches({ chatId: h.workshop.id })
      assert.strictEqual(branches.find((x) => x.forkId === onB)?.story?.forkId, b.fork)
    })
  )

  it.effect("the bin takes a story branch's workshop branches with it, and gives them back", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const b = yield* h.branchStory(h.s1.slotId)
      const [onB] = yield* h.pairedIn(h.workshop, b.fork)
      // A workshop started on B has no other branch: it goes whole.
      const onlyB = yield* h.api.CreateWorkshop({ attachTo: h.story.id, attachFork: b.fork })
      const before = (yield* h.api.ListBin({ limit: 100, before: null })).length
      const item = yield* h.api.DeleteFork({ forkId: b.fork })
      assert.deepStrictEqual(yield* h.pairedIn(h.workshop, b.fork), [])
      assert.strictEqual(yield* outcome(h.api.GetChat({ chatId: onlyB.id })), "NotFound")
      // One item listed: the story branch. Its workshop branches go with it, unlisted.
      const listed = yield* h.api.ListBin({ limit: 100, before: null })
      assert.strictEqual(listed.length, before + 1)
      yield* h.api.RestoreBinItem({ itemId: item.id })
      assert.deepStrictEqual(yield* h.pairedIn(h.workshop, b.fork), [onB!])
      assert.strictEqual((yield* h.api.GetChat({ chatId: onlyB.id })).id, onlyB.id)
      assert.strictEqual((yield* h.api.ListBin({ limit: 100, before: null })).length, before)
      // Deleted for good: so are they.
      const again = yield* h.api.DeleteFork({ forkId: b.fork })
      yield* h.api.PurgeBinItem({ itemId: again.id })
      assert.deepStrictEqual(yield* h.pairedIn(h.workshop, b.fork), [])
      assert.strictEqual(yield* outcome(h.api.GetChat({ chatId: onlyB.id })), "NotFound")
      assert.strictEqual((yield* h.api.ListBin({ limit: 100, before: null })).length, before)
      // A's workshop branch is untouched throughout.
      assert.lengthOf(yield* h.texts(h.workshop.id, h.w), 3)
    })
  )

  it.effect("deleting the story bins its workshops; restoring it brings them back", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const item = yield* h.api.DeleteChat({ chatId: h.story.id })
      assert.strictEqual(yield* outcome(h.api.GetChat({ chatId: h.workshop.id })), "NotFound")
      yield* h.api.RestoreBinItem({ itemId: item.id })
      assert.strictEqual((yield* h.api.GetChat({ chatId: h.workshop.id })).id, h.workshop.id)
      assert.lengthOf(yield* h.texts(h.workshop.id, h.w), 3)
    })
  )
})
