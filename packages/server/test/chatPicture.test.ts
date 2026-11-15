// A chat's own picture (audit item 010; ARCHITECTURE.md §12 "A chat's own picture") and the
// shell's fork families (item 015), at the real boundary. Cross-user probes are in isolation.test.ts.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { cardFamilies } from "../src/db/shellReads.ts"
import { client, outcome, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { png, textChunk } from "./formats/support.ts"

const mediaConfig = testConfig()

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
  it.live("refuses a corrupt image with a valid PNG header before recording it", () =>
    Effect.gen(function* () {
      yield* upload(png().subarray(0, 33), 415)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("rejects oversized, SVG and wrong-type files and retains animated originals", () =>
    Effect.gen(function* () {
      yield* upload(new Uint8Array(16 * 1024 * 1024 + 1), 413)
      yield* upload(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
        415
      )
      yield* upload(new TextEncoder().encode("plain text"), 415)
      // Synthetic two-frame GIF, generated from two pixels; no real media.
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAD/AP8AACwAAAAAAQABAAACAkQBACH5BAABAAAALAAAAAABAAEAAAICRAEAOw==",
        "base64"
      )
      const id = yield* upload(gif)
      const port = yield* serverPort
      const image = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/library/media?id=${id}&width=32`))
      assert.strictEqual(image.status, 200)
      assert.strictEqual(image.headers.get("content-type"), "image/gif")
      assert.deepStrictEqual(Buffer.from(yield* Effect.promise(() => image.arrayBuffer())), gif)
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Animated" })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: id })
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: null })).group.picture, id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("keeps one ownership reference through replace, Undo and the bin, and clears purged split pictures", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const config = mediaConfig
      const first = yield* upload(png(textChunk("fixture", "retained original")))
      assert.strictEqual(yield* upload(png(textChunk("fixture", "retained original"))), first)
      const second = yield* upload(png(textChunk("fixture", "replacement")))
      const chat = yield* api.CreateChat({ title: "Bin picture" })
      const root = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Opening" })
      )
      const branch = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: root.entry.slotId,
        name: "Split"
      })
      yield* api.SetSplitChat({ forkId: branch.fork.id, split: true })
      const splitId = branch.fork.id as unknown as ChatId
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: first })
      yield* api.SetChatPicture({ chatId: splitId, mediaId: second })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: second })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: first })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: null })
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: first })
      const count = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT count(*) AS n FROM media_refs WHERE media_id IN (?, ?)", params: [first, second] }],
        { readOnly: true }
      )
      assert.strictEqual(count[0]![0]!.n, 2, "uploads and repeated changes do not multiply ownership grants")
      const item = yield* api.DeleteChat({ chatId: chat.id })
      assert.strictEqual(
        yield* outcome(api.SetChatPicture({ chatId: chat.id, mediaId: null }), () => "allowed"),
        "NotFound"
      )
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.strictEqual(
        (yield* api.GetSplitChats({ chatId: chat.id, forkId: chat.currentForkId })).group.picture,
        first
      )
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: branch.fork.id })).group.picture, second)
      const branchItem = yield* api.DeleteFork({ forkId: branch.fork.id })
      yield* api.RestoreBinItem({ itemId: branchItem.id })
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: branch.fork.id })).group.picture, second)
      const purged = yield* api.DeleteFork({ forkId: branch.fork.id })
      yield* api.PurgeBinItem({ itemId: purged.id })
      const tombstone = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT cover_media_id FROM forks WHERE id = ?", params: [branch.fork.id] }],
        { readOnly: true }
      )
      assert.isNull(tombstone[0]![0]!.cover_media_id, "an unrestorable branch must not retain a cover reference")
      const deleted = yield* api.DeleteChat({ chatId: chat.id })
      yield* api.PurgeBinItem({ itemId: deleted.id })
      const held = yield* reader.GetMediaFile({ userId: (yield* api.Whoami()).id as UserId, mediaId: first })
      assert.isNotNull(held, "the existing account ownership grant retains uploads for reuse and Undo")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(mediaConfig, Generator.none)))
  )

  for (const timelines of ["together", "separate"] as const)
    it.live(`a ${timelines} merge and edits on another branch keep each chat's picture`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const own = yield* upload(png(textChunk("fixture", "merge destination")))
        const other = yield* upload(png(textChunk("fixture", "merge source")))
        const dest = yield* api.CreateChat({ title: "Destination" })
        const source = yield* api.CreateChat({ title: "Source" })
        const root = yield* posted(
          api.SendMessage({ chatId: dest.id, parentSlotId: null, branch: false, content: "Destination opening" })
        )
        yield* posted(
          api.SendMessage({ chatId: source.id, parentSlotId: null, branch: false, content: "Source opening" })
        )
        yield* api.SetChatPicture({ chatId: dest.id, mediaId: own })
        yield* api.SetChatPicture({ chatId: source.id, mediaId: other })
        const sibling = yield* api.CreateFork({
          chatId: dest.id,
          fromForkId: dest.currentForkId!,
          atSlotId: root.entry.slotId,
          name: "Sibling"
        })
        const request = {
          chatId: dest.id,
          forkId: dest.currentForkId!,
          at: null,
          source: { chatId: source.id, forkId: source.currentForkId! },
          includeLeftOut: true,
          timelines
        }
        const preview = yield* api.PreviewChatMerge(request)
        yield* api.MergeChat({ ...request, title: preview.sourceTitle, framing: null, digest: preview.digest })
        assert.strictEqual((yield* api.GetSplitChats({ chatId: dest.id, forkId: null })).group.picture, own)
        assert.strictEqual((yield* api.GetSplitChats({ chatId: source.id, forkId: null })).group.picture, other)
        assert.strictEqual((yield* api.GetSplitChats({ chatId: dest.id, forkId: sibling.fork.id })).group.picture, own)
        yield* api.SetSplitChat({ forkId: sibling.fork.id, split: true })
        yield* api.SetChatPicture({ chatId: sibling.fork.id as unknown as ChatId, mediaId: other })
        yield* posted(
          api.SendMessage({
            chatId: dest.id,
            forkId: sibling.fork.id,
            parentSlotId: root.entry.slotId,
            branch: false,
            content: "Sibling only"
          })
        )
        assert.strictEqual(
          (yield* api.GetSplitChats({ chatId: dest.id, forkId: dest.currentForkId })).group.picture,
          own
        )
        assert.strictEqual((yield* api.GetSplitChats({ chatId: source.id, forkId: null })).group.picture, other)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
    )

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
      assert.strictEqual(
        yield* outcome(
          api.SetChatPicture({ chatId: chat.id, mediaId: "https://example.invalid/picture.svg" }),
          () => "allowed"
        ),
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
      yield* api.SetSplitChat({ forkId: branch.fork.id, split: false })
      assert.isUndefined((yield* api.GetSplitChats({ chatId: chat.id, forkId: branch.fork.id })).group.picture)
      yield* api.SetSplitChat({ forkId: branch.fork.id, split: true })
      assert.strictEqual((yield* api.GetSplitChats({ chatId: chat.id, forkId: branch.fork.id })).group.picture, split)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a cold library's pending rows carry their own chat's picture and no other", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const own = yield* upload(png(textChunk("fixture", "cold original")))
      const split = yield* upload(png(textChunk("fixture", "cold split")))
      const chat = yield* api.CreateChat({ title: "Cold pictures" })
      const root = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Shared opening" })
      )
      const branch = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: root.entry.slotId,
        name: "Harbor"
      })
      const kept = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: root.entry.slotId,
        name: "Quay"
      })
      yield* api.SetSplitChat({ forkId: branch.fork.id, split: true })
      const groupId = branch.fork.id as unknown as ChatId
      yield* api.SetChatPicture({ chatId: chat.id, mediaId: own })
      yield* api.SetChatPicture({ chatId: groupId, mediaId: split })
      const plain = yield* api.CreateChat({ title: "No picture" })
      yield* posted(api.SendMessage({ chatId: plain.id, parentSlotId: null, branch: false, content: "Alone" }))
      // Another account's chat, with nothing of ours.
      const foreign = (yield* writer.EnsureUser({ handle: "bea", displayName: "Bea" })).id
      yield* writer.CreateChat({
        userId: foreign,
        kind: "rp",
        status: "active",
        title: "Bea's",
        participants: [],
        greeting: null
      })
      // Cold, as a fresh import leaves it: nothing stored, so every row is pending.
      yield* fixtureSql(config.dataDir, [{ sql: "DELETE FROM fork_summaries" }])
      const partial = yield* reader.ShellMaterializePartial({ userId })
      const byFork = new Map(partial.forks.map((f) => [String(f.forkId), f]))
      assert.isTrue(
        partial.forks.every((f) => f.pending === true),
        "the probe reads pending rows"
      )
      assert.strictEqual(byFork.get(String(chat.currentForkId))!.chat.picture, own)
      assert.strictEqual(byFork.get(String(kept.fork.id))!.chat.picture, own, "a branch shows its chat's picture")
      assert.strictEqual(byFork.get(String(branch.fork.id))!.chat.picture, split, "a split chat shows its own")
      assert.isUndefined(byFork.get(String(plain.currentForkId))!.chat.picture)
      const theirs = yield* reader.ShellMaterializePartial({ userId: foreign })
      assert.lengthOf(theirs.forks, 1)
      assert.isUndefined(theirs.forks[0]!.chat.picture)
      // Read in full, the same pictures.
      const full = new Map(
        (yield* reader.ShellLibrary({ userId, recompute: true })).forks.map((f) => [String(f.forkId), f.chat.picture])
      )
      for (const [forkId, row] of byFork) assert.strictEqual(row.chat.picture, full.get(forkId))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
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
      const sibling = yield* api.ForkCard({
        refId: parent.ref.id,
        name: "Mira sibling",
        nickname: "",
        characterVersion: "tree"
      })
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
      assert.strictEqual(before.get(sibling.entityId), parent.entityId)
      yield* api.SetRefArchived({ refId: fork.id, archived: true })
      const archived = yield* api.GetShellCards()
      assert.strictEqual(archived.archived.find((c) => c.card.entityId === fork.entityId)?.family, parent.entityId)
      assert.strictEqual((yield* families()).get(deep.entityId), parent.entityId)
      // The middle card in the bin: its fork and its parent are still one family.
      const middle = yield* writer.DeleteEntity({ userId, entityId: fork.entityId })
      const after = yield* families()
      assert.isFalse(after.has(fork.entityId))
      assert.strictEqual(after.get(deep.entityId), parent.entityId)
      assert.strictEqual(after.get(parent.entityId), parent.entityId)
      yield* api.PurgeBinItem({ itemId: middle.id })
      assert.strictEqual((yield* families()).get(deep.entityId), parent.entityId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
