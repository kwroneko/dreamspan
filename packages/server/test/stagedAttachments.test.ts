import { assert, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { link, lstat, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { expect } from "vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachmentComposer } from "@dreamspan/shared/composerApi.ts"
import type { StagedFile } from "@dreamspan/shared/files.ts"
import { nameOf } from "@dreamspan/shared/files.ts"
import { Generator } from "../src/chat/Generator.ts"
import { AppConfig } from "../src/config.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { mediaPath } from "../src/db/media.ts"
import { makeAttachmentSend } from "../src/files/sendAttachments.ts"
import { client, outcome, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const workspace = "/files/Attachments"

const raw = (path: string, init?: RequestInit) =>
  Effect.flatMap(serverPort, (port) => Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init)))

const rawFile = (name: string) => raw(`/files/raw?${new URLSearchParams({ path: `${workspace}/${name}` })}`)

const stage = (name: string, content: string, composer: AttachmentComposer) =>
  Effect.gen(function* () {
    const response = yield* raw(`/files/attachments/stage?${new URLSearchParams({ name, ...composer })}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: content
    })
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return (yield* Effect.promise(() => response.json())) as StagedFile
  })

const callChunks = (name: string, args: unknown, id: string) => [
  {
    id: "attachment-probe",
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
    id: "attachment-probe",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

it.live(
  "keeps draft uploads out of read_file, list_files and bash until Send, and discards removed uploads",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let file: StagedFile
      const commands = (name: string, id: string) =>
        [
          ["read_file", { path: `${workspace}/${name}` }],
          ["read_file", { path: `/attachments/${id}` }],
          ["list_files", { path: "/files", depth: 2 }],
          ["bash", { command: `if test -f '${workspace}/${name}'; then echo FOUND; else echo MISSING; fi` }]
        ] as const
      let calls: ReturnType<typeof commands> | undefined
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, response) => {
            const body = request.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
            const from = body.messages.findLastIndex(
              (message) => message.role === "user" && JSON.stringify(message.content)?.includes("PROBE ATTACHMENT")
            )
            const step = body.messages.slice(from).filter((message) => message.role === "tool").length
            const next = from < 0 ? undefined : calls?.[step]
            sse(response, next ? callChunks(next[0], next[1], `probe-${step}`) : completionChunks(["Done."], {}))
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      const chat = yield* api.CreateWorkshop({ title: "Staged uploads" })
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "commands", mode: "allow" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const composer = { chatId: chat.id, draftId: draft.id }
      let leaf = chat.activeLeafSlotId
      const events: ChatEvent[] = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const probe = (phase: string, visible: boolean) =>
        Effect.gen(function* () {
          calls = commands(file.name, file.mediaId)
          const sent = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: leaf,
              branch: false,
              content: `PROBE ATTACHMENT ${phase}`,
              reply: false
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          leaf = reply.entry.slotId
          const id = reply.entry.version.id
          yield* eventually(() => finished(events, id) !== undefined, 60_000)
          assert.strictEqual(finished(events, id)!.status, "complete")
          const run = yield* api.GetRunTranscript({ versionId: id })
          const results = run.entries.filter((entry) => entry.role === "toolResult")
          assert.deepStrictEqual(
            results.map((entry) => entry.tool),
            calls.map(([tool]) => tool)
          )
          expect.soft(results[0]?.isError, `${phase}: read_file in Files`).toBe(!visible)
          expect.soft(results[1]?.isError, `${phase}: read_file by snapshot id`).toBe(!visible)
          expect.soft(results[2]?.text.includes(file.name), `${phase}: list_files`).toBe(visible)
          expect.soft(results[3]?.isError, `${phase}: bash ran`).toBe(false)
          expect.soft(results[3]?.text, `${phase}: bash`).toContain(visible ? "FOUND" : "MISSING")
        })

      file = yield* stage("send.txt", "Synthetic text to send", { ...composer, id: "send" })
      yield* probe("before send", false)
      const saved = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: leaf,
          branch: false,
          content: "Here is the attachment.",
          images: [{ mediaId: file.mediaId, kind: "file", name: file.name }],
          imageDraftIds: ["send"],
          composer: { draftId: saved.id, session: saved.session },
          reply: false
        })
      )
      leaf = sent.entry.slotId
      assert.strictEqual(sent.entry.version.images?.[0]?.path, `${workspace}/send.txt`)
      yield* probe("after send", true)

      const doomed = "Synthetic text to remove"
      file = yield* stage("remove.txt", doomed, { ...composer, id: "remove" })
      const held = join(config.dataDir, mediaPath(createHash("sha256").update(doomed).digest("hex")))
      assert.isTrue(existsSync(held))
      const removed = yield* api.SetComposerImage({ ...composer, id: "remove", mediaId: null, altText: "" })
      assert.strictEqual(removed.status, "removed")
      const download = yield* raw(`/files/attachment?id=${file.mediaId}`)
      expect.soft(download.status, "removed: composer copy download").toBe(404)
      assert.isFalse(existsSync(held))
      expect.soft(yield* api.ListBin({ limit: 50, before: null })).toHaveLength(0)
      yield* probe("after removal", false)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  120_000
)

it.live(
  "keeps uploads on a pending composer across a first send and rolls back a stale send with a colliding name",
  () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.OpenDraftChat({ draftFor: "workshop::" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const composer = { chatId: chat.id, draftId: draft.id }
      const existing = `${workspace}/notes.txt`
      const next = `${workspace}/notes (2).txt`
      const uploaded = yield* raw(`/files/upload?${new URLSearchParams({ path: existing, conflict: "keep" })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "An earlier attachment."
      })
      assert.strictEqual(uploaded.status, 200)
      const first = yield* stage("notes.txt", "First upload.", { ...composer, id: "first" })
      const carry = yield* stage("notes.txt", "Carried upload.", { ...composer, id: "carry" })
      const textOf = (path: string) =>
        raw(`/files/raw?${new URLSearchParams({ path })}`).pipe(
          Effect.flatMap((response) => (response.ok ? Effect.promise(() => response.text()) : Effect.succeed(null)))
        )
      const draftIds = () =>
        api.GetComposerImages({ ...composer, ids: [] }).pipe(Effect.map((images) => images.map(({ id }) => id)))
      const reopen = yield* api.OpenDraftChat({ draftFor: "workshop::", reopen: chat.id })
      assert.strictEqual(reopen.id, chat.id)
      assert.deepStrictEqual(yield* draftIds(), ["first", "carry"])
      assert.isNull(yield* textOf(next))
      const send = (file: StagedFile, id: string, parentSlotId: typeof chat.activeLeafSlotId, session: number) =>
        api.SendMessage({
          chatId: chat.id,
          parentSlotId,
          branch: false,
          content: "Attached.",
          reply: false,
          composer: { draftId: draft.id, session },
          imageDraftIds: [id],
          images: [{ mediaId: file.mediaId, kind: "file", name: file.name }]
        })
      const sent = yield* posted(send(first, "first", chat.activeLeafSlotId, draft.session))
      assert.strictEqual(sent.entry.version.images?.[0]?.path, next)
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).status, "active")
      assert.deepStrictEqual(yield* draftIds(), ["carry"])
      const advanced = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: sent.entry.slotId,
          branch: false,
          content: "Before the next file.",
          reply: false
        })
      )
      const current = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const refused = yield* send(carry, "carry", sent.entry.slotId, current.session).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "LeafMoved")
      assert.deepStrictEqual(yield* draftIds(), ["carry"])
      const third = `${workspace}/notes (3).txt`
      assert.isNull(yield* textOf(third))
      const retried = yield* posted(send(carry, "carry", advanced.entry.slotId, current.session))
      assert.strictEqual(retried.entry.version.images?.[0]?.path, third)
      assert.strictEqual(yield* textOf(existing), "An earlier attachment.")
      assert.strictEqual(yield* textOf(next), "First upload.")
      assert.strictEqual(yield* textOf(third), "Carried upload.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("keeps the upload private while the writer is waiting to reject a stale send", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const { id: userId } = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({ title: "A stale send" })
    const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
    const staged = yield* stage("private.txt", "Held until an accepted send.", {
      chatId: chat.id,
      draftId: draft.id,
      id: "private"
    })
    yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "Moved.",
        reply: false
      })
    )
    const send = yield* makeAttachmentSend.pipe(Effect.provideService(AppConfig, config))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const composer = { draftId: draft.id, session: draft.session }
    const input = {
      chatId: chat.id,
      composer,
      imageDraftIds: ["private"],
      images: [{ mediaId: staged.mediaId, kind: "file" as const, name: staged.name }]
    }
    const sending = yield* send(userId, input, (attachments) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* writer.SendOrQueue({
          ...input,
          ...attachments,
          userId,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          kind: "message",
          content: "Stale.",
          speakerEntityId: null,
          replySpeakerEntityId: null,
          noReply: true,
          direction: null,
          commitDraft: composer
        })
      })
    ).pipe(Effect.flip, Effect.forkScoped)
    yield* Deferred.await(entered)
    const inFlight = yield* rawFile(staged.name).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    assert.strictEqual((yield* Fiber.join(sending))._tag, "LeafMoved")
    assert.strictEqual((yield* rawFile(staged.name)).status, 404)
    assert.strictEqual(inFlight.status, 404, "the rejected send must never expose the file")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
})

