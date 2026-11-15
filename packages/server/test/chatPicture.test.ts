// A chat's own picture (audit item 010; ARCHITECTURE.md §12 "A chat's own picture") and the
// shell's fork families (item 015), at the real boundary. Cross-user probes are in isolation.test.ts.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { cardFamilies } from "../src/db/shellReads.ts"
import { client, outcome, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { png, textChunk } from "./formats/support.ts"

const upload = (bytes: Uint8Array, expected = 200) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, expected)
    return expected === 200 ? ((yield* Effect.promise(() => response.json())) as { mediaId: string }).mediaId : ""
  })

const chatRows = (api: Effect.Success<ReturnType<typeof client>>) =>
  Effect.map(
    api.GetShellForks({
      entity: null,
      chat: null,
      search: "",
      sort: "recent",
      sections: [{ id: "chats", limit: 100 }]
    }),
    (forks) => new Map(forks.sections[0]!.rows.map((row) => [String(row.chat.id), row.chat.picture ?? null]))
  )

describe("a chat's own picture", () => {
  it.live("is set, replaced and removed, each returning the picture before it, and lists carry it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const first = yield* upload(png(textChunk("fixture", "picture one")))
      const second = yield* upload(png(textChunk("fixture", "picture two")))
      const chat = yield* api.CreateChat({ title: "Pictured" })
      const other = yield* api.CreateChat({ title: "Plain" })
      yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello" }))
      yield* posted(api.SendMessage({ chatId: other.id, parentSlotId: null, branch: false, content: "Hello" }))
      assert.deepStrictEqual(yield* api.SetChatPicture({ chatId: chat.id, mediaId: first }), { previous: null })
      assert.strictEqual((yield* chatRows(api)).get(chat.id), first)
      assert.strictEqual((yield* chatRows(api)).get(other.id), null, "no other chat takes it")
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: null })).group.picture, first)
      assert.isAbove((yield* api.GetChat({ chatId: chat.id })).rowVersion, chat.rowVersion, "open tabs hear of it")
      assert.deepStrictEqual(yield* api.SetChatPicture({ chatId: chat.id, mediaId: second }), { previous: first })
      // Undo is the same write with the picture before.
      assert.deepStrictEqual(yield* api.SetChatPicture({ chatId: chat.id, mediaId: first }), { previous: second })
      assert.deepStrictEqual(yield* api.SetChatPicture({ chatId: chat.id, mediaId: null }), { previous: first })
      assert.strictEqual((yield* chatRows(api)).get(chat.id), null)
      assert.isUndefined((yield* api.GetSplitChats({ chatId: chat.id, forkId: null })).group.picture)
      // What isn't an image the account holds is no picture.
      assert.strictEqual(
        yield* outcome(api.SetChatPicture({ chatId: chat.id, mediaId: "no-such-media" }), () => "allowed"),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(api.SetChatPicture({ chatId: "no-such-chat" as ChatId, mediaId: first }), () => "allowed"),
        "NotFound"
      )
      yield* upload(new TextEncoder().encode("not an image"), 415)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("belongs to the chat on every branch, and a chat split off has its own", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const own = yield* upload(png(textChunk("fixture", "original chat")))
      const split = yield* upload(png(textChunk("fixture", "split chat")))
      const chat = yield* api.CreateChat({ title: "Branching" })
      const root = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Shared opening" })
      )
      const branch = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: root.entry.slotId,
        name: "Harbor"
      })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: own })
      // One chat, two branches: both rows are the chat's, so both show its picture.
      const branches = yield* api.GetShellForks({
        entity: null,
        chat: chat.id,
        search: "",
        sort: "recent",
        sections: [{ id: "all", limit: 100 }]
      })
      assert.deepStrictEqual(
        branches.sections[0]!.rows.map((row) => row.chat.picture),
        [own, own]
      )
      // Split off, the branch is a chat of its own: it starts without a picture and takes its own.
      yield* api.SetSplitChat({ forkId: branch.fork.id, split: true })
      const groupId = branch.fork.id as unknown as ChatId
      assert.strictEqual((yield* chatRows(api)).get(groupId), null)
      assert.deepStrictEqual(yield* api.SetChatPicture({ chatId: groupId, mediaId: split }), { previous: null })
      const rows = yield* chatRows(api)
      assert.strictEqual(rows.get(groupId), split)
      assert.strictEqual(rows.get(chat.id), own, "the chat it left keeps its own")
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: branch.fork.id })).group.picture, split)
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: chat.currentForkId })).group.picture, own)
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: null })
      assert.strictEqual((yield* chatRows(api)).get(groupId), split, "removing one leaves the other")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("fork families in the shell's cards", () => {
  it("names each related card's first card, through members that are gone, and ends at a cycle", () => {
    const family = cardFamilies([
      { id: "b", parent: "a" },
      { id: "c", parent: "b" },
      { id: "d", parent: "a" },
      { id: "y", parent: "x" },
      { id: "p", parent: "q" },
      { id: "q", parent: "p" }
    ])
    assert.deepStrictEqual(
      ["a", "b", "c", "d"].map((id) => family.get(id)),
      ["a", "a", "a", "a"]
    )
    assert.strictEqual(family.get("y"), "x")
    assert.strictEqual(family.get("x"), "x")
    assert.strictEqual(family.get("p"), family.get("q"))
    assert.isFalse(family.has("alone"))
  })

  it.live("each card of a family carries it; a card on its own carries none", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const card = (name: string) =>
        writer.CreateEntity({
          userId,
          kind: "card",
          label: name,
          subtitle: "",
          doc: cardDoc(name, {}),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const parent = yield* card("Mira")
      const alone = yield* card("Solo")
      const fork = yield* api.ForkCard({ refId: parent.ref.id, name: "Mira", nickname: "", characterVersion: "v2" })
      const deep = yield* api.ForkCard({ refId: fork.id, name: "Mira", nickname: "", characterVersion: "v3" })
      const families = () =>
        Effect.map(
          api.GetShellCards(),
          (shell) => new Map(shell.cards.map((c) => [c.card.entityId as EntityId, c.family ?? null]))
        )
      const before = yield* families()
      assert.strictEqual(before.get(parent.entityId), parent.entityId)
      assert.strictEqual(before.get(fork.entityId), parent.entityId)
      assert.strictEqual(before.get(deep.entityId), parent.entityId)
      assert.strictEqual(before.get(alone.entityId), null)
      // The middle card in the bin: its fork and its parent are still one family.
      yield* writer.DeleteEntity({ userId, entityId: fork.entityId })
      const after = yield* families()
      assert.isFalse(after.has(fork.entityId))
      assert.strictEqual(after.get(deep.entityId), parent.entityId)
      assert.strictEqual(after.get(parent.entityId), parent.entityId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
