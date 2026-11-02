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
          ["Sketch, revised", []],
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
      const keptDraft = yield* api.SaveMessageDraft({
        target: { _tag: "Edit", versionId: entry.version.id },
        draftId: null,
        content: "Keep the source images",
        images: [image],
        expectedRowVersion: null,
        expectedSession: null
      })
      yield* api.EditVersion({
        slotId: entry.slotId,
        sourceVersionId: entry.version.id,
        content: "Keep the source images",
        expectedRowVersion: edited.rowVersion,
        draft: { draftId: keptDraft.id, session: keptDraft.session }
      })
      assert.lengthOf(
        yield* api.MessageDrafts({ chatId: chat.id }),
        0,
        "default source images count when ending the draft"
      )
      const versions = yield* api.ListVersions({ slotId: entry.slotId })
      assert.deepStrictEqual(
        versions.find((v) => v.id === entry.version.id)?.images?.map((i) => i.mediaId),
        [image.mediaId],
        "the old set stays with the old version"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
  it.live("restores every amendment's full image set, including text-only states and fork copies", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id as UserId
      const first = yield* upload(png(textChunk("fixture", "restore first")))
      const second = yield* upload(png(textChunk("fixture", "restore second")))
      const chat = yield* api.CreateChat({ title: "Restore images" })
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "First", images: [first] })
      )
      const textOnly = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "Second",
        expectedRowVersion: entry.version.rowVersion
      })
      const imageOnly = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "Second",
        images: [second],
        expectedRowVersion: textOnly.rowVersion
      })
      const states = yield* api.VersionAmendments({ versionId: entry.version.id })
      assert.deepStrictEqual(
        states.map((state) => state.images?.map((image) => image.mediaId)),
        [[first.mediaId], [first.mediaId]]
      )
      const restored = yield* api.RestoreVersionAmendment({
        versionId: entry.version.id,
        amendmentId: states[1]!.id,
        forkId: chat.currentForkId!,
        expectedRowVersion: imageOnly.rowVersion
      })
      assert.strictEqual(restored.content, "First")
      assert.deepStrictEqual(
        restored.images?.map((image) => image.mediaId),
        [first.mediaId]
      )
      const undone = (yield* api.VersionAmendments({ versionId: entry.version.id }))[0]!
      const fork = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: entry.slotId
      })
      const copy = yield* api.RestoreVersionAmendment({
        versionId: entry.version.id,
        forkId: fork.fork.id,
        amendmentId: undone.id,
        expectedRowVersion: restored.rowVersion
      })
      assert.notStrictEqual(copy.id, entry.version.id)
      assert.strictEqual(copy.content, "Second")
      assert.deepStrictEqual(
        copy.images?.map((image) => image.mediaId),
        [second.mediaId]
      )
      assert.deepStrictEqual(
        (yield* reader.GetSlot({
          userId,
          slotId: entry.slotId,
          forkId: chat.currentForkId!
        })).entry.version.images?.map((image) => image.mediaId),
        [first.mediaId]
      )
      // A text-only fork copy must also snapshot its full set before a later image change.
      const copiedText = yield* api.AmendVersion({
        versionId: copy.id,
        forkId: fork.fork.id,
        content: "Third",
        expectedRowVersion: copy.rowVersion
      })
      yield* api.AmendVersion({
        versionId: copiedText.id,
        forkId: fork.fork.id,
        content: "Third",
        images: [],
        expectedRowVersion: copiedText.rowVersion
      })
      const copyStates = yield* api.VersionAmendments({ versionId: copy.id })
      assert.deepStrictEqual(
        copyStates[1]!.images?.map((image) => image.mediaId),
        [second.mediaId]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("keeps editor images in server drafts and history, and a stale device cannot commit newer images", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const first = yield* upload(png(textChunk("fixture", "draft first")))
      const second = yield* upload(png(textChunk("fixture", "draft second")))
      const chat = yield* api.CreateChat({ title: "Image draft" })
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "", images: [first] })
      )
      const target = { _tag: "Edit" as const, versionId: entry.version.id }
      const initial = yield* api.SaveMessageDraft({
        target,
        draftId: null,
        content: "",
        images: [first],
        expectedRowVersion: null,
        expectedSession: null
      })
      const changed = yield* api.SaveMessageDraft({
        target,
        draftId: initial.id,
        content: "",
        images: [second],
        expectedRowVersion: initial.rowVersion,
        expectedSession: initial.session
      })
      assert.deepStrictEqual(
        (yield* api.MessageDrafts({ chatId: chat.id }))[0]!.images?.map((i) => i.mediaId),
        [second.mediaId],
        "an image-only edit reopens on another device"
      )
      const stale = yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "",
        images: [first],
        expectedRowVersion: entry.version.rowVersion,
        draft: { draftId: initial.id, session: initial.session }
      })
      assert.lengthOf(
        yield* api.MessageDrafts({ chatId: chat.id }),
        1,
        "the stale commit must not end the newer image draft"
      )
      const history = yield* api.MessageDraftHistory({ target, limit: 10 })
      // The oldest state is the version as it was, with its own images (owner, 2026-11-02:
      // an edit's first state is the text it was typed on); the one after it is the first save.
      assert.strictEqual(history.at(-1)!.kind, "initial")
      const restored = yield* api.RestoreMessageDraft({
        target,
        draftId: changed.id,
        seq: history.at(-2)!.seq,
        expectedRowVersion: changed.rowVersion
      })
      assert.deepStrictEqual(
        restored.images?.map((i) => i.mediaId),
        [first.mediaId]
      )
      const removed = yield* api.SaveMessageDraft({
        target,
        draftId: restored.id,
        content: "",
        images: [],
        expectedRowVersion: restored.rowVersion,
        expectedSession: restored.session
      })
      const displaced = yield* api.SaveMessageDraft({
        target,
        draftId: changed.id,
        content: "",
        images: [second],
        expectedRowVersion: changed.rowVersion,
        expectedSession: changed.session
      })
      assert.deepStrictEqual(displaced.displaced?.images, [], "image-only conflicts keep the other device's set")
      // Both ownership and browser-copy replay are handled by the same worker save.
      const invalid = yield* Effect.exit(
        api.SaveMessageDraft({
          target,
          draftId: removed.id,
          content: "",
          images: [{ mediaId: "missing" }],
          expectedRowVersion: removed.rowVersion,
          expectedSession: removed.session
        })
      )
      assert.include(JSON.stringify(invalid), "NotFound")
      yield* api.AmendVersion({
        versionId: entry.version.id,
        content: "",
        images: [second],
        expectedRowVersion: stale.rowVersion,
        draft: { draftId: displaced.id, session: displaced.session }
      })
      assert.lengthOf(yield* api.MessageDrafts({ chatId: chat.id }), 0, "a matching save ends the draft across devices")
      // An editor for a new version has the same persistence and end rules.
      const write = { _tag: "Write" as const, slotId: entry.slotId }
      const writing = yield* api.SaveMessageDraft({
        target: write,
        draftId: null,
        content: "",
        images: [],
        expectedRowVersion: null,
        expectedSession: null
      })
      assert.deepStrictEqual((yield* api.MessageDrafts({ chatId: chat.id }))[0]!.images, [])
      yield* api.DiscardMessageDraft({ target: write, draftId: writing.id, expectedRowVersion: writing.rowVersion })
      assert.lengthOf(yield* api.MessageDrafts({ chatId: chat.id }), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