it.live("recovers accepted publications on startup through an interrupted link without duplicating it", () => {
  const config = testConfig()
  const files = join(config.dataDir, "files")
  const privateFolder = join(files, ".attachment-publications")
  const name = "notes.txt"
  const second = "notes (2).txt"
  const third = "notes (3).txt"
  const at = (userId: string, name: string) => join(files, userId, "Attachments", name)
  const server = serverLayer(config, Generator.none)
  return Effect.gen(function* () {
    const { userId, inode } = yield* Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const { id: userId } = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({ title: "Interrupted send" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const composer = { chatId: chat.id, draftId: draft.id }
      const prior = yield* raw(
        `/files/upload?${new URLSearchParams({ path: `${workspace}/${name}`, conflict: "keep" })}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "Earlier."
        }
      )
      assert.strictEqual(prior.status, 200)
      const first = yield* stage(name, "First attachment.", { ...composer, id: "one" })
      const last = yield* stage(name, "Second attachment.", { ...composer, id: "two" })
      const input = {
        chatId: chat.id,
        composer,
        imageDraftIds: ["one", "two"],
        images: [first, last].map(({ mediaId, name }) => ({ mediaId, kind: "file" as const, name }))
      }
      const send = yield* makeAttachmentSend.pipe(Effect.provideService(AppConfig, config))
      const lost = new Error("The writer's reply was lost after commit.")
      assert.strictEqual(
        yield* send(userId, input, (attachments) =>
          writer
            .SendOrQueue({
              ...input,
              ...attachments,
              userId,
              parentSlotId: chat.activeLeafSlotId,
              branch: false,
              kind: "message",
              content: "With two files.",
              speakerEntityId: null,
              replySpeakerEntityId: null,
              noReply: true,
              direction: null,
              commitDraft: { draftId: draft.id, session: draft.session }
            })
            .pipe(Effect.andThen(Effect.fail(lost)))
        ).pipe(Effect.flip),
        lost
      )
      assert.strictEqual((yield* rawFile(second)).status, 404)
      assert.strictEqual((yield* rawFile(third)).status, 404)
      const pending = yield* reader.ListAttachmentPublications({ userId })
      assert.lengthOf(pending, 2)
      const linked = pending.find(({ path }) => nameOf(path) === second)!
      yield* Effect.promise(async () => {
        await link(join(privateFolder, linked.token), at(userId, second))
        await writeFile(join(privateFolder, crypto.randomUUID()), "A preparation left before commit.")
      })
      return { userId, inode: linked.inode }
    }).pipe(Effect.scoped, Effect.provide(server))

    yield* Effect.gen(function* () {
      const reader = yield* Reader
      const api = yield* client()
      assert.strictEqual((yield* api.Whoami()).id, userId)
      assert.deepStrictEqual(yield* reader.ListAttachmentPublications({ userId }), [])
      assert.deepStrictEqual(yield* Effect.promise(() => readdir(privateFolder)), [])
      assert.strictEqual((yield* Effect.promise(() => lstat(at(userId, second)))).ino, inode)
      for (const [file, text] of [
        [name, "Earlier."],
        [second, "First attachment."],
        [third, "Second attachment."]
      ] as const) {
        const response = yield* rawFile(file)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(yield* Effect.promise(() => response.text()), text)
      }
      assert.deepStrictEqual((yield* Effect.promise(() => readdir(at(userId, "")))).sort(), [second, third, name])
    }).pipe(Effect.scoped, Effect.provide(server))
  })
})

it.live("refuses to send or consume another fork's staged upload", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateWorkshop({ title: "Two composers" })
    const original = chat.currentForkId!
    const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: original, atSlotId: chat.activeLeafSlotId })
    const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: original })
    const staged = yield* stage("only-a.txt", "A's draft upload.", { chatId: chat.id, draftId: draft.id, id: "only-a" })
    const send = (forkId: typeof original) =>
      api.SendMessage({
        chatId: chat.id,
        forkId,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "Attached.",
        reply: false,
        composer: { draftId: draft.id, session: draft.session },
        imageDraftIds: ["only-a"],
        images: [{ mediaId: staged.mediaId, kind: "file", name: staged.name }]
      })
    assert.strictEqual(yield* outcome(send(fork.id)), "NotFound")
    assert.strictEqual((yield* rawFile(staged.name)).status, 404)
    assert.deepStrictEqual(
      (yield* api.GetComposerImages({ chatId: chat.id, draftId: draft.id, ids: [] })).map(({ id }) => id),
      ["only-a"]
    )
    yield* posted(send(original))
    const response = yield* rawFile(staged.name)
    assert.strictEqual(yield* Effect.promise(() => response.text()), "A's draft upload.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("binds a multi-thread send's staged upload to the first target's composer", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const reader = yield* Reader
    const { id: userId } = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({ title: "Two threads" })
    const chatId = chat.id
    const forkId = chat.currentForkId!
    const slotId = chat.activeLeafSlotId!
    const { entry } = yield* reader.GetSlot({ userId, slotId, forkId })
    const thread = { name: null, cast: [entry.version.speakerEntityId!], writesAs: null }
    const { forkIds } = yield* api.StartThreads({
      chatId,
      forkId,
      slotId,
      expectedRowVersion: entry.rowVersion,
      threads: [thread, thread]
    })
    const draft = yield* api.OpenComposer({ chatId, forkId })
    const staged = yield* stage("threads.txt", "One file for both threads.", {
      chatId,
      draftId: draft.id,
      id: "threads"
    })
    const send = (ids: typeof forkIds) =>
      api.SendToThreads({
        chatId,
        content: "For both threads.",
        composer: { draftId: draft.id, session: draft.session },
        imageDraftIds: ["threads"],
        images: [{ mediaId: staged.mediaId, kind: "file", name: staged.name }],
        targets: ids.map((forkId) => ({
          forkId,
          parentSlotId: slotId,
          speakerEntityId: null,
          reply: false,
          replySpeakerEntityId: null
        }))
      })
    assert.strictEqual(yield* outcome(send([...forkIds].reverse())), "NotFound")
    assert.strictEqual((yield* rawFile(staged.name)).status, 404)
    const sent = yield* send(forkIds)
    for (const copy of sent.copies) {
      if (copy._tag !== "Posted") return assert.fail("Expected both thread copies to post")
      assert.strictEqual(copy.entry.version.images?.[0]?.path, `${workspace}/${staged.name}`)
    }
    const response = yield* rawFile(staged.name)
    assert.strictEqual(yield* Effect.promise(() => response.text()), "One file for both threads.")
    assert.strictEqual((yield* rawFile("threads (2).txt")).status, 404)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("reopens a swept workshop with its staged upload and carries it once through repeated sweeps", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const reader = yield* Reader
    const { id: userId } = yield* api.Whoami()
    const draftFor = "workshop::"
    const original = yield* api.OpenDraftChat({ draftFor })
    const draft = yield* api.OpenComposer({ chatId: original.id, forkId: null })
    const content = "Keep this while the workshop is swept."
    const staged = yield* stage("carry.txt", content, { chatId: original.id, draftId: draft.id, id: "carry" })
    const sweep = (chatId: typeof original.id) => writer.SweepPendingChat({ userId, chatId })
    const reopen = () => api.OpenDraftChat({ draftFor, reopen: original.id })
    const check = (chatId: typeof original.id) =>
      Effect.gen(function* () {
        const composer = yield* api.OpenComposer({ chatId, forkId: null })
        const images = yield* api.GetComposerImages({ chatId, draftId: composer.id, ids: [] })
        assert.deepStrictEqual(
          images.map(({ id, mediaId, name, path }) => ({ id, mediaId, name, path })),
          [{ id: "carry", mediaId: staged.mediaId, name: staged.name, path: undefined }]
        )
        return composer
      })
    assert.isTrue(yield* sweep(original.id))
    const replacement = yield* reopen()
    assert.notStrictEqual(replacement.id, original.id)
    yield* check(replacement.id)
    assert.isTrue(yield* sweep(replacement.id))
    assert.strictEqual(yield* reader.FileVersionBytes({ userId }), Buffer.byteLength(content))
    const carried = yield* reopen()
    assert.notStrictEqual(carried.id, replacement.id)
    assert.strictEqual((yield* reopen()).id, carried.id)
    const current = yield* check(carried.id)
    const copy = yield* raw(`/files/attachment?id=${staged.mediaId}`)
    assert.strictEqual(yield* Effect.promise(() => copy.text()), content)
    assert.strictEqual((yield* rawFile(staged.name)).status, 404)
    yield* api.SetComposerImage({ chatId: carried.id, draftId: current.id, id: "carry", mediaId: null, altText: "" })
    assert.strictEqual(yield* reader.FileVersionBytes({ userId }), 0)
    assert.strictEqual((yield* raw(`/files/attachment?id=${staged.mediaId}`)).status, 404)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
