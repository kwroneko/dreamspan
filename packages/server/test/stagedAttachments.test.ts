import { assert, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { expect } from "vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { AttachmentComposer } from "@dreamspan/shared/composerApi.ts"
import type { StagedFile } from "@dreamspan/shared/files.ts"
import { Generator } from "../src/chat/Generator.ts"
import { mediaPath } from "../src/db/media.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const workspace = "/files/Attachments"

const raw = (path: string, init?: RequestInit) =>
  Effect.flatMap(serverPort, (port) => Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init)))

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
