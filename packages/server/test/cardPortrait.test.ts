// A card's portrait from an image the workshop agent can read (create_card / edit_card
// `portrait`): set as the card editor's Replace picture sets it (media storage, the default
// cutout's thumbnails), in one undoable change; a bad path or a file that isn't an image is a
// plain tool error that creates and changes nothing. Synthetic images only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import sharp from "sharp"
import { readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { Reader } from "../src/db/Database.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { unquoteToolData } from "./support/toolData.ts"

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })
const upload = (folder: string, name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const uploaded = yield* call(`/files/upload?path=${encodeURIComponent(`${folder}/${name}`)}&conflict=keep`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    })
    assert.strictEqual(uploaded.status, 200, yield* Effect.promise(() => uploaded.clone().text()))
    return ((yield* Effect.promise(() => uploaded.json())) as { path: string }).path
  })
const attach = (path: string) =>
  Effect.gen(function* () {
    const attached = yield* call("/files/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path })
    })
    assert.strictEqual(attached.status, 200, yield* Effect.promise(() => attached.clone().text()))
    return (yield* Effect.promise(() => attached.json())) as AttachedFile
  })

const picture = (format: "jpeg" | "png", color: string) =>
  sharp({ create: { width: 80, height: 120, channels: 3, background: color } })
    [format]()
    .toBuffer()

describe("card portraits from an image", () => {
  it.live(
    "are set by create_card from an attachment and by edit_card from a file, each undoable; bad paths are tool errors",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let steps: Array<[string, unknown]> = []
        const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const b = r.body as unknown as { messages: Array<{ role: string; content?: string }> }
              if (!JSON.stringify(b.messages).includes("PORTRAIT TASK"))
                return sse(res, completionChunks(["Ready."], {}))
              requests.push(b)
              const done = b.messages.filter((m) => m.role === "tool").length
              const step = steps[done]
              if (!step) return sse(res, completionChunks(["Done."], {}))
              sse(res, toolCall(step[0], step[1], `portrait_${done}`))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000, vision: true }
        })
        assert.strictEqual(
          (yield* call("/files/folder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/files/cards" })
          })).status,
          200
        )
        const chat = yield* api.CreateWorkshop({ title: "Card portraits" })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "WorkshopFolder", path: "/files/cards" }
        })
        const jpeg = yield* attach(
          yield* upload("/files/cards", "attached.jpg", yield* Effect.promise(() => picture("jpeg", "#3366aa")))
        )
        yield* upload("/files/cards", "second.png", yield* Effect.promise(() => picture("png", "#aa6633")))
        yield* upload("/files/cards", "notes.txt", new TextEncoder().encode("Not a picture."))
        steps = [
          [
            "create_card",
            { name: "Portrait Probe", description: "A probe.", portrait: `/attachments/${jpeg.mediaId}` }
          ],
          ["create_card", { name: "Missing Picture", portrait: "/files/cards/nowhere.png" }],
          ["create_card", { name: "Text Picture", portrait: "/files/cards/notes.txt" }],
          ["edit_card", { card: "Portrait Probe", portrait: "/files/cards/second.png" }],
          ["edit_card", { card: "Portrait Probe", portrait: "/files/cards/notes.txt" }],
          ["edit_card", { card: "Portrait Probe" }]
        ]
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
            content: "PORTRAIT TASK: make a card with this picture."
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        const id = reply.entry.version.id
        yield* eventually(() => finished(events, id) !== undefined, 120_000)
        assert.strictEqual(finished(events, id)!.status, "complete")
        const results = requests
          .at(-1)!
          .messages.filter((m) => m.role === "tool")
          .map((m) => unquoteToolData(m.content ?? ""))
        assert.include(results[0], '"entityId"')
        assert.include(results[1], "no such file")
        assert.include(results[2], "isn't a PNG, JPEG, GIF or WebP image")
        assert.include(results[3], '"revision"')
        assert.include(results[4], "isn't a PNG, JPEG, GIF or WebP image")
        assert.include(results[5], "Give changes, a portrait, or both")

        // Failed calls created nothing; the probe is the only card.
        const cards = yield* api.ListLibrary({ kind: "card" })
        assert.isFalse(cards.some((c) => c.label === "Missing Picture" || c.label === "Text Picture"))
        assert.lengthOf(
          cards.filter((c) => c.label === "Portrait Probe"),
          1
        )
        const refId = cards.find((c) => c.label === "Portrait Probe")!.id
        const me = yield* api.Whoami()
        const reader = yield* Reader
        const shown = (mediaId: string | null) =>
          Effect.gen(function* () {
            assert.isString(mediaId)
            const file = yield* reader.GetMediaFile({ userId: me.id as UserId, mediaId: mediaId! })
            // The API the client shows it through serves it, and its thumbnails are stored.
            const served = yield* call(`/library/media?id=${encodeURIComponent(mediaId!)}&w=96`)
            assert.strictEqual(served.status, 200)
            const thumbs = (yield* Effect.promise(() => readdir(join(config.dataDir, dirname(file.path))))).filter(
              (name) => name.startsWith(`${basename(file.path)}.thumb-v1-`)
            )
            assert.isAtLeast(thumbs.length, 3)
            return file.mime
          })
        const now = yield* api.OpenEditor({ refId })
        assert.strictEqual(yield* shown(now.doc.avatar_media_id as string), "image/png")
        assert.strictEqual(now.doc.description, "A probe.")

        // Both are changes in the workshop's list, each one undo.
        const effects = yield* api.ListVersionEffects({ versionId: id })
        const created = effects.find((e) => e.kind === "library.create")!
        const edited = effects.find((e) => e.kind === "library.revise")!
        assert.isDefined(created)
        assert.isDefined(edited)
        yield* api.UndoRolloutEffect({ rolloutId: edited.rolloutId, toolCallId: edited.toolCallId, seq: edited.seq })
        const undone = yield* api.OpenEditor({ refId })
        assert.strictEqual(yield* shown(undone.doc.avatar_media_id as string), "image/jpeg")
        assert.notStrictEqual(undone.doc.avatar_media_id, now.doc.avatar_media_id)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )
})
