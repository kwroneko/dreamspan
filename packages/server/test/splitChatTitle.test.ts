import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, posted, testConfig, withServer } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const fixture = (api: Effect.Success<ReturnType<typeof client>>) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title: "A synthetic story" })
    const first = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, content: "Opening", branch: false })
    )
    const { fork } = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: chat.currentForkId!,
      atSlotId: first.entry.slotId
    })
    yield* posted(
      api.SendMessage({
        chatId: chat.id,
        forkId: fork.id,
        parentSlotId: first.entry.slotId,
        content: "Branch",
        branch: false
      })
    )
    return { chat, fork }
  })

describe("split confirmation title", () => {
  it.live("sets the full chat title and undoes it, allowing messages added since confirmation", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, fork } = yield* fixture(api)
      const current = (yield* api.ListForks({ chatId: chat.id })).find((f) => f.id === fork.id)!
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          forkId: fork.id,
          parentSlotId: current.tipSlotId,
          content: "New reply",
          branch: false
        })
      )
      const name = "A long story title ".repeat(9).trim()
      yield* api.SetSplitChat({ forkId: fork.id, split: true, title: { name: `  ${name}  `, expectedName: null } })
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id })).group.title, name)
      const duplicate = yield* Effect.flip(
        api.SetSplitChat({ forkId: fork.id, split: true, title: { name, expectedName: name } })
      )
      assert.strictEqual(duplicate._tag, "EditRefused")
      yield* api.SetSplitChat({ forkId: fork.id, split: false, title: { name: "", expectedName: name } })
      assert.isNull((yield* api.ListForks({ chatId: chat.id })).find((f) => f.id === fork.id)!.name)
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id })).group.id, chat.id)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("rejects stale names for confirmation and Undo without changing either title or grouping", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, fork } = yield* fixture(api)
      yield* api.NameFork({ forkId: fork.id, name: "Other tab" })
      const stale = yield* Effect.flip(
        api.SetSplitChat({ forkId: fork.id, split: true, title: { name: "Old form", expectedName: null } })
      )
      assert.strictEqual(stale._tag, "EditRefused")
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id })).group.id, chat.id)
      yield* api.SetSplitChat({
        forkId: fork.id,
        split: true,
        title: { name: "Split title", expectedName: "Other tab" }
      })
      yield* api.NameFork({ forkId: fork.id, name: "Later edit" })
      const undo = yield* Effect.flip(
        api.SetSplitChat({ forkId: fork.id, split: false, title: { name: "Other tab", expectedName: "Split title" } })
      )
      assert.strictEqual(undo._tag, "EditRefused")
      const state = yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id })
      assert.strictEqual(state.group.rootForkId, fork.id)
      assert.strictEqual(state.group.title, "Later edit")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  for (const split of [true, false])
    it.live(`rolls back the title when ${split ? "splitting" : "Undo"} fails after the name update`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const { chat, fork } = yield* fixture(api)
        if (!split) yield* api.SetSplitChat({ forkId: fork.id, split: true })
        const before = yield* api.ListForks({ chatId: chat.id })
        const group = yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id })
        yield* fixtureSql(config.dataDir, [
          {
            sql: `CREATE TRIGGER refuse_split BEFORE ${split ? "INSERT" : "DELETE"} ON user_settings WHEN ${split ? "NEW" : "OLD"}.key GLOB 'split-chat:*' BEGIN SELECT RAISE(ABORT, 'planted marker failure'); END`
          }
        ])
        const failed = yield* Effect.flip(
          api.SetSplitChat({ forkId: fork.id, split, title: { name: "Must roll back", expectedName: null } })
        )
        assert.strictEqual(failed._tag, "ServerError")
        assert.deepStrictEqual(yield* api.ListForks({ chatId: chat.id }), before)
        assert.deepStrictEqual(yield* api.GetSplitChats({ chatId: chat.id, forkId: fork.id }), group)
      }).pipe(Effect.scoped, withServer(config))
    })
})
