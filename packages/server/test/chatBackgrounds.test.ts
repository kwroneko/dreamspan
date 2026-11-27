import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import type { ChatBackgroundEntry } from "@dreamspan/shared/chatBackgrounds.ts"
import { Effect, Stream } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { FILES_ROUTES } from "@dreamspan/shared/files.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider, type Handler } from "./support/mockProvider.ts"
import sharp from "sharp"
import { mediaPath } from "../src/db/media.ts"
import { client, posted, serverPort, testConfig, withServer } from "./support/config.ts"

const gallery = "/api/chat-backgrounds"
const media = (id: string) => `/api/media/chat-backgrounds/${id}`
const request = (path: string, user: string | null, init?: RequestInit) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { ...(user === null ? {} : { "Remote-User": user }), ...init?.headers }
      })
    )
  )

const image = (format: "png" | "jpeg" | "webp", background: string) =>
  Effect.promise(() =>
    sharp({ create: { width: 32, height: 24, channels: 3, background } })
      .toFormat(format)
      .toBuffer()
  )

const upload = (path: string, bytes: Uint8Array<ArrayBuffer> | string, user = "alice") =>
  request(path, user, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes
  })

const scopedGallery = (chatId?: ChatId, id?: string, name?: string) => {
  const params = new URLSearchParams()
  if (chatId !== undefined) params.set("chatId", chatId)
  if (name !== undefined) params.set("name", name)
  return `${gallery}${id ? "/" + id : ""}?${params}`
}
const add = Effect.fnUntraced(function* (
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
  user = "alice",
  chatId?: ChatId
) {
  const response = yield* upload(scopedGallery(chatId, undefined, name), bytes, user)
  assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
  return ((yield* Effect.promise(() => response.json())) as { mediaId: string }).mediaId
})

const list = Effect.fnUntraced(function* (user: string, chatId?: ChatId) {
  const response = yield* request(scopedGallery(chatId), user)
  assert.strictEqual(response.status, 200)
  return (yield* Effect.promise(() => response.json())) as ChatBackgroundEntry[]
})

it.live("validates uploads, keeps a private gallery and applies atomic background patches", () => {
  const config = testConfig({ authMode: "proxy" })
  return Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const phone = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const first = yield* alice.CreateChat({ title: "First synthetic chat" })
    const second = yield* alice.CreateChat({ title: "Second synthetic chat" })
    const png = yield* image("png", "#fefefe")
    const pngId = yield* add(png, "Snow.png")
    assert.strictEqual(yield* add(png, "Duplicate.png"), pngId)
    const jpegId = yield* add(yield* image("jpeg", "#777777"), "Stone.jpg")
    const webpId = yield* add(yield* image("webp", "#222222"), "Night.webp")
    assert.deepEqual(
      (yield* list("alice")).map(({ name }) => name),
      ["Night.webp", "Stone.jpg", "Snow.png"]
    )
    assert.isEmpty(yield* list("bob"))
    for (const [id, type] of [
      [pngId, "png"],
      [jpegId, "jpeg"],
      [webpId, "webp"]
    ]) {
      const response = yield* request(media(id!), "alice")
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), `image/${type}`)
      assert.include(response.headers.get("cache-control"), "no-store")
      yield* Effect.promise(() => response.arrayBuffer())
    }
    for (const bytes of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "not an image", png.subarray(0, 20)])
      assert.equal((yield* upload(gallery, bytes)).status, 415)
    assert.equal((yield* upload(gallery, new Uint8Array(16 * 1024 * 1024 + 1))).status, 413)
    assert.equal((yield* request(gallery, null)).status, 401)
    assert.equal((yield* request(media(pngId), null)).status, 401)
    assert.equal((yield* request(`${gallery}/${pngId}`, null, { method: "DELETE" })).status, 401)
    assert.equal((yield* request(media(pngId), "bob")).status, 404)
    assert.equal((yield* request(`${gallery}/${pngId}`, "bob", { method: "DELETE" })).status, 404)
    assert.equal(
      (yield* request(`${gallery}/${pngId}`, "alice", {
        method: "DELETE",
        headers: { origin: "https://example.com" }
      })).status,
      403
    )

    const denied = yield* Effect.flip(bob.SetDisplayPrefs({ prefs: { chatBackground: { mediaId: pngId } } }))
    assert.equal(denied._tag, "NotFound")
    const foreign = yield* Effect.flip(bob.SetDisplayPrefs({ prefs: { chatBackgrounds: { [first.id]: null } } }))
    assert.equal(foreign._tag, "NotFound")
    yield* alice.SetDisplayPrefs({
      prefs: {
        chatBackground: { mediaId: pngId, opacity: 17, blur: 25, fit: "contain" },
        chatBackgrounds: { [first.id]: null }
      }
    })
    yield* phone.SetDisplayPrefs({
      prefs: { chatBackgrounds: { [second.id]: pngId }, chatBackground: { fit: "tile" } }
    })
    const low = yield* alice.GetDisplayPrefs({})
    assert.deepEqual(low.chatBackground, { mediaId: pngId, opacity: 50, blur: 16, fit: "tile" })
    assert.deepEqual(low.chatBackgrounds, { [first.id]: null, [second.id]: pngId })
    yield* alice.SetDisplayPrefs({
      prefs: { inheritChatBackground: first.id, chatBackground: { opacity: 150, blur: -4 } }
    })
    const high = yield* phone.GetDisplayPrefs({})
    assert.deepEqual(high.chatBackground, { mediaId: pngId, opacity: 100, blur: 0, fit: "tile" })
    assert.deepEqual(high.chatBackgrounds, { [second.id]: pngId })

    assert.equal((yield* request(`${gallery}/${pngId}`, "alice", { method: "DELETE" })).status, 204)
    assert.notInclude(
      (yield* list("alice")).map(({ mediaId }) => mediaId),
      pngId
    )
    const cleared = yield* alice.GetDisplayPrefs({})
    assert.isNull(cleared.chatBackground.mediaId)
    assert.deepEqual(cleared.chatBackgrounds, {})
    const path = join(config.dataDir, mediaPath(createHash("sha256").update(png).digest("hex")))
    assert.isFalse(
      yield* Effect.promise(() =>
        stat(path).then(
          () => true,
          () => false
        )
      )
    )
  }).pipe(Effect.scoped, withServer(config))
})

