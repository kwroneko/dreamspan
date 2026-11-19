import { assert, describe, it } from "@effect/vitest"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { client, posted, testConfig, withServer } from "./support/config.ts"

describe("split chat groups", () => {
  it.live("derives nested groups, pins and current branches without changing the graph", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Split fixture" })
      const send = (forkId: ForkId, parentSlotId: import("@dreamspan/shared/chat.ts").SlotId | null, content: string) =>
        posted(api.SendMessage({ chatId: chat.id, forkId, parentSlotId, content, branch: false }))
      const root = yield* send(chat.currentForkId!, null, "Shared opening")
      const original = yield* send(chat.currentForkId!, root.entry.slotId, "Original continuation")
      const middle = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: root.entry.slotId,
        name: "Harbor"
      })
      const own = yield* send(middle.fork.id, root.entry.slotId, "Harbor continuation")
      const descendant = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: middle.fork.id,
        atSlotId: own.entry.slotId,
        name: "Harbor lane"
      })
      const deep = yield* send(descendant.fork.id, own.entry.slotId, "Harbor lane continuation")
      const child = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: descendant.fork.id,
        atSlotId: deep.entry.slotId,
        name: "Lighthouse"
      })
      yield* send(child.fork.id, deep.entry.slotId, "Lighthouse continuation")
      yield* api.PinFork({ forkId: descendant.fork.id, pinned: true })
      yield* api.SetChatPin({ chatId: chat.id, leaf: null, pinned: true })
      const before = yield* api.ListForks({ chatId: chat.id })
      const beforeChat = yield* api.GetChat({ chatId: chat.id })
      yield* api.SetSplitChat({ forkId: middle.fork.id, split: true })
      yield* api.SetSplitChat({ forkId: child.fork.id, split: true })
      assert.deepStrictEqual(yield* api.ListForks({ chatId: chat.id }), before)
      assert.deepStrictEqual(yield* api.GetChat({ chatId: chat.id }), beforeChat)
      const originalGroup = yield* api.GetSplitChats({ chatId: chat.id, forkId: chat.currentForkId! })
      const middleGroup = yield* api.GetSplitChats({ chatId: chat.id, forkId: descendant.fork.id })
      const childGroup = yield* api.GetSplitChats({ chatId: chat.id, forkId: child.fork.id })
      assert.deepStrictEqual(originalGroup.forkIds, [chat.currentForkId!])
      assert.strictEqual(String(originalGroup.children[0]!.id), String(middle.fork.id))
      assert.strictEqual(middleGroup.parent!.id, chat.id)
      assert.strictEqual(String(middleGroup.children[0]!.id), String(child.fork.id))
      assert.strictEqual(middleGroup.group.title, "Harbor")
      assert.sameMembers([...middleGroup.forkIds], [middle.fork.id, descendant.fork.id])
      assert.strictEqual(middleGroup.group.forkId, descendant.fork.id)
      assert.strictEqual(String(childGroup.parent!.id), String(middle.fork.id))
      assert.lengthOf(childGroup.children, 0)
      assert.isFalse(childGroup.canSplit)
      assert.isTrue(middleGroup.canSplit)
      const rows = yield* api.GetShellForks({
        entity: null,
        chat: null,
        search: "",
        sort: "recent",
        sections: [{ id: "chats", limit: 100 }]
      })
      assert.lengthOf(rows.sections[0]!.rows, 3)
      assert.strictEqual(rows.sections[0]!.rows.find((r) => String(r.chat.id) === String(middle.fork.id))!.branches, 2)
      const peers = yield* api.GetShellForks({
        entity: null,
        chat: middle.fork.id as unknown as ChatId,
        search: "",
        sort: "recent",
        sections: [{ id: "pinnedBranches", limit: 100 }]
      })
      assert.deepStrictEqual(
        peers.sections[0]!.rows.map((r) => r.forkId),
        [descendant.fork.id]
      )
      yield* api.SetChatPin({ chatId: middle.fork.id as unknown as ChatId, leaf: null, pinned: true })
      const pinned = yield* api.GetShellForks({
        entity: null,
        chat: null,
        search: "",
        sort: "recent",
        sections: [{ id: "pinned", limit: 100 }]
      })
      assert.sameMembers(
        pinned.sections[0]!.rows.map((r) => r.chat.id),
        [chat.id, middle.fork.id]
      )
      const path = yield* api.ReadPath({
        chatId: chat.id,
        forkId: middle.fork.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      assert.deepStrictEqual(
        path.entries.map((e) => e.version.content),
        ["Shared opening", "Harbor continuation"]
      )
      const step = yield* api.SwitchBranch({
        chatId: chat.id,
        forkId: middle.fork.id,
        slotId: own.entry.slotId,
        index: 0
      })
      assert.strictEqual(step.slotId, original.entry.slotId)
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: step.fork.id })).group.id, chat.id)
      // Undoing only the outer marker re-parents the deeper split without moving any row.
      yield* api.SetSplitChat({ forkId: middle.fork.id, split: false })
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: child.fork.id })).parent!.id, chat.id)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})

