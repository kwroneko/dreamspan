import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import type { ChatBackgroundEntry } from "@dreamspan/shared/chatBackgrounds.ts"
import { Effect } from "effect"
import sharp from "sharp"
import { mediaPath } from "../src/db/media.ts"
import { client, posted, serverPort, testConfig, withServer } from "./support/config.ts"

const gallery = "/api/chat-backgrounds"
const media = (id: string) => `/api/media/${id}`
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

const add = Effect.fnUntraced(function* (bytes: Uint8Array<ArrayBuffer>, name: string, user = "alice") {
  const response = yield* upload(`${gallery}?name=${encodeURIComponent(name)}`, bytes, user)
  assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
  return ((yield* Effect.promise(() => response.json())) as { mediaId: string }).mediaId
})

const list = Effect.fnUntraced(function* (user: string) {
  const response = yield* request(gallery, user)
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