it.live("keeps a shared message, card portrait and a second account's gallery image", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const png = yield* image("png", "#d8ab74")
    const jpeg = yield* image("jpeg", "#9c5861")
    // The gallery acquired this reference before the ordinary message upload.
    const messageId = yield* add(png, "Message.png")
    const uploadResponse = yield* upload("/chat/image", png)
    assert.equal(uploadResponse.status, 200)
    assert.deepEqual(yield* Effect.promise(() => uploadResponse.json()), { mediaId: messageId })
    const chat = yield* alice.CreateChat({ title: "Shared synthetic message" })
    const sent = yield* posted(
      alice.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "",
        images: [{ mediaId: messageId }]
      })
    )
    assert.equal(sent.entry.version.images?.[0]?.mediaId, messageId)

    // Reversed order for a portrait already held when it was added to the gallery.
    const card = yield* alice.CreateCard({ label: "Synthetic portrait", name: "Synthetic portrait" })
    const portrait = yield* upload(`/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion}`, jpeg)
    assert.equal(portrait.status, 200)
    const cardId = (yield* alice.OpenEditor({ refId: card.id })).doc.avatar_media_id
    assert.equal(yield* add(jpeg, "Portrait.jpg"), cardId)
    assert.equal(yield* add(jpeg, "Same image.jpg", "bob"), cardId)

    for (const id of [messageId, String(cardId)]) {
      assert.equal((yield* request(`${gallery}/${id}`, "alice", { method: "DELETE" })).status, 204)
      assert.equal((yield* request(media(id), "alice")).status, 404)
      assert.equal((yield* request(`/library/media?id=${id}`, "alice")).status, 200)
    }
    assert.equal((yield* request(media(String(cardId)), "bob")).status, 200)
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("keeps workshop selection and scoped galleries separate, and releases their media", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const userId = (yield* alice.Whoami()).id
    const writer = yield* Writer
    const reader = yield* Reader
    const first = yield* alice.CreateChat({ title: "Rain" })
    const second = yield* alice.CreateChat({ title: "Snow" })
    const bytes = yield* image("png", "#45a390")
    const main = yield* add(bytes, "Main")
    const local = yield* add(yield* image("png", "#626993"), "Rain", "alice", first.id)

    assert.equal((yield* alice.GetDisplayPrefs({})).workshopBackground, "inherit")
    yield* alice.SetDisplayPrefs({ prefs: { chatBackground: { mediaId: main }, workshopBackground: null } })
    assert.isNull((yield* alice.GetDisplayPrefs({})).workshopBackground)
    yield* alice.SetDisplayPrefs({ prefs: { workshopBackground: main } })
    assert.equal((yield* alice.GetDisplayPrefs({})).workshopBackground, main)
    assert.equal((yield* Effect.flip(alice.SetDisplayPrefs({ prefs: { workshopBackground: local } })))._tag, "NotFound")

    assert.deepEqual(
      (yield* list("alice", first.id)).map((item) => item.mediaId),
      [local]
    )
    assert.isEmpty(yield* list("alice", second.id))
    assert.deepEqual(
      (yield* list("alice")).map((item) => item.mediaId),
      [main]
    )
    assert.equal((yield* request(scopedGallery(first.id), "bob")).status, 404)
    assert.equal((yield* upload(scopedGallery(first.id), bytes, "bob")).status, 404)
    assert.equal((yield* request(scopedGallery(first.id, local), "bob", { method: "DELETE" })).status, 404)
    assert.equal((yield* request(media(local), "bob")).status, 404)
    assert.equal((yield* request(media(local), "alice")).status, 200)
    assert.equal((yield* request(`/library/media?id=${local}`, "alice")).status, 404)
    assert.equal(
      (yield* Effect.flip(bob.SetDisplayPrefs({ prefs: { chatBackgrounds: { [first.id]: local } } })))._tag,
      "NotFound"
    )
    assert.equal(
      (yield* Effect.flip(alice.SetDisplayPrefs({ prefs: { chatBackgrounds: { [second.id]: local } } })))._tag,
      "NotFound"
    )
    yield* alice.SetDisplayPrefs({ prefs: { chatBackgrounds: { [first.id]: local } } })
    assert.equal((yield* alice.GetDisplayPrefs({})).chatBackgrounds[first.id], local)
    assert.equal((yield* request(scopedGallery(first.id, local), "alice", { method: "DELETE" })).status, 204)
    assert.notProperty((yield* alice.GetDisplayPrefs({})).chatBackgrounds, first.id)
    assert.equal((yield* request(media(local), "alice")).status, 404)

    // Two galleries can hold the same bytes. A global deletion must keep a local selection.
    assert.equal(yield* add(bytes, "Local copy", "alice", first.id), main)
    yield* alice.SetDisplayPrefs({ prefs: { chatBackgrounds: { [first.id]: main } } })
    assert.equal((yield* request(scopedGallery(undefined, main), "alice", { method: "DELETE" })).status, 204)
    const prefs = yield* alice.GetDisplayPrefs({})
    assert.isNull(prefs.chatBackground.mediaId)
    assert.equal(prefs.workshopBackground, "inherit")
    assert.equal(prefs.chatBackgrounds[first.id], main)
    assert.equal((yield* request(media(main), "alice")).status, 200)

    const item = yield* writer.DeleteChat({ userId, chatId: first.id })
    assert.equal((yield* request(media(main), "alice")).status, 200)
    yield* writer.PurgeBinItem({ userId, itemId: item.id })
    assert.notProperty((yield* alice.GetDisplayPrefs({})).chatBackgrounds, first.id)
    assert.isFalse(yield* reader.IsMediaRecorded({ sha256: createHash("sha256").update(bytes).digest("hex") }))
    assert.equal((yield* request(media(main), "alice")).status, 404)
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

const model = (handle: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handle)),
    (mock) => Effect.promise(() => mock.close())
  )

