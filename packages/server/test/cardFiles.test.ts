// A character card attached as a file in a workshop (spec/WORKSHOP-CARDS.md §4.5) at the HTTP
// and RPC boundary: it's recognised by its bytes when attached (a PNG with card chunks, card
// JSON; a plain PNG or other JSON isn't one), stays a file, and the draft and the message name
// it as a card. The model's `<attachment>` element names the card and holds its fields, with
// the note on the card file tools once per message. Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { client, outcome, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { cardChunk, json as jsonBytes, png, stCardV2 } from "./formats/support.ts"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readCardFile } from "../src/formats/cardFile.ts"
import { defaultLimits } from "../src/formats/safety.ts"
import { writeZip } from "../src/formats/zip.ts"
import { mediaPath } from "../src/db/media.ts"
import { sha256 } from "../src/importer/importers.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
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

const importApproval = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) =>
  events
    .flatMap((event) => (event._tag === "Steps" && event.versionId === versionId ? event.steps : []))
    .flatMap((step) => (step.kind === "tool" && step.id === toolCallId && step.approval ? [step.approval] : []))
    .at(-1)

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
        model: { context: 200000, vision: true },
        preset: { openai_max_context: 40_000 }
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
        `path=\\"/attachments/${wren.mediaId}\\" image_block=\\"true\\" file_path=\\"/files/cards/Attachments/wren.png\\" card=\\"true\\" card_name=\\"Wren Hollow\\" format=\\"png\\" spec=\\"chara_card_v3\\" spec_version=\\"3.0\\">`
      )
      assert.include(content, `card_name=\\"Gull Keeper\\" format=\\"json\\"`)
      // Whole: its fields are in the element.
      assert.include(content, "A lighthouse keeper.")
      assert.strictEqual(content.split("read_card_file (the same views").length - 1, 1)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.live(
    "are read with the card views, edited in their own format as a file version, and imported on request",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = []
        let steps: Array<[string, unknown]> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const b = r.body as unknown as { messages: Array<{ role: string; content?: string }> }
              if (!JSON.stringify(b.messages).includes("CARD TASK")) return sse(res, completionChunks(["Ready."], {}))
              requests.push(b)
              const done = b.messages.filter((m) => m.role === "tool").length
              const step = steps[done]
              if (!step) return sse(res, completionChunks(["Done."], {}))
              sse(res, toolCall(step[0], step[1], `card_${done}`))
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
        const chat = yield* api.CreateWorkshop({ title: "Card file tools" })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "WorkshopFolder", path: "/files/cards" }
        })
        const folder = "/files/cards/Attachments"
        const wren = yield* attachUpload(folder, "wren.png", png(cardChunk("ccv3", v3Card("Wren Hollow"))))
        const other = yield* attachUpload(folder, "data.json", jsonBytes({ hello: "world" }))
        const lorebook = yield* attachUpload(folder, "lore.json", jsonBytes({ name: "Harbor Lore", entries: {} }))
        const copy = `/attachments/${wren.mediaId}`
        steps = [
          ["edit_card_file", { path: wren.path, changes: [{ field: "description", text: "Too soon." }] }],
          ["read_card_file", { path: copy }],
          ["read_card_file", { path: wren.path, view: "summary" }],
          [
            "edit_card_file",
            { path: wren.path, changes: [{ field: "description", find: "lighthouse", replace: "harbour" }] }
          ],
          ["edit_card_file", { path: copy, changes: [{ field: "description", text: "No." }] }],
          ["read_card_file", { path: other.path }],
          ["import_card_file", { path: wren.path }],
          ["import_card_file", { path: lorebook.path }]
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
            content: "CARD TASK: tighten Wren and add it to my library."
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        const id = reply.entry.version.id
        for (const callId of ["card_6", "card_7"]) {
          yield* eventually(() => importApproval(events, id, callId) !== undefined)
          const { rolloutId, toolCallId, digest, once } = importApproval(events, id, callId)!
          assert.isTrue(once)
          yield* api.AnswerToolApproval({ rolloutId, toolCallId, digest, answer: "allow" })
        }
        yield* eventually(() => finished(events, id) !== undefined, 120_000)
        assert.strictEqual(finished(events, id)!.status, "complete")
        const results = requests
          .at(-1)!
          .messages.filter((m) => m.role === "tool")
          .map((m) => unquoteToolData(m.content ?? ""))
        assert.include(results[0], "with read_card_file before changing it")
        assert.include(results[1], '"name":"Wren Hollow"')
        assert.include(results[1], '"format":"png"')
        assert.include(results[1], "A lighthouse keeper.")
        assert.include(results[2], `card file ${wren.path} "Wren Hollow" (PNG, chara_card_v3 3.0)`)
        assert.include(results[2], "description: ")
        assert.include(results[3], "description")
        assert.include(results[4], "can't be changed")
        assert.include(results[5], "isn't a character card")
        assert.include(results[6], 'as the card "Wren Hollow"')
        assert.include(results[7], "could not be imported as a card")
        assert.isFalse((yield* api.ListLibrary({ kind: "lorebook" })).some((ref) => ref.label === "Harbor Lore"))

        // The file is still a PNG card, with the change.
        const me = yield* api.Whoami()
        const onDisk = join(config.dataDir, "files", me.id, "cards/Attachments/wren.png")
        const info = readCardFile(yield* Effect.promise(() => readFile(onDisk)), defaultLimits)!
        assert.strictEqual(info.format, "png")
        assert.strictEqual(info.doc.description, "A harbour keeper.")
        // The change names the card's fields, before and after; its undo puts the file back.
        const effects = yield* api.ListVersionEffects({ versionId: id })
        const edit = effects.find((e) => e.kind === "file.edit")!
        assert.strictEqual(edit.title, `Edited the card file ${wren.path}`)
        assert.deepStrictEqual((edit.undo as { card: unknown }).card, {
          name: "Wren Hollow",
          format: "png",
          before: { description: "A lighthouse keeper." },
          after: { description: "A harbour keeper." }
        })
        assert.isTrue(effects.some((e) => e.kind === "library.create"))
        const library = yield* api.ListLibrary({ kind: "card" })
        assert.isTrue(library.some((ref) => ref.label === "Wren Hollow"))
        // Revert takes the field back in the file's own format, keeping the old file as a version;
        // Redo puts the change back (spec/WORKSHOP-CARDS.md §8.1).
        const key = { rolloutId: edit.rolloutId, toolCallId: edit.toolCallId, seq: edit.seq }
        yield* api.GetFilesUsage({ fresh: true })
        const reverted = yield* api.RevertChange({ effects: [key] })
        assert.deepStrictEqual(reverted.fields, ['["description"]'])
        const was = readCardFile(yield* Effect.promise(() => readFile(onDisk)), defaultLimits)!
        assert.strictEqual(was.format, "png")
        assert.strictEqual(was.doc.description, "A lighthouse keeper.")
        assert.strictEqual(was.doc.name, "Wren Hollow")
        const listed = (yield* api.ListVersionEffects({ versionId: id })).find((e) => e.kind === "file.edit")!
        assert.deepStrictEqual(listed.reversion?.fields, ['["description"]'])
        const cached = yield* api.GetFilesUsage({})
        const measured = yield* api.GetFilesUsage({ fresh: true })
        assert.strictEqual(cached.usedBytes, measured.usedBytes)
        yield* api.SetFilesQuota({ userId: me.id, quotaBytes: 0 })
        assert.strictEqual(yield* outcome(api.RedoChange({ reversalId: reverted.reversalId! })), "EffectUndoRefused")
        assert.strictEqual(
          readCardFile(yield* Effect.promise(() => readFile(onDisk)), defaultLimits)!.doc.description,
          "A lighthouse keeper."
        )
        yield* api.SetFilesQuota({ userId: me.id, quotaBytes: null })
        const redone = yield* api.RedoChange({ reversalId: reverted.reversalId! })
        assert.deepStrictEqual(redone.fields, ['["description"]'])
        assert.strictEqual(
          readCardFile(yield* Effect.promise(() => readFile(onDisk)), defaultLimits)!.doc.description,
          "A harbour keeper."
        )
        yield* api.UndoRolloutEffect({ rolloutId: edit.rolloutId, toolCallId: edit.toolCallId, seq: edit.seq })
        const back = readCardFile(yield* Effect.promise(() => readFile(onDisk)), defaultLimits)!
        assert.strictEqual(back.doc.description, "A lighthouse keeper.")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )

  it.live("reverts and redoes a card edit in an approved host folder", () => {
    const root = tempDir("card-file-host")
    const config = testConfig({ hostFolders: [root] })
    const path = join(root, "wren.json")
    return Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(path, jsonBytes(v3Card("Wren Hollow"))))
      const api = yield* client()
      const user = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({ title: "Card files" })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "WorkshopFolder", path: root, host: true }
      })
      const rolloutId = `r-${chat.id}`
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
          params: [rolloutId, chat.id]
        }
      ])
      const tools = yield* ExecutionRegistry
      const context = {
        userId: user.id,
        chatId: chat.id,
        forkId: chat.currentForkId,
        leafSlotId: null,
        slotId: chat.activeLeafSlotId as ToolContext["slotId"],
        versionId: "unused" as ToolContext["versionId"],
        rolloutId,
        toolCallId: "read",
        reader: yield* Reader,
        writer: yield* Writer,
        viewers: null,
        cache: new Map()
      } satisfies ToolContext
      const read = yield* toolForKind(tools, "workshop", "read_card_file")!.execute(context, { path } as never)
      assert.isUndefined(read.isError, read.text)
      const edit = yield* toolForKind(tools, "workshop", "edit_card_file")!.execute(
        { ...context, toolCallId: "edit" },
        { path, changes: [{ field: "description", text: "A harbour keeper." }] } as never
      )
      assert.isUndefined(edit.isError, edit.text)
      yield* context.writer.RecordRolloutEffects({
        userId: user.id,
        rolloutId,
        toolCallId: "edit",
        result: edit.text,
        isError: false,
        effects: edit.effects ?? []
      })
      const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
      const effect = effects.find((e) => e.toolCallId === "edit")!
      assert.strictEqual(effect?.undo?.host, true)
      const key = { rolloutId, toolCallId: effect.toolCallId, seq: effect.seq }
      const description = () =>
        Effect.promise(async () => readCardFile(await readFile(path), defaultLimits)!.doc.description)
      const reverted = yield* api.RevertChange({ effects: [key] })
      assert.strictEqual(yield* description(), stCardV2().data.description)
      yield* api.RedoChange({ reversalId: reverted.reversalId! })
      assert.strictEqual(yield* description(), "A harbour keeper.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "requires approval for a card import and refuses when Files are off",
    () =>
      Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const body = request.body as unknown as { messages: Array<{ role: string }> }
              if (
                !JSON.stringify(body.messages).includes("What can this workshop do?") ||
                body.messages.some((m) => m.role === "tool")
              )
                return sse(res, completionChunks(["Ready."], {}))
              sse(res, toolCall("import_card_file", { path: "/files/wren.png" }, "import_wren"))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200_000 }
        })
        yield* attachUpload("/files", "wren.png", png(cardChunk("ccv3", v3Card("Wren Hollow"))))
        for (const filesOff of [false, true]) {
          const chat = yield* api.CreateWorkshop({ title: "Card import consent" })
          if (filesOff) yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "files", mode: "off" })
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
              content: "What can this workshop do?"
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          const id = reply.entry.version.id
          if (!filesOff) {
            yield* eventually(() => importApproval(events, id, "import_wren") !== undefined)
            const { rolloutId, toolCallId, digest } = importApproval(events, id, "import_wren")!
            assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((ref) => ref.label === "Wren Hollow"))
            yield* api.AnswerToolApproval({ rolloutId, toolCallId, digest, answer: "deny" })
          }
          yield* eventually(() => finished(events, id) !== undefined)
          if (filesOff) assert.isUndefined(importApproval(events, id, "import_wren"))
          assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((ref) => ref.label === "Wren Hollow"))
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    60_000
  )

  it.live(
    "checks Files quota before storing card pictures and counts them once after import",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const body = request.body as unknown as { messages: Array<{ role: string }> }
              if (
                !JSON.stringify(body.messages).includes("Import the cormorant card.") ||
                body.messages.some((m) => m.role === "tool")
              )
                return sse(res, completionChunks(["Ready."], {}))
              sse(res, toolCall("import_card_file", { path: "/files/cormorant.charx" }, "import_card"))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const { id: userId } = yield* api.Whoami()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200_000 }
        })
        const picture = png()
        const card = v3Card("Cormorant")
        const assets = [{ type: "icon", name: "main", ext: "png", uri: "embeded://main.png" }]
        const uploaded = yield* call("/files/upload?path=%2Ffiles%2Fcormorant.charx&conflict=keep", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: writeZip([
            { name: "card.json", data: jsonBytes({ ...card, data: { ...card.data, assets } }), deflate: true },
            { name: "main.png", data: picture, deflate: false }
          ])
        })
        assert.strictEqual(uploaded.status, 200)
        const before = yield* api.GetFilesUsage({ fresh: true })
        const attemptImport = () =>
          Effect.scoped(
            Effect.gen(function* () {
              const chat = yield* api.CreateWorkshop({ title: "Card import quota" })
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
                  content: "Import the cormorant card."
                })
              )
              const reply = yield* posted(
                api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
              )
              const id = reply.entry.version.id
              yield* eventually(() => importApproval(events, id, "import_card") !== undefined)
              const { rolloutId, toolCallId, digest } = importApproval(events, id, "import_card")!
              yield* api.AnswerToolApproval({ rolloutId, toolCallId, digest, answer: "allow" })
              yield* eventually(() => finished(events, id) !== undefined)
            })
          )

        yield* api.SetFilesQuota({ userId, quotaBytes: before.usedBytes - 1 })
        yield* attemptImport()
        assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((ref) => ref.label === "Cormorant"))
        const stored = join(config.dataDir, mediaPath(sha256(picture)))
        const found = yield* Effect.promise(() =>
          readFile(stored).then(
            () => true,
            () => false
          )
        )
        assert.isFalse(found)
        assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).usedBytes, before.usedBytes)

        yield* api.SetFilesQuota({ userId, quotaBytes: before.usedBytes + picture.byteLength })
        yield* attemptImport()
        assert.isTrue((yield* api.ListLibrary({ kind: "card" })).some((ref) => ref.label === "Cormorant"))
        const after = yield* api.GetFilesUsage({ fresh: true })
        assert.strictEqual(after.usedBytes - before.usedBytes, picture.byteLength)
        yield* attemptImport()
        assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).usedBytes, after.usedBytes)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )
})
