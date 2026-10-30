import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { UserId } from "@rp/shared/domain.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { png, textChunk } from "./formats/support.ts"

const upload = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200)
    return (yield* Effect.promise(() => response.json())) as { mediaId: string }
  })

describe("editing a message's images", () => {
  it.live("amends a user's version with a new image set, keeping the earlier set in its history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const first = yield* upload(png(textChunk("fixture", "first")))
      const second = yield* upload(png(textChunk("fixture", "second")))
      const chat = yield* api.CreateChat({ title: "Amend images" })
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Sketch", images: [first] })
      )
      // Images only: the text stays, and the amend still counts as one.
      const swapped = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "Sketch",
        images: [{ ...second, altText: "second" }],
        expectedRowVersion: entry.version.rowVersion
      })
      assert.strictEqual(swapped.id, entry.version.id, "no other fork shows it: amended in place")
      assert.deepStrictEqual(
        swapped.images?.map((i) => i.mediaId),
        [second.mediaId]
      )
      assert.strictEqual(swapped.rowVersion, entry.version.rowVersion + 1)
      // Text and images together; then text only, which keeps the set.
      const both = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "Sketch, revised",
        images: [],
        expectedRowVersion: swapped.rowVersion
      })
      assert.deepStrictEqual(both.images, [])
      const text = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "Sketch, final",
        expectedRowVersion: both.rowVersion
      })
      assert.deepStrictEqual(text.images, [])
      const history = yield* api.VersionAmendments({ versionId: entry.version.id })
      assert.deepStrictEqual(
        history.map((h) => [h.content, h.images?.map((i) => i.mediaId)]),
        [
          ["Sketch, revised", undefined],
          ["Sketch", [second.mediaId]],
          ["Sketch", [first.mediaId]]
        ]
      )
      // A version another fork shows gets a copy here with the new set; the other fork keeps its own.
      const fork = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: entry.slotId
      })
      const copied = yield* api.AmendVersion({
        versionId: entry.version.id,
        forkId: fork.fork.id,
        content: "Sketch, final",
        images: [first, second],
        expectedRowVersion: text.rowVersion
      })
      assert.notStrictEqual(copied.id, entry.version.id)
      assert.deepStrictEqual(
        copied.images?.map((i) => i.mediaId),
        [first.mediaId, second.mediaId]
      )
      const main = yield* reader.GetSlot({ userId, slotId: entry.slotId, forkId: chat.currentForkId! })
      assert.deepStrictEqual(main.entry.version.images, [])
      const copyHistory = yield* api.VersionAmendments({ versionId: copied.id })
      assert.deepStrictEqual(copyHistory[0]!.images, [])
      // Media the user doesn't have can't be attached by an amend.
      const exit = yield* Effect.exit(
        api.AmendVersion({
          versionId: entry.version.id,
          forkId: chat.currentForkId!,
          content: "Sketch, final",
          images: [{ mediaId: "not-a-media-id" }],
          expectedRowVersion: text.rowVersion
        })
      )
      assert.include(JSON.stringify(exit), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("edits a version into a new one with the editor's image set", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload(png(textChunk("fixture", "edit")))
      const chat = yield* api.CreateChat({ title: "Edit images" })
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "", images: [image] })
      )
      const edited = yield* api.EditVersion({
        slotId: entry.slotId,
        sourceVersionId: entry.version.id,
        content: "Now with words",
        images: [],
        expectedRowVersion: entry.rowVersion
      })
      assert.notStrictEqual(edited.version.id, entry.version.id)
      assert.deepStrictEqual(edited.version.images, [])
      const versions = yield* api.ListVersions({ slotId: entry.slotId })
      assert.deepStrictEqual(
        versions.find((v) => v.id === entry.version.id)?.images?.map((i) => i.mediaId),
        [image.mediaId],
        "the old set stays with the old version"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
