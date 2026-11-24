// Attachments of any type in workshops (spec/FILES-AND-ENVIRONMENT.md §6.1) at the HTTP and RPC
// boundary: a file uploaded into the working folder's Attachments folder is attached by its
// path (`POST /files/attach`), which keeps its content as the copy the message sends; the
// composer draft and the message keep its kind, name and path; the model reads one
// `<attachment …/>` line per file, and an image also as an image block; a later change to the
// file doesn't change the copy as sent; a story chat takes images only; a model that can't see
// images gets the image's path and no refusal. Synthetic files only.
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { png } from "./formats/support.ts"

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })

const json = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Uploads into the folder (keeping both on a taken name), then attaches what landed. */
const attachUpload = (folder: string, name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const uploaded = yield* call(`/files/upload?path=${encodeURIComponent(`${folder}/${name}`)}&conflict=keep`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    })
    assert.strictEqual(uploaded.status, 200, yield* Effect.promise(() => uploaded.clone().text()))
    const { path } = (yield* Effect.promise(() => uploaded.json())) as { path: string }
    const attached = yield* json("/files/attach", { path })
    assert.strictEqual(attached.status, 200, yield* Effect.promise(() => attached.clone().text()))
    return (yield* Effect.promise(() => attached.json())) as AttachedFile
  })

const text = (m: { content?: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))

describe("workshop attachments", () => {
  it.live(
    "are saved in Files, attached by path, kept as sent, and read by the model as attachment lines",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const body = r.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
              if (JSON.stringify(body.messages).includes("notes.txt")) requests.push(body)
              sse(res, completionChunks(["Read it."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000, vision: true }
        })
        assert.strictEqual((yield* json("/files/folder", { path: "/files/thesis" })).status, 200)
        const chat = yield* api.CreateWorkshop({ title: "Attachments" })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "WorkshopFolder", path: "/files/thesis" }
        })

        // Two files of the same name keep both; an image is marked as one.
        const notes = yield* attachUpload(
          "/files/thesis/Attachments",
          "notes.txt",
          new TextEncoder().encode("Draft one")
        )
        const again = yield* attachUpload("/files/thesis/Attachments", "notes.txt", new TextEncoder().encode("Other"))
        const picture = yield* attachUpload("/files/thesis/Attachments", "map.png", png())
        assert.deepInclude(notes, { kind: "file", name: "notes.txt", path: "/files/thesis/Attachments/notes.txt" })
        assert.deepInclude(notes, { mime: "text/plain", size: 9 })
        assert.strictEqual(again.path, "/files/thesis/Attachments/notes (2).txt")
        assert.deepInclude(picture, { kind: "image", mime: "image/png" })
        // Not a file of the account's: refused.
        assert.strictEqual((yield* json("/files/attach", { path: "/files/thesis" })).status, 400)
        assert.strictEqual((yield* json("/files/attach", { path: "/etc/passwd" })).status, 400)

        // The draft keeps each one's kind, name and path.
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        const key = { chatId: chat.id, draftId: draft.id }
        const asImage = (a: AttachedFile) => ({
          mediaId: a.mediaId,
          altText: a.name,
          ...(a.kind === "file" ? { kind: "file" as const } : {}),
          name: a.name,
          path: a.path
        })
        for (const [id, a] of [
          ["n", notes],
          ["p", picture]
        ] as const)
          yield* api.SetComposerImage({ ...key, id, ...asImage(a) })
        const drafted = yield* api.GetComposerImages({ ...key, ids: [] })
        assert.deepStrictEqual(
          drafted.map((d) => [d.id, d.kind ?? "image", d.name, d.path]),
          [
            ["n", "file", "notes.txt", "/files/thesis/Attachments/notes.txt"],
            ["p", "image", "map.png", "/files/thesis/Attachments/map.png"]
          ]
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
            content: "[Image]",
            images: [asImage(notes), asImage(picture)],
            imageDraftIds: ["n", "p"],
            composer: { draftId: draft.id, session: draft.session }
          })
        )
        assert.deepStrictEqual(
          sent.entry.version.images?.map((i) => [i.kind ?? "image", i.name, i.path]),
          [
            ["file", "notes.txt", "/files/thesis/Attachments/notes.txt"],
            ["image", "map.png", "/files/thesis/Attachments/map.png"]
          ]
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
        assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
        const user = requests[0]!.messages.find((m) => text(m).includes("notes.txt"))!
        const content = text(user)
        assert.include(content, "[Image]\\n<attachment")
        assert.include(
          content,
          '<attachment filename=\\"notes.txt\\" type=\\"text/plain\\" size=\\"9 B\\" path=\\"/files/thesis/Attachments/notes.txt\\"/>'
        )
        assert.include(content, 'path=\\"/files/thesis/Attachments/map.png\\" image_block=\\"true\\"/>')
        // The image goes as a block as well; the text file only by its path.
        assert.strictEqual(content.split('"type":"image_url"').length - 1, 1)
        assert.notInclude(JSON.stringify(requests[0]), "Draft one")

        // The copy as sent stays when the file changes.
        const me = yield* api.Whoami()
        yield* Effect.promise(() =>
          writeFile(join(config.dataDir, "files", me.id, "thesis/Attachments/notes.txt"), "Changed later")
        )
        const copy = yield* call(`/files/attachment?id=${notes.mediaId}&name=notes.txt`)
        assert.strictEqual(copy.status, 200)
        assert.strictEqual(yield* Effect.promise(() => copy.text()), "Draft one")
        assert.include(copy.headers.get("content-security-policy") ?? "", "sandbox")
        const html = yield* call(`/files/attachment?id=${notes.mediaId}&name=page.html`)
        assert.match(html.headers.get("content-disposition") ?? "", /^attachment/)

        // The path read back keeps them.
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
        const read = path.entries.find((e) => e.version.id === sent.entry.version.id)!
        assert.deepStrictEqual(
          read.version.images?.map((i) => i.path),
          ["/files/thesis/Attachments/notes.txt", "/files/thesis/Attachments/map.png"]
        )

        // A story chat takes images only.
        const story = yield* api.CreateChat({ title: "Story" })
        const storyDraft = yield* api.OpenComposer({ chatId: story.id, forkId: null })
        const refused = yield* Effect.exit(
          api.SetComposerImage({ chatId: story.id, draftId: storyDraft.id, id: "f", ...asImage(notes) })
        )
        assert.isTrue(Exit.isFailure(refused))
        const sendRefused = yield* Effect.exit(
          api.SendMessage({
            chatId: story.id,
            parentSlotId: null,
            branch: false,
            content: "x",
            images: [asImage(notes)],
            reply: false
          })
        )
        assert.isTrue(Exit.isFailure(sendRefused))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )

  it.live(
    "a model that can't see images gets an image's path, with no refusal",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const body = r.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
              if (JSON.stringify(body.messages).includes("BLIND TURN")) requests.push(body)
              sse(res, completionChunks(["Noted."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000, vision: false }
        })
        const chat = yield* api.CreateWorkshop({ title: "Blind" })
        const picture = yield* attachUpload("/files/Attachments", "map.png", png())
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
            content: "BLIND TURN",
            images: [{ mediaId: picture.mediaId, altText: "map.png", name: "map.png", path: picture.path }]
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
        assert.strictEqual(
          finished(events, reply.entry.version.id)!.status,
          "complete",
          JSON.stringify(finished(events, reply.entry.version.id))
        )
        const body = JSON.stringify(requests[0])
        assert.notInclude(body, "image_url")
        assert.include(body, `path=\\"/files/Attachments/map.png\\" note=\\"This model can't see images.\\"/>`)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    120_000
  )
})
