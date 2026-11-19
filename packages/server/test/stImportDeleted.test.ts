// Synthetic ST folders through HTTP; deletion, paths and composers through the same RPCs
// the client uses. No owner data or main-thread SQLite.
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig, typeInto } from "./support/config.ts"
import { stFolder } from "./support/stFolder.ts"
import { importStFolder, sendStFile } from "./support/stUpload.ts"
import { deleteBranchBelow } from "./support/forkIds.ts"

type Api = Effect.Success<ReturnType<typeof client>>
const read = (api: Api, chatId: ChatId) =>
  api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
const texts = (window: Effect.Success<ReturnType<typeof read>>) => window.entries.map((e) => e.version.content)
const folder = (tag: string, count: number) =>
  new Map([
    ["characters/Alice.png", stFolder().get("characters/Alice.png")!],
    [
      `chats/Alice/${tag}.jsonl`,
      new TextEncoder().encode(
        [
          { chat_metadata: {} },
          ...Array.from({ length: count }, (_, i) => ({
            name: i % 2 ? "Sam" : "Alice",
            is_user: i % 2 === 1,
            mes: `${tag} ${i}`,
            send_date: 1_730_000_000_000 + i
          }))
        ]
          .map((line) => JSON.stringify(line))
          .join("\n")
      )
    ]
  ])

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("ST deleted messages", (it) => {
  for (const position of [0, 1, 2]) {
    for (const purge of [false, true]) {
      it.effect(`continues after a ${purge ? "purged" : "binned"} message at position ${position}`, () =>
        Effect.gen(function* () {
          const tag = `deleted-${position}-${purge}`
          const first = yield* importStFolder(folder(tag, 3))
          const { api } = first
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
          const original = yield* read(api, chat.id)
          const gone = original.entries[position]!
          const item = yield* api.DeleteMessage({ slotId: gone.slotId })
          if (purge) yield* api.PurgeBinItem({ itemId: item.id })
          const afterDelete = yield* api.GetChat({ chatId: chat.id })
          const draft = yield* typeInto(api, chat.id, null, "Saved while ST continues")
          // Unchanged files must neither resurrect the deletion nor move the leaf/composer.
          const unchanged = yield* importStFolder(folder(tag, 3), { partBytes: 160 })
          assert.strictEqual(unchanged.answers.get(`chats/Alice/${tag}.jsonl`)!.outcome, "unchanged")
          assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, afterDelete.activeLeafSlotId)
          const added = yield* importStFolder(folder(tag, 5), { partBytes: 160 })
          assert.strictEqual(added.answers.get(`chats/Alice/${tag}.jsonl`)!.outcome, "updated")
          const user = yield* api.Whoami()
          const record = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.find(
            (r) => r.source === `chats/Alice/${tag}.jsonl`
          )!
          const visible = yield* read(api, chat.id)
          assert.deepStrictEqual(
            texts(visible),
            [0, 1, 2, 3, 4].filter((i) => i !== position).map((i) => `${tag} ${i}`)
          )
          const moved = yield* api.GetChat({ chatId: chat.id })
          assert.strictEqual(moved.activeLeafSlotId, visible.entries.at(-1)!.slotId)
          const composer = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
          assert.strictEqual(composer.id, draft.id)
          assert.strictEqual(composer.content, draft.content)
          // The deleted slot is still a placeholder on this path, not a replacement sibling.
          assert.strictEqual(record.end, moved.activeLeafSlotId)
          assert.strictEqual(visible.entries.find((e) => e.depth === position + 1)!.parentSlotId, gone.slotId)
          assert.isTrue(visible.entries.every((e) => e.branchCount === 1))
          for (const entry of original.entries.filter((e) => e.slotId !== gone.slotId)) {
            assert.strictEqual(visible.entries.find((e) => e.depth === entry.depth)!.slotId, entry.slotId)
          }
          const repeated = yield* importStFolder(folder(tag, 5))
          assert.strictEqual(repeated.answers.get(`chats/Alice/${tag}.jsonl`)!.outcome, "unchanged")
          assert.deepStrictEqual(yield* read(api, chat.id), visible)
          if (!purge) {
            assert.isTrue((yield* api.ListBin({ limit: 100, before: null })).some((b) => b.id === item.id))
            yield* api.RestoreBinItem({ itemId: item.id })
            const restored = yield* read(api, chat.id)
            assert.deepStrictEqual(
              texts(restored),
              [0, 1, 2, 3, 4].map((i) => `${tag} ${i}`)
            )
            assert.strictEqual(restored.entries[position]!.slotId, gone.slotId)
          }
          const sent = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: moved.activeLeafSlotId,
              branch: false,
              content: "Continue here"
            })
          )
          assert.strictEqual(sent.chat.activeLeafSlotId, sent.entry.slotId)
        })
      )
    }
  }

  for (const position of [0, 1]) {
    for (const purge of [false, true]) {
      it.effect(`keeps a ${purge ? "purged" : "binned"} whole subtree at position ${position} hidden`, () =>
        Effect.gen(function* () {
          const tag = `subtree-${position}-${purge}`
          const { api } = yield* importStFolder(folder(tag, 3))
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
          const original = yield* read(api, chat.id)
          const item = yield* deleteBranchBelow(api, chat.id, position === 0 ? null : original.entries[0]!.slotId)
          if (purge) yield* api.PurgeBinItem({ itemId: item.id })
          const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
          const draft = yield* typeInto(api, chat.id, null, "Outside deleted subtree")
          const unchanged = yield* importStFolder(folder(tag, 3), { partBytes: 160 })
          assert.strictEqual(unchanged.answers.get(`chats/Alice/${tag}.jsonl`)!.outcome, "skipped")
          yield* importStFolder(folder(tag, 5), { partBytes: 160 })
          yield* importStFolder(folder(tag, 6), { partBytes: 160 })
          assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, leaf)
          assert.deepStrictEqual(texts(yield* read(api, chat.id)), position === 0 ? [] : [`${tag} 0`])
          assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: null })).id, draft.id)
          // A new local branch must not offer the deleted subtree as an alternate.
          const sent = yield* posted(
            api.SendMessage({ chatId: chat.id, parentSlotId: leaf, branch: false, content: "Outside" })
          )
          assert.strictEqual(sent.entry.branchCount, 1)
        })
      )
    }
  }

  it.effect("walks a chain of individually deleted messages even when the leaf became empty", () =>
    Effect.gen(function* () {
      const tag = "all-deleted"
      const { api } = yield* importStFolder(folder(tag, 3))
      const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
      const original = yield* read(api, chat.id)
      for (const entry of original.entries) yield* api.DeleteMessage({ slotId: entry.slotId })
      assert.isNull((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId)
      const draft = yield* typeInto(api, chat.id, null, "Empty leaf draft")
      yield* importStFolder(folder(tag, 5), { partBytes: 160 })
      const visible = yield* read(api, chat.id)
      assert.deepStrictEqual(texts(visible), [`${tag} 3`, `${tag} 4`])
      assert.strictEqual(visible.entries[0]!.parentSlotId, original.entries[2]!.slotId)
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: null })).id, draft.id)
    })
  )

  for (const branch of [false, true]) {
    it.effect(`resuming an unfinished import respects a deleted ${branch ? "subtree" : "last message"}`, () =>
      Effect.gen(function* () {
        const tag = `unfinished-${branch}`
        const files = folder(tag, 3)
        const path = `chats/Alice/${tag}.jsonl`
        const { api, importId } = yield* importStFolder(
          new Map([["characters/Alice.png", files.get("characters/Alice.png")!]])
        )
        assert.strictEqual((yield* sendStFile(importId, path, files.get(path)!, { last: "0" })).outcome, "continue")
        const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title.startsWith(tag))!
        const original = yield* read(api, chat.id)
        if (branch) yield* deleteBranchBelow(api, chat.id, null)
        else yield* api.DeleteMessage({ slotId: original.entries[2]!.slotId })
        const draft = yield* typeInto(api, chat.id, null, "Unfinished import draft")
        yield* importStFolder(folder(tag, 5), { partBytes: 160 })
        const visible = yield* read(api, chat.id)
        assert.deepStrictEqual(texts(visible), branch ? [] : [0, 1, 3, 4].map((i) => `${tag} ${i}`))
        assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: null })).id, draft.id)
      })
    )
  }

  it.effect("keeps a continuation already written here and its composer active", () =>
    Effect.gen(function* () {
      const tag = "local-continuation"
      const { api } = yield* importStFolder(folder(tag, 3))
      const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
      yield* api.DeleteMessage({ slotId: chat.activeLeafSlotId! })
      const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: leaf, branch: false, content: "Local continuation" })
      )
      const draft = yield* typeInto(api, chat.id, null, "Local draft")
      yield* importStFolder(folder(tag, 4))
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, sent.entry.slotId)
      assert.deepStrictEqual(texts(yield* read(api, chat.id)), [`${tag} 0`, `${tag} 1`, "Local continuation"])
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: null })).id, draft.id)
    })
  )
})
