// Branches over a real server (DESIGN §3.2): each path entry says how many alternates its
// position has and which one it is, and SwitchBranch moves the chat's leaf to the tip of
// another, leaving every composer where it was. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { client, outcome, posted, testConfig, typeInto, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const send = (api: Api, chatId: ChatId, parentSlotId: SlotId | null, content: string, branch = false) =>
  Effect.map(posted(api.SendMessage({ chatId, parentSlotId, branch, content })), (sent) => sent.entry.slotId)

const path = (api: Api, chatId: ChatId) =>
  Effect.map(
    api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
    (window) => window.entries
  )

const shape = (entries: ReadonlyArray<PathEntry>) =>
  entries.map((e) => `${e.version.content}:${e.branchIndex + 1}/${e.branchCount}`)

describe("branches", () => {
  it.live("counts the alternates at each position, and switching moves the leaf to a branch's tip", () =>
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

      // To the oldest: its tip, on its newest replies.
      const first = yield* api.SwitchBranch({ chatId: chat.id, slotId: b2, index: 0 })
      assert.strictEqual(first.slotId, m1)
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "m1:1/3", "m2:1/1"])
      const second = yield* api.SwitchBranch({ chatId: chat.id, slotId: m1, index: 1 })
      assert.strictEqual(second.slotId, b1)
      assert.strictEqual(second.chat.activeLeafSlotId, b1)
      assert.isAbove(second.chat.rowVersion, first.chat.rowVersion)
      // A send continues the branch switched to, without saying it's a branch.
      yield* send(api, chat.id, b1, "b1a")
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
      yield* api.DeleteBranch({ slotId: b1 })
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "b2:2/2"])
      // Switching to the deleted message's branch shows its reply.
      const switched = yield* api.SwitchBranch({ chatId: chat.id, slotId: b2, index: 0 })
      assert.strictEqual(switched.chat.activeLeafSlotId, m2)
      assert.deepStrictEqual(shape(yield* path(api, chat.id)), ["m0:1/1", "m2:1/1"])
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
      assert.strictEqual(switched.chat.activeLeafSlotId, r0)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("leaves each branch's composer where it was", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Drafts" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      const b1 = yield* send(api, chat.id, m0, "b1", true)
      yield* typeInto(api, chat.id, b1, "on b1")
      yield* api.SwitchBranch({ chatId: chat.id, slotId: b1, index: 0 })
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, tipSlotId: b1 })).content, "on b1")
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, tipSlotId: m1 })).content, "")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
