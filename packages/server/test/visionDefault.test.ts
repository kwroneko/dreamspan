// An unknown model sees images: a capability is on unless a failure was recorded or the user or
// catalog says no. An OpenAI-compatible connection with a model id nothing knows gets the image
// as an image block, in a workshop and in a story chat. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import sharp from "sharp"

const attachUpload = (name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const base = `http://127.0.0.1:${port}`
    const target = encodeURIComponent(`/files/Attachments/${name}`)
    const uploaded = yield* Effect.promise(() =>
      fetch(`${base}/files/upload?path=${target}&conflict=keep`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const { path } = (yield* Effect.promise(() => uploaded.json())) as { path: string }
    const attached = yield* Effect.promise(() =>
      fetch(`${base}/files/attach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      })
    )
    return (yield* Effect.promise(() => attached.json())) as AttachedFile
  })

const jpeg = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: "#3366cc" } })
    .jpeg()
    .toBuffer()

describe("vision default", () => {
  for (const [kind, known] of [
    ["workshop", false],
    ["story", false],
    ["workshop", true]
  ] as const)
    it.live(
      `${known ? "a model with vision set to yes" : "an unknown model"} gets a .jpg as an image block in a ${kind} chat`,
      () =>
        Effect.gen(function* () {
          const requests: Array<unknown> = []
          const mock = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startMockProvider((r, res) => {
                if (JSON.stringify(r.body).includes("SEE TURN")) requests.push(r.body)
                sse(res, completionChunks(["Seen."], {}))
              })
            ),
            (m) => Effect.promise(() => m.close())
          )
          const api = yield* client()
          yield* generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
            modelKey: "unlisted-vision-guess",
            model: known ? { context: 200000, vision: true } : { context: 200000 }
          })
          const chat =
            kind === "workshop" ? yield* api.CreateWorkshop({ title: "See" }) : yield* api.CreateChat({ title: "See" })
          const picture = yield* attachUpload("photo.jpg", yield* Effect.promise(jpeg))
          const events: Array<ChatEvent> = []
          yield* api.SubscribeChat({ chatId: chat.id }).pipe(
            Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
            Effect.forkScoped
          )
          yield* eventually(() => events.length > 0)
          const sent = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: chat.activeLeafSlotId,
              branch: false,
              content: "SEE TURN",
              images: [{ mediaId: picture.mediaId, altText: "photo.jpg", name: "photo.jpg", path: picture.path }]
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
          assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
          const body = JSON.stringify(requests[0])
          assert.strictEqual(picture.kind, "image")
          assert.include(body, "image_url")
          assert.include(body, "data:image/jpeg;base64,")
          assert.notInclude(body, "can't see images")
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
      120_000
    )
})
