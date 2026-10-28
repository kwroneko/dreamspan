// Branches over a real server (DESIGN §3.2): each path entry says how many alternates its
// position has and which one it is, and SwitchBranch finds the fork to open through
// another, changing no fork and leaving every composer where it was. Cross-user access is in
// the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { client, outcome, posted, testConfig, typeInto, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** A message in fork `forkId` (null: the current one); the fork it went to becomes current. */
const sendIn = (
  api: Api,
  chatId: ChatId,
  forkId: ForkId | null,
  parentSlotId: SlotId | null,
  content: string,
  branch = false
) =>
  Effect.map(posted(api.SendMessage({ chatId, forkId, parentSlotId, branch, content })), (sent) => ({
    slotId: sent.entry.slotId,
    forkId: sent.chat.currentForkId!
  }))

const send = (api: Api, chatId: ChatId, parentSlotId: SlotId | null, content: string, branch = false) =>
  Effect.map(sendIn(api, chatId, null, parentSlotId, content, branch), (sent) => sent.slotId)

/** A fork's path (null: the current fork's). */
const path = (api: Api, chatId: ChatId, forkId: ForkId | null = null) =>
  Effect.map(
    api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
    (window) => window.entries
  )

const shape = (entries: ReadonlyArray<PathEntry>) =>
  entries.map((e) => `${e.version.content}:${e.branchIndex + 1}/${e.branchCount}`)

/** The fork whose tip is `slotId`. */
const forkWithTip = (api: Api, chatId: ChatId, slotId: SlotId) =>
  Effect.map(api.ListForks({ chatId }), (forks) => forks.find((fork) => fork.tipSlotId === slotId)!.id)

