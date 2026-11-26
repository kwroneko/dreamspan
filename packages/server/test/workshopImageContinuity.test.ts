import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { MessageImages } from "@dreamspan/shared/chat.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { png, textChunk } from "./formats/support.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

for (const imageLimit of [1, 2])
  it.live(`image limit ${imageLimit}: retains the recent screenshots within the provider limit`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Done."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: mock.url },
        model: { vision: true, maxImages: imageLimit },
        preset: { openai_max_context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const port = yield* serverPort
      const upload = (bytes: ReturnType<typeof png>) =>
        Effect.gen(function* () {
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
      const firstBytes = png(textChunk("fixture", "first"))
      const secondBytes = png(textChunk("fixture", "second"))
      const firstImage = yield* upload(firstBytes)
      const secondImage = yield* upload(secondBytes)
      const send = (content: string, images?: MessageImages) =>
        Effect.gen(function* () {
          const current = yield* api.GetChat({ chatId: chat.id })
          const user = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: current.activeLeafSlotId,
              branch: false,
              content,
              ...(images ? { images } : {})
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
          assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
          return reply.entry.version.id
        })
      yield* send("First screenshot.", [firstImage])
      const second = yield* send("New screenshot.", [secondImage])
      const run = yield* api.GetRunContext({ versionId: second })
      assert.isUndefined(run.continuity)
      const request = JSON.stringify(mock.requests().at(-1)!.body)
      assert.include(request, "New screenshot.")
      assert.include(request, Buffer.from(secondBytes).toString("base64"))
      if (imageLimit === 1) assert.notInclude(request, Buffer.from(firstBytes).toString("base64"))
      else assert.include(request, Buffer.from(firstBytes).toString("base64"))
      const third = yield* send("Keep working without another image.")
      assert.isUndefined((yield* api.GetRunContext({ versionId: third })).continuity)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