const deleteFixture = (api: Effect.Success<ReturnType<typeof client>>) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title: "Delete groups" })
    const send = (forkId: ForkId, parentSlotId: import("@dreamspan/shared/chat.ts").SlotId | null, content: string) =>
      posted(api.SendMessage({ chatId: chat.id, forkId, parentSlotId, branch: false, content }))
    const shared = yield* send(chat.currentForkId!, null, "Shared opening")
    yield* send(chat.currentForkId!, shared.entry.slotId, "Original ending")
    const harbor = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: chat.currentForkId!,
      atSlotId: shared.entry.slotId,
      name: "Harbor"
    })
    const quay = yield* send(harbor.fork.id, shared.entry.slotId, "Shared quay")
    yield* send(harbor.fork.id, quay.entry.slotId, "Harbor ending")
    const market = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: harbor.fork.id,
      atSlotId: quay.entry.slotId,
      name: "Market"
    })
    const approach = yield* send(market.fork.id, quay.entry.slotId, "Shared approach")
    yield* send(market.fork.id, approach.entry.slotId, "Market ending")
    const lighthouse = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: market.fork.id,
      atSlotId: approach.entry.slotId,
      name: "Lighthouse"
    })
    yield* send(lighthouse.fork.id, approach.entry.slotId, "Lighthouse ending")
    const forest = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: chat.currentForkId!,
      atSlotId: shared.entry.slotId,
      name: "Forest"
    })
    yield* send(forest.fork.id, shared.entry.slotId, "Forest ending")
    const detour = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: chat.currentForkId!,
      atSlotId: shared.entry.slotId,
      name: "Detour"
    })
    yield* send(detour.fork.id, shared.entry.slotId, "Detour ending")
    for (const forkId of [harbor.fork.id, lighthouse.fork.id, forest.fork.id])
      yield* api.SetSplitChat({ forkId, split: true })
    return { chat, harbor: harbor.fork.id, market: market.fork.id, lighthouse: lighthouse.fork.id }
  })