describe("branches", () => {
  for (const purge of [false, true]) {
    it.live(
      `does not follow a ${purge ? "purged" : "deleted"} subtree when an older individual deletion inside it is restored`,
      () =>
        Effect.gen(function* () {
          const api = yield* client()
          const chat = yield* api.CreateChat({ title: "Subtree boundary" })
          const root = yield* send(api, chat.id, null, "root")
          const a = yield* send(api, chat.id, root, "subtree")
          const b = yield* send(api, chat.id, a, "older deletion")
          const inner = yield* api.DeleteMessage({ slotId: b })
          const other = yield* send(api, chat.id, root, "other", true)
          const subtree = yield* api.DeleteFork({ forkId: yield* forkWithTip(api, chat.id, a) })
          if (purge) yield* api.PurgeBinItem({ itemId: subtree.id })
          yield* api.RestoreBinItem({ itemId: inner.id })
          assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["root:1/1", "other:1/1"])
          assert.strictEqual(
            (yield* api.SwitchBranch({ chatId: chat.id, slotId: other, index: 0 })).fork.tipSlotId,
            other
          )
        }).pipe(Effect.scoped, withServer(testConfig()))
    )
  }

  for (const change of ["restore", "delete message"] as const) {
    it.live(`opens the fork an alternate is on after a ${change} there`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Structural changes" })
        const root = yield* send(api, chat.id, null, "root")
        const a = yield* send(api, chat.id, root, "a")
        const child = yield* send(api, chat.id, a, "continuation")
        const b = yield* sendIn(api, chat.id, null, root, "other", true)
        const item = change === "restore" ? yield* api.DeleteMessage({ slotId: child }) : null
        if (item) yield* api.RestoreBinItem({ itemId: item.id })
        else yield* api.DeleteMessage({ slotId: child })
        const opened = yield* api.SwitchBranch({ chatId: chat.id, slotId: b.slotId, index: 0, forkId: b.forkId })
        assert.strictEqual(opened.slotId, a)
        assert.strictEqual(opened.fork.tipSlotId, change === "restore" ? child : a)
        // Opening a fork doesn't make it current: only chatting in one or making it does.
        assert.strictEqual(opened.chat.currentForkId, b.forkId)
      }).pipe(Effect.scoped, withServer(testConfig()))
    )
  }

  it.live("counts and follows chains of individually deleted ancestors, including purged placeholders", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Deleted chain" })
      const root = yield* send(api, chat.id, null, "root")
      const a = yield* send(api, chat.id, root, "a")
      const b = yield* send(api, chat.id, a, "b")
      const c = yield* send(api, chat.id, b, "survivor")
      const other = yield* send(api, chat.id, root, "other", true)
      const deleted = yield* api.DeleteMessage({ slotId: a })
      yield* api.DeleteMessage({ slotId: b })
      for (const purged of [false, true]) {
        if (purged) yield* api.PurgeBinItem({ itemId: deleted.id })
        const back = yield* api.SwitchBranch({ chatId: chat.id, slotId: other, index: 1 })
        assert.deepStrictEqual(shape(yield* path(api, chat.id, back.fork.id)), ["root:1/1", "other:2/2"])
        const switched = yield* api.SwitchBranch({ chatId: chat.id, slotId: other, index: 0 })
        assert.strictEqual(switched.fork.tipSlotId, c)
        const around = yield* api.ReadPath({
          chatId: chat.id,
          leafSlotId: other,
          range: { _tag: "Around", slot: c },
          limit: 20
        })
        assert.strictEqual(around.leafSlotId, c)
        assert.strictEqual(around.forkId, switched.fork.id)
      }
      yield* api.DeleteFork({ forkId: yield* forkWithTip(api, chat.id, c) })
      const left = yield* api.SwitchBranch({ chatId: chat.id, slotId: other, index: 0 })
      assert.deepStrictEqual(shape(yield* path(api, chat.id, left.fork.id)), ["root:1/1", "other:1/1"])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("counts the alternates at each position, and switching opens the fork through one at its tip", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Harbor" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      yield* send(api, chat.id, m1, "m2")
      const b1 = yield* send(api, chat.id, m0, "b1", true)
      const b2 = yield* send(api, chat.id, m0, "b2", true)
      yield* send(api, chat.id, b2, "b2a")
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "b2:3/3", "b2a:1/1"])

      // To the oldest: the fork through it, at its tip.
      const first = yield* api.SwitchBranch({ chatId: chat.id, slotId: b2, index: 0 })
      assert.strictEqual(first.slotId, m1)
      assert.deepStrictEqual(shape(yield* path(api, chat.id, first.fork.id)), ["m0:1/1", "m1:1/3", "m2:1/1"])
      const second = yield* api.SwitchBranch({ chatId: chat.id, slotId: m1, index: 1, forkId: first.fork.id })
      assert.strictEqual(second.slotId, b1)
      assert.strictEqual(second.fork.tipSlotId, b1)
      // Nothing moved: the chat still opens where it was last chatted in.
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "b2:3/3", "b2a:1/1"])
      // A send continues the fork switched to, without saying it's a branch, and makes it current.
      yield* sendIn(api, chat.id, second.fork.id, b1, "b1a")
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "b1:2/3", "b1a:1/1"])

      assert.strictEqual(yield* outcome(api.SwitchBranch({ chatId: chat.id, slotId: b1, index: 3 })), "NotFound")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("counts a message deleted on its own as a branch while its replies stay, a deleted branch not", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Chapel" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      const m2 = yield* send(api, chat.id, m1, "m2")
      const b1 = yield* send(api, chat.id, m0, "b1", true)
      const b2 = yield* send(api, chat.id, m0, "b2", true)
      yield* api.DeleteMessage({ slotId: m1 })
      yield* api.DeleteFork({ forkId: yield* forkWithTip(api, chat.id, b1) })
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "b2:2/2"])
      // Switching to the deleted message's branch shows its reply.
      const switched = yield* api.SwitchBranch({ chatId: chat.id, slotId: b2, index: 0 })
      assert.strictEqual(switched.fork.tipSlotId, m2)
      assert.deepStrictEqual(shape(yield* path(api, chat.id, switched.fork.id)), ["m0:1/1", "m2:1/1"])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("counts first messages as alternates of each other", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Roots" })
      const r0 = yield* send(api, chat.id, null, "r0")
      yield* send(api, chat.id, null, "r1", true)
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["r1:2/2"])
      const switched = yield* api.SwitchBranch({ chatId: chat.id, slotId: r0, index: 0 })
      assert.strictEqual(switched.fork.tipSlotId, r0)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("leaves each fork's composer where it was", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Drafts" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* sendIn(api, chat.id, null, m0, "m1")
      const b1 = yield* sendIn(api, chat.id, null, m0, "b1", true)
      yield* typeInto(api, chat.id, b1.forkId, "on b1")
      yield* api.SwitchBranch({ chatId: chat.id, slotId: b1.slotId, index: 0 })
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: b1.forkId })).content, "on b1")
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: m1.forkId })).content, "")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
