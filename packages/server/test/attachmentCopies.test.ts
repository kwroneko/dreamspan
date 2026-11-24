// Workshop attachments' copies (spec/FILES-AND-ENVIRONMENT.md §6.1; review files23 findings 4, 5,
// 8, 9, 10) at the HTTP and RPC boundary: a copy counts in the Files quota and goes once no
// message names it; a file that isn't a decodable image is a plain file whatever its name; the
// name and path a message tells the model are where the copy came from; a bulk restore puts
// files back too. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { png } from "./formats/support.ts"

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })

const json = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const upload = (path: string, bytes: Uint8Array | string) =>
  Effect.gen(function* () {
    const response = yield* call(`/files/upload?${new URLSearchParams({ path, conflict: "replace" })}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    })
    assert.strictEqual(response.status, 200)
  })

const attach = (path: string) =>
  Effect.gen(function* () {
    const response = yield* json("/files/attach", { path })
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return (yield* Effect.promise(() => response.json())) as AttachedFile
  })

const asAttachment = (a: AttachedFile) => ({
  mediaId: a.mediaId,
  altText: a.name,
  ...(a.kind === "file" ? { kind: "file" as const } : {}),
  name: a.name,
  path: a.path
})

describe("attachment copies", () => {
  it.live("count in the Files quota, and go once no message names them", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateWorkshop({ title: "Copies" })
      yield* upload("/files/doc.txt", "x".repeat(1000))
      assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).versionsBytes, 0)
      const doc = yield* attach("/files/doc.txt")
      // The copy takes room as a version would.
      assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).versionsBytes, 1000)
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "Here it is.",
          images: [asAttachment(doc)],
          reply: false
        })
      )
      assert.strictEqual(sent.entry.version.images?.[0]?.path, "/files/doc.txt")
      // The file deleted and the bin emptied: the message still names the copy, so it stays, counted.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/doc.txt" })).status, 200)
      const binned = yield* api.ListBin({ limit: 50, before: null })
      yield* api.EmptyBin({ itemIds: binned.map((item) => item.id) })
      assert.strictEqual((yield* call(`/files/attachment?id=${doc.mediaId}&name=doc.txt`)).status, 200)
      assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).versionsBytes, 1000)
      // The chat deleted (still in the bin): it can come back, so the copy stays.
      yield* api.DeleteChat({ chatId: chat.id })
      const deleted = yield* api.ListBin({ limit: 50, before: null })
      assert.strictEqual((yield* call(`/files/attachment?id=${doc.mediaId}&name=doc.txt`)).status, 200)
      // Purged: nothing names it any more, so it goes, and its room is free.
      yield* api.EmptyBin({ itemIds: deleted.map((item) => item.id) })
      assert.strictEqual((yield* call(`/files/attachment?id=${doc.mediaId}&name=doc.txt`)).status, 404)
      assert.strictEqual((yield* api.GetFilesUsage({})).versionsBytes, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("an unrelated purge between attachment copy and client sync keeps the composer file", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateWorkshop({ title: "Pending attachment" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const composer = { chatId: chat.id, draftId: draft.id, id: "pending-file" }
      yield* upload("/files/unrelated.txt", "Unrelated.")
      yield* json("/files/delete", { path: "/files/unrelated.txt" })
      const [item] = yield* api.ListBin({ limit: 50, before: null })
      yield* upload("/files/document.txt", "Draft content.")
      const response = yield* json("/files/attach", { path: "/files/document.txt", composer })
      assert.strictEqual(response.status, 200)
      const doc = (yield* Effect.promise(() => response.json())) as AttachedFile
      yield* api.PurgeBinItem({ itemId: item!.id })
      const saved = yield* api.SetComposerImage({ ...composer, ...asAttachment(doc) })
      assert.deepInclude(saved, { mediaId: doc.mediaId, status: "active" })
      assert.strictEqual((yield* call(`/files/attachment?id=${doc.mediaId}`)).status, 200)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("are refused past the Files quota", () =>
    Effect.gen(function* () {
      yield* upload("/files/big.bin", new Uint8Array(600 * 1024))
      yield* attach("/files/big.bin")
      // Its copy counts: a second copy of other bytes doesn't fit in 1 MiB.
      yield* upload("/files/big.bin", new Uint8Array(600 * 1024).fill(1))
      const refused = yield* json("/files/attach", { path: "/files/big.bin" })
      assert.strictEqual(refused.status, 507)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ filesQuota: "1600K" }), Generator.none)))
  )

  it.live("charges concurrent and repeated attachments of the same content only once", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const bytes = new Uint8Array(2 * 1024 * 1024)
      yield* upload("/files/repeat.bin", bytes)
      const before = yield* api.GetFilesUsage({ fresh: true })
      const copies = yield* Effect.all(
        [attach("/files/repeat.bin"), attach("/files/repeat.bin"), attach("/files/repeat.bin")],
        { concurrency: "unbounded" }
      )
      assert.strictEqual(new Set(copies.map((copy) => copy.mediaId)).size, 1)
      assert.strictEqual((yield* api.GetFilesUsage({})).usedBytes, before.usedBytes + bytes.length)
      const again = yield* attach("/files/repeat.bin")
      assert.strictEqual(again.mediaId, copies[0]!.mediaId)
      assert.strictEqual((yield* api.GetFilesUsage({})).usedBytes, before.usedBytes + bytes.length)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ filesQuota: "5M" }), Generator.none)))
  )

  it.live("a file that isn't an image attaches as a plain file, whatever its name", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateWorkshop({ title: "Types" })
      yield* upload("/files/fake.png", "Not a picture at all.")
      const fake = yield* attach("/files/fake.png")
      assert.deepInclude(fake, { kind: "file", mime: "application/octet-stream" })
      // Sent as an image, it's refused: its type isn't an image's.
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const asImage = yield* Effect.exit(
        api.SetComposerImage({
          chatId: chat.id,
          draftId: draft.id,
          id: "i",
          mediaId: fake.mediaId,
          altText: "",
          name: fake.name,
          path: fake.path
        })
      )
      assert.isTrue(Exit.isFailure(asImage))
      // A real one is an image.
      yield* upload("/files/map.png", png())
      assert.deepInclude(yield* attach("/files/map.png"), { kind: "image", mime: "image/png" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("tell the model only the name and path the copy came from", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateWorkshop({ title: "Paths" })
      yield* upload("/files/notes/a.txt", "Synthetic.")
      const a = yield* attach("/files/notes/a.txt")
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const set = (id: string, fields: Partial<ReturnType<typeof asAttachment>> & { kind?: "file" }) =>
        Effect.exit(
          api.SetComposerImage({
            chatId: chat.id,
            draftId: draft.id,
            id,
            mediaId: a.mediaId,
            altText: "",
            ...fields
          })
        )
      // Another path, another name, a file without a path, a name with a slash: refused.
      assert.isTrue(Exit.isFailure(yield* set("p", { kind: "file", name: "plan.txt", path: "/files/secret/plan.txt" })))
      assert.isTrue(Exit.isFailure(yield* set("n", { kind: "file", name: "other.txt", path: "/files/notes/a.txt" })))
      assert.isTrue(Exit.isFailure(yield* set("k", { kind: "file", name: "a.txt" })))
      assert.isTrue(Exit.isFailure(yield* set("s", { kind: "file", name: "x/a.txt", path: "/files/notes/a.txt" })))
      assert.isTrue(Exit.isSuccess(yield* set("ok", asAttachment(a))))
      const sent = yield* Effect.exit(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "x",
          images: [{ ...asAttachment(a), path: "/files/secret/plan.txt", name: "plan.txt" }],
          reply: false
        })
      )
      assert.isTrue(Exit.isFailure(sent))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a bulk restore puts a file back with the rest", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      yield* upload("/files/kept/one.txt", "One.")
      const deleted = yield* json("/files/delete", { path: "/files/kept/one.txt" })
      const { binItemId } = (yield* Effect.promise(() => deleted.json())) as { binItemId: string }
      const me = yield* api.Whoami()
      assert.isFalse(existsSync(join(config.dataDir, "files", me.id, "kept/one.txt")))
      const restored = yield* api.RestoreBinItems({ itemIds: [binItemId] })
      assert.deepStrictEqual(
        restored.map((item) => item.id),
        [binItemId]
      )
      assert.isTrue(existsSync(join(config.dataDir, "files", me.id, "kept/one.txt")))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