describe("delete visible chat groups", () => {
  for (const original of [false, true])
    for (const purge of [false, true]) {
      it.live(
        `${purge ? "purges" : "restores"} only the ${original ? "original" : "split"} group and keeps deeper groups' shared history`,
        () =>
          Effect.gen(function* () {
            const api = yield* client()
            const f = yield* deleteFixture(api)
            const chatId = f.chat.id
            const read = () =>
              Effect.map(
                api.ReadPath({ chatId, forkId: f.lighthouse, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
                (w) => w.entries.map((e) => [e.slotId, e.version.content])
              )
            const before = yield* read()
            const forkId = original ? f.chat.currentForkId! : f.harbor
            const group = yield* api.GetSplitChats({ chatId, forkId })
            assert.lengthOf(group.forkIds, 2)
            const result = yield* api.DeleteChatGroup({ chatId, forkId, expectedForkIds: group.forkIds })
            assert.strictEqual(result.item.kind, "branch")
            assert.sameMembers(result.item.origin.forkIds as Array<string>, [...group.forkIds])
            const live = yield* api.ListForks({ chatId })
            assert.isFalse(live.some((fork) => group.forkIds.includes(fork.id)))
            assert.deepStrictEqual(yield* read(), before)
            const lighthouse = yield* api.GetSplitChats({ chatId, forkId: f.lighthouse })
            assert.strictEqual(String(lighthouse.parent!.id), String(original ? f.harbor : chatId))
            if (original) assert.isNull((yield* api.GetSplitChats({ chatId, forkId: f.harbor })).parent)
            const affected = yield* api.BinItemBranches({ itemIds: [result.item.id] })
            assert.sameMembers(
              affected.map((b) => b.forkId),
              [...group.forkIds]
            )
            if (purge) {
              yield* api.PurgeBinItem({ itemId: result.item.id })
              assert.deepStrictEqual(yield* read(), before)
              assert.strictEqual((yield* api.GetChat({ chatId })).id, chatId)
            } else {
              yield* api.RestoreBinItem({ itemId: result.item.id })
              const restored = yield* api.GetSplitChats({ chatId, forkId })
              assert.sameMembers([...restored.forkIds], [...group.forkIds])
              assert.strictEqual(
                String((yield* api.GetSplitChats({ chatId, forkId: f.lighthouse })).parent!.id),
                String(f.harbor)
              )
              assert.deepStrictEqual(yield* read(), before)
            }
          }).pipe(Effect.scoped, withServer(testConfig()))
      )
    }

  it.live("rejects a changed confirmation and independently restores groups after the last group is deleted", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const f = yield* deleteFixture(api)
      const stale = yield* api.GetSplitChats({ chatId: f.chat.id, forkId: f.harbor })
      const newBranch = yield* api.CreateFork({
        chatId: f.chat.id,
        fromForkId: f.harbor,
        atSlotId: null,
        name: "New branch"
      })
      const refused = yield* Effect.flip(
        api.DeleteChatGroup({ chatId: f.chat.id, forkId: f.harbor, expectedForkIds: stale.forkIds })
      )
      assert.strictEqual(refused._tag, "BinChanged")
      assert.isTrue((yield* api.ListForks({ chatId: f.chat.id })).some((b) => b.id === newBranch.fork.id))
      const before = (yield* api.ListForks({ chatId: f.chat.id })).map((b) => b.id)
      const rows = (yield* api.GetShellForks({
        entity: null,
        chat: null,
        search: "",
        sort: "recent",
        sections: [{ id: "chats", limit: 100 }]
      })).sections[0]!.rows
      const items: Array<string> = []
      for (const row of rows) {
        const forkId = row.forkId as ForkId
        const group = yield* api.GetSplitChats({ chatId: f.chat.id, forkId })
        const deleted = yield* api.DeleteChatGroup({ chatId: f.chat.id, forkId, expectedForkIds: group.forkIds })
        items.push(deleted.item.id)
      }
      assert.lengthOf(
        (yield* api.GetShellForks({
          entity: null,
          chat: null,
          search: "",
          sort: "recent",
          sections: [{ id: "chats", limit: 100 }]
        })).sections[0]!.rows,
        0
      )
      yield* api.RestoreBinItem({ itemId: items[0]! })
      assert.isNotNull((yield* api.GetSplitChats({ chatId: f.chat.id, forkId: null })).group)
      for (const itemId of items.slice(1).reverse()) yield* api.RestoreBinItem({ itemId })
      assert.sameMembers(
        (yield* api.ListForks({ chatId: f.chat.id })).map((b) => b.id),
        before
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})

it.live("the legacy physical-chat delete also preserves split groups", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const f = yield* deleteFixture(api)
    const before = yield* api.ReadPath({
      chatId: f.chat.id,
      forkId: f.lighthouse,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 100
    })
    const deleted = yield* api.DeleteChat({ chatId: f.chat.id })
    assert.strictEqual(deleted.kind, "branch")
    assert.strictEqual(deleted.origin.groupId, f.chat.id)
    assert.isNull((yield* api.GetSplitChats({ chatId: f.chat.id, forkId: f.harbor })).parent)
    assert.deepStrictEqual(
      (yield* api.ReadPath({
        chatId: f.chat.id,
        forkId: f.lighthouse,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })).entries.map((e) => e.version.content),
      before.entries.map((e) => e.version.content)
    )
    yield* api.RestoreBinItem({ itemId: deleted.id })
    assert.strictEqual((yield* api.GetSplitChats({ chatId: f.chat.id, forkId: f.harbor })).parent!.id, f.chat.id)
  }).pipe(Effect.scoped, withServer(testConfig()))
)
