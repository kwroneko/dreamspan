// A character card attached as a file in a workshop (spec/WORKSHOP-CARDS.md §4.5) at the HTTP
// and RPC boundary: it's recognised by its bytes when attached (a PNG with card chunks, card
// JSON; a plain PNG or other JSON isn't one), stays a file, and the draft and the message name
// it as a card. The model's `<attachment>` element names the card and holds its fields, with
// the note on the card file tools once per message. Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { cardChunk, json as jsonBytes, png, stCardV2 } from "./formats/support.ts"

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export const attachUpload = (folder: string, name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const uploaded = yield* call(`/files/upload?path=${encodeURIComponent(`${folder}/${name}`)}&conflict=keep`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    })
    assert.strictEqual(uploaded.status, 200, yield* Effect.promise(() => uploaded.clone().text()))
    const { path } = (yield* Effect.promise(() => uploaded.json())) as { path: string }
    const attached = yield* post("/files/attach", { path })
    assert.strictEqual(attached.status, 200, yield* Effect.promise(() => attached.clone().text()))
    return (yield* Effect.promise(() => attached.json())) as AttachedFile
  })

const text = (m: { content?: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))

export const v3Card = (name: string) => ({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: { ...stCardV2().data, name, extensions: { kept: { yes: true } } }
})

describe("card files", () => {
  it.live("are recognised when attached, and the model reads them as cards", () =>
    Effect.gen(function* () {
      const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((r, res) => {
            requests.push(r.body as never)
            sse(res, completionChunks(["Noted."], {}))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000, vision: true }
      })
      assert.strictEqual((yield* post("/files/folder", { path: "/files/cards" })).status, 200)
      const chat = yield* api.CreateWorkshop({ title: "Card files" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "WorkshopFolder", path: "/files/cards" } })

      const folder = "/files/cards/Attachments"
      const wren = yield* attachUpload(folder, "wren.png", png(cardChunk("ccv3", v3Card("Wren Hollow"))))
      const gull = yield* attachUpload(folder, "gull.json", jsonBytes(v3Card("Gull Keeper")))
      const plain = yield* attachUpload(folder, "map.png", png())
      const other = yield* attachUpload(folder, "data.json", jsonBytes({ hello: "world" }))
      assert.deepInclude(wren, { kind: "image", card: { name: "Wren Hollow", format: "png" } })
      assert.deepInclude(gull, { kind: "file", card: { name: "Gull Keeper", format: "json" } })
      assert.isUndefined(plain.card)
      assert.isUndefined(other.card)

      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const key = { chatId: chat.id, draftId: draft.id }
      const asImage = (a: AttachedFile) => ({
        mediaId: a.mediaId,
        altText: a.name,
        ...(a.kind === "file" ? { kind: "file" as const } : {}),
        name: a.name,
        path: a.path
      })
      yield* api.SetComposerImage({ ...key, id: "w", ...asImage(wren) })
      yield* api.SetComposerImage({ ...key, id: "g", ...asImage(gull) })
      const drafted = yield* api.GetComposerImages({ ...key, ids: [] })
      assert.deepStrictEqual(
        drafted.map((d) => d.card?.name),
        ["Wren Hollow", "Gull Keeper"]
      )

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
          content: "Tighten these.",
          images: [asImage(wren), asImage(gull)],
          imageDraftIds: ["w", "g"],
          composer: { draftId: draft.id, session: draft.session }
        })
      )
      assert.deepStrictEqual(
        sent.entry.version.images?.map((i) => i.card),
        [
          { name: "Wren Hollow", format: "png" },
          { name: "Gull Keeper", format: "json" }
        ]
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
      const content = text(requests.at(-1)!.messages.find((m) => text(m).includes("Tighten these."))!)
      assert.include(
        content,
        `path=\\"/attachments/${wren.mediaId}\\" image_block=\\"true\\" card=\\"true\\" card_name=\\"Wren Hollow\\" format=\\"png\\" spec=\\"chara_card_v3\\" spec_version=\\"3.0\\">`
      )
      assert.include(content, `card_name=\\"Gull Keeper\\" format=\\"json\\"`)
      // Whole: its fields are in the element.
      assert.include(content, "A lighthouse keeper.")
      assert.strictEqual(content.split("read_card_file (the same views").length - 1, 1)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
