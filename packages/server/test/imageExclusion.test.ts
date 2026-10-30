import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completeFixture } from "./support/lcmFixtures.ts"
import { png, textChunk } from "./formats/support.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

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

const imageCount = (body: unknown) => JSON.stringify(body).split('"type":"image_url"').length - 1

describe("image exclusion", () => {
  it.live(
    "takes an image out in one fork only, leaves it out of the request and its limit, and says why for each rule",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const reader = yield* Reader
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id as UserId
        const first = yield* upload(png(textChunk("fixture", "first")))
        const second = yield* upload(png(textChunk("fixture", "second")))
        const third = yield* upload(png(textChunk("fixture", "third")))
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Seen."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const generated = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: { vision: true, maxImages: 2 },
          content: "Three drawings",
          images: [first, second, third]
        })
        const { chat } = generated
        const fork = chat.currentForkId!
        const path = yield* reader.GetPath({ userId, chatId: chat.id, leafSlotId: null, limit: 20, forkId: fork })
        const message = path.entries.find((entry) => entry.version.images?.length === 3)!
        const leaf = path.entries.at(-1)!.slotId as SlotId
        const other = yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: fork, atSlotId: leaf })

        // Before: the newest two are sent, the oldest is left out by the limit.
        const before = yield* api.GetNextContext({ chatId: chat.id, forkId: fork, leafSlotId: leaf })
        assert.deepStrictEqual(
          before.images?.images.map((image) => [image.mediaId, image.rule, image.message]),
          [[first.mediaId, "limit", "Only the last 2 images are sent to this model"]]
        )

        const taken = yield* api.SetImageExcluded({
          versionId: message.version.id,
          mediaId: third.mediaId,
          forkId: fork,
          excluded: true
        })
        assert.deepStrictEqual(taken.excludedImages, [third.mediaId])
        // The other fork, made before, keeps every image in its context.
        const elsewhere = yield* reader.GetSlot({ userId, slotId: message.slotId, forkId: other.fork.id })
        assert.isUndefined(elsewhere.entry.excludedImages)

        const after = yield* api.GetNextContext({ chatId: chat.id, forkId: fork, leafSlotId: leaf })
        assert.deepStrictEqual(
          after.images?.images.map((image) => [image.mediaId, image.rule, image.index]),
          [[third.mediaId, "user", 2]],
          "the limit counts only what's sent: the first two now fit"
        )
        const otherNext = yield* api.GetNextContext({ chatId: chat.id, forkId: other.fork.id, leafSlotId: leaf })
        assert.deepStrictEqual(
          otherNext.images?.images.map((image) => [image.mediaId, image.rule]),
          [[first.mediaId, "limit"]]
        )

        // The next reply sends the two kept images, and the inspector says the third was taken out.
        const { entry } = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: leaf, branch: false, forkId: fork })
        )
        yield* eventually(() => finished(generated.events, entry.version.id) !== undefined)
        const bodies = mock.requests().filter((r) => r.path === "/v1/chat/completions")
        const body = JSON.stringify(bodies.at(-1)!.body)
        assert.strictEqual(imageCount(bodies.at(-1)!.body), 2)
        assert.notInclude(body, Buffer.from(png(textChunk("fixture", "third"))).toString("base64"))
        const inspected = yield* api.GetRunContext({ versionId: entry.version.id })
        assert.isTrue(
          (inspected.notSent ?? []).some(
            (source) =>
              source.label.includes("Image 3 of message") && source.label.includes("Taken out of the context by you")
          ),
          JSON.stringify(inspected.notSent)
        )

        // Putting it back; a second write of the same value changes nothing.
        const back = yield* api.SetImageExcluded({
          versionId: message.version.id,
          mediaId: third.mediaId,
          forkId: fork,
          excluded: false
        })
        assert.isUndefined(back.excludedImages)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("names a model without vision and a hidden message", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id as UserId
      const image = yield* upload(png())
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Text."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        modelKey: "text-only",
        model: { vision: false },
        content: "A drawing"
      })
      const { chat } = generated
      const path = yield* reader.GetPath({ userId, chatId: chat.id, leafSlotId: null, limit: 20 })
      const leaf = path.entries.at(-1)!
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: leaf.slotId,
          branch: false,
          content: "",
          images: [image],
          reply: false
        })
      )
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: sent.entry.slotId })
      assert.deepStrictEqual(
        next.images?.images.map((i) => [i.rule, i.message]),
        [["vision", "text-only can't see images"]]
      )
      yield* api.SetMessageHidden({ slotId: sent.entry.slotId, hidden: true })
      const hidden = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: sent.entry.slotId })
      assert.deepStrictEqual(
        hidden.images?.images.map((i) => i.rule),
        ["hidden"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
  it.live("marks images covered by a summary using the actual assembly cursor", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const image = yield* upload(png(textChunk("fixture", "summarized")))
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Summary image reason",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "vision", overrides: { vision: true } })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Summarized image" })
      const { entry } = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "A sketch of a harbor",
          images: [image],
          reply: false
        })
      )
      const { entry: tail } = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: entry.slotId,
          branch: false,
          content: "After the sketch",
          reply: false
        })
      )
      yield* completeFixture(config.dataDir, writer, userId, chat.id, [
        { slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 }
      ])
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: tail.slotId })
      assert.strictEqual(next.summarizedThrough, entry.depth)
      assert.deepStrictEqual(
        next.images?.ranges.find((range) => range.rule === "summary"),
        { from: 0, to: entry.depth, rule: "summary", message: "Covered by a summary" }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