const toolCall = (name: string, args: unknown, id: string) =>
  [null, "tool_calls"].map((finish) => ({
    id: "cmpl-background",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        delta: finish
          ? {}
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) }
                }
              ]
            }
      }
    ]
  }))

it.live("sets causal scene backgrounds from both galleries and follows version and fork selections", () =>
  Effect.gen(function* () {
    let choice = "Rain"
    const mock = yield* model((request, res) => {
      const messages = (request.body?.messages ?? []) as Array<{ role: string }>
      sse(
        res,
        messages.some((message) => message.role === "tool")
          ? completionChunks(["The lantern is lit."], {})
          : toolCall("set_chat_background", { background: choice }, "scene")
      )
    })
    const api = yield* client({ "Remote-User": "alice" })
    const userId = (yield* api.Whoami()).id
    const writer = yield* Writer
    const reader = yield* Reader
    const global = yield* add(yield* image("png", "#8c469e"), "Garden")
    let local = ""
    const rp = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      state: [
        { key: "agent.enabled", value: { on: true } },
        { key: "output.contract", value: "final_text" },
        { key: "agent.tools", value: { tools: ["set_chat_background"] } }
      ],
      before: (chat) =>
        Effect.gen(function* () {
          const bytes = yield* image("png", "#548fa2")
          local = (yield* writer.RecordChatBackground({
            userId,
            chatId: chat.id,
            name: "Rain",
            media: {
              sha256: createHash("sha256").update(bytes).digest("hex"),
              byteSize: bytes.byteLength,
              mime: "image/png",
              width: 32,
              height: 24
            }
          }))!
        })
    })
    const chatId = rp.chat.id
    const original = rp.chat.currentForkId
    const scene = (forkId = original, slotId = rp.version.slotId) =>
      api.GetCast({ chatId, forkId, slotId }).pipe(Effect.map((cast) => cast.background))
    assert.deepEqual(yield* scene(), { mode: "image", mediaId: local, name: "Rain" })
    assert.isTrue(rp.events.some((event) => event._tag === "State"))
    const early = yield* api.CreateFork({ chatId, fromForkId: original, atSlotId: rp.sent.slotId })
    const late = yield* api.CreateFork({ chatId, fromForkId: original, atSlotId: rp.version.slotId })
    assert.isUndefined(yield* scene(early.fork.id, rp.sent.slotId))
    assert.deepEqual(yield* scene(late.fork.id), { mode: "image", mediaId: local, name: "Rain" })

    const replacement = yield* writer.AddVersion({
      userId,
      slotId: rp.version.slotId,
      forkId: original,
      select: true,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: rp.version.speakerEntityId,
        writer: "model",
        content: "The road continues.",
        status: "complete",
        macroMode: "verbatim",
        origin: "generated"
      })
    })
    assert.isUndefined(yield* scene())
    assert.deepEqual(yield* scene(late.fork.id), { mode: "image", mediaId: local, name: "Rain" })
    yield* api.SelectVersion({
      slotId: rp.version.slotId,
      forkId: original,
      versionId: rp.version.id,
      expectedVersionId: replacement.id
    })
    assert.deepEqual(yield* scene(), { mode: "image", mediaId: local, name: "Rain" })
    const material = yield* reader.RolloutMaterial({ userId, versionId: rp.version.id })
    const replay = yield* writer.ApplyRolloutEffect({
      userId,
      rolloutId: material.rolloutId,
      toolCallId: "scene",
      events: [{ key: "chat.background", value: { mode: "solid" } }],
      result: "A changed attempt"
    })
    assert.isTrue(replay.replayed)
    assert.deepEqual(yield* scene(), { mode: "image", mediaId: local, name: "Rain" })

    for (const [background, value] of [
      ["Garden", { mode: "image", mediaId: global, name: "Garden" }],
      ["solid", { mode: "solid" }],
      ["default", { mode: "default" }]
    ] as const) {
      choice = background
      const path = yield* api.ReadPath({
        chatId,
        forkId: original,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 5
      })
      const shown = path.entries.at(-1)!
      const swipe = yield* api.Regenerate({
        slotId: shown.slotId,
        forkId: original,
        expectedRowVersion: shown.rowVersion
      })
      yield* eventually(() => finished(rp.events, swipe.version.id) !== undefined)
      assert.deepEqual(yield* scene(), value)
    }
    assert.deepEqual(
      (yield* list("alice")).map(({ mediaId }) => mediaId),
      [global]
    )
    assert.deepEqual(
      (yield* list("alice", chatId)).map(({ mediaId }) => mediaId),
      [local]
    )
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("loads the workshop background tool on demand, validates imports and undoes settings and media", () =>
  Effect.gen(function* () {
    const calls = [
      { background: "Existing", opacity: 70, blur: 4, fit: "contain" },
      { scope: "workshop", background: "solid" },
      { scope: "chat", file: "/files/grove.png", name: "Grove" },
      { scope: "workshop", file: "/files/study.png", name: "Study" },
      { scope: "chat", file: "/files/invalid.png" },
      { file: "/files/../study.png" }
    ]
    const mock = yield* model((request, res) => {
      const messages = (request.body?.messages ?? []) as Array<{ role: string }>
      const lastUser = messages.findLastIndex((message) => message.role === "user")
      const answered = messages.slice(Math.max(0, lastUser)).filter((message) => message.role === "tool").length
      const offered = (request.body?.tools ?? []) as Array<{ function: { name: string } }>
      if (!offered.some((entry) => entry.function.name === "load_skill"))
        return sse(res, completionChunks(["Hello."], {}))
      if (answered === 0) return sse(res, toolCall("load_skill", { name: "chat-setup" }, "background-skill"))
      if (answered <= calls.length)
        return sse(
          res,
          toolCall("call_tool", { name: "set_background", arguments: calls[answered - 1] }, `background-${answered}`)
        )
      sse(res, completionChunks(["The room is ready."], {}))
    })
    const api = yield* client({ "Remote-User": "alice" })
    const reader = yield* Reader
    const { id: userId } = yield* api.Whoami()
    const existing = yield* add(yield* image("png", "#a56632"), "Existing")
    const rp = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "dispatcher" } },
      model: {}
    })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: rp.connection.id, model: rp.model.id }, preset: null }
    })
    const workshop = yield* api.CreateWorkshop({ title: "Background setup" })
    for (const [file, body] of [
      ["grove.png", yield* image("png", "#59a198")],
      ["study.png", yield* image("png", "#abb999")],
      ["invalid.png", "<svg xmlns='http://www.w3.org/2000/svg'/>"]
    ] as const) {
      const path = new URLSearchParams({ path: `/files/${file}`, conflict: "replace" })
      const response = yield* upload(`${FILES_ROUTES.upload}?${path}`, body)
      assert.equal(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    }
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const sent = yield* posted(
      api.SendMessage({
        chatId: workshop.id,
        parentSlotId: workshop.activeLeafSlotId,
        branch: false,
        content: "Set my backgrounds."
      })
    )
    const reply = yield* posted(api.Generate({ chatId: workshop.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
    const effects = yield* api.ListRolloutEffects({ chatId: workshop.id })
    assert.lengthOf(effects, 4)
    assert.isTrue(effects.every((entry) => entry.kind === "setup.background"))
    const transcript = yield* reader.RolloutMaterial({ userId, versionId: reply.entry.version.id })
    for (const [id, phrase] of [
      ["background-5", "PNG, JPEG, GIF or WebP image"],
      ["background-6", "parent-directory segments"]
    ]) {
      const receipt = yield* reader.RolloutToolReceipt({ userId, rolloutId: transcript.rolloutId, toolCallId: id! })
      assert.isTrue(receipt?.isError)
      assert.include(receipt?.text, phrase!)
    }
    const selected = yield* api.GetDisplayPrefs({})
    assert.deepEqual(selected.chatBackground, { mediaId: existing, opacity: 70, blur: 4, fit: "contain" })
    const [local] = yield* list("alice", workshop.id)
    const [added, original] = yield* list("alice")
    assert.equal(local?.name, "Grove")
    assert.equal(added?.name, "Study")
    assert.equal(original?.mediaId, existing)
    assert.equal(selected.chatBackgrounds[workshop.id], local?.mediaId)
    assert.equal(selected.workshopBackground, added?.mediaId)

    const undo = (toolCallId: string) => api.UndoRolloutEffect({ rolloutId: transcript.rolloutId, toolCallId, seq: 0 })
    yield* undo("background-4")
    assert.isNull((yield* api.GetDisplayPrefs({})).workshopBackground)
    assert.deepEqual(
      (yield* list("alice")).map(({ mediaId }) => mediaId),
      [existing]
    )
    assert.equal((yield* request(media(added!.mediaId), "alice")).status, 404)
    yield* undo("background-3")
    assert.notProperty((yield* api.GetDisplayPrefs({})).chatBackgrounds, workshop.id)
    assert.isEmpty(yield* list("alice", workshop.id))
    assert.equal((yield* request(media(local!.mediaId), "alice")).status, 404)
    yield* undo("background-2")
    assert.equal((yield* api.GetDisplayPrefs({})).workshopBackground, "inherit")
    yield* api.SetDisplayPrefs({ prefs: { chatWidth: 840 } })
    yield* undo("background-1")
    const restored = yield* api.GetDisplayPrefs({})
    assert.deepEqual(restored.chatBackground, { mediaId: null, opacity: 85, blur: 0, fit: "cover" })
    assert.equal(restored.chatWidth, 840)
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
