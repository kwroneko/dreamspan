import { createHash } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { png, textChunk } from "./formats/support.ts"
import { anthropicSse, completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"

const upload = (bytes = png()) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return (yield* Effect.promise(() => response.json())) as { mediaId: string }
  })

const userVersion = (content: string) =>
  new NewVersion({
    content,
    speakerEntityId: null,
    writer: "human",
    status: "complete",
    origin: "user_written",
    macroMode: "verbatim"
  })

const notFound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    assert.isTrue(Exit.isFailure(exit))
    assert.include(JSON.stringify(exit), "NotFound")
  })

describe("message images", () => {
  it.live(
    "persists composer image references, fences removals and sends, and consumes only a send's captured rows",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Synthetic attachment draft" })
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        const image = yield* upload()
        const key = { chatId: chat.id, draftId: draft.id }
        const put = (id: string) => api.SetComposerImage({ ...key, id, mediaId: image.mediaId, altText: id })
        yield* put("removed")
        yield* api.SetComposerImage({ ...key, id: "removed", mediaId: null, altText: "" })
        assert.strictEqual((yield* put("removed")).status, "removed", "offline replay must not restore a removed image")
        yield* put("sending")
        yield* put("next")
        const { entry: first } = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "",
            images: [image],
            imageDraftIds: ["sending"],
            composer: { draftId: draft.id, session: draft.session },
            reply: false
          })
        )
        assert.strictEqual(first.version.images?.[0]?.mediaId, image.mediaId)
        const read = yield* api.GetComposerImages({ ...key, ids: ["removed", "sending"] })
        assert.deepStrictEqual(
          read.map((entry) => [entry.id, entry.status]),
          [
            ["removed", "removed"],
            ["sending", "sent"],
            ["next", "active"]
          ]
        )
        assert.strictEqual((yield* put("sending")).status, "sent", "a sent row is an idempotent receipt")
        yield* notFound(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: first.slotId,
            branch: false,
            content: "",
            images: [image],
            imageDraftIds: ["sending"],
            composer: { draftId: draft.id, session: draft.session + 1 },
            reply: false
          })
        )
        yield* notFound(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: first.slotId,
            branch: false,
            content: "",
            images: [image, image],
            imageDraftIds: ["next", "missing"],
            composer: { draftId: draft.id, session: draft.session + 1 },
            reply: false
          })
        )
        assert.deepStrictEqual(
          (yield* api.GetComposerImages({ ...key, ids: [] })).map((entry) => entry.id),
          ["next"]
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("uploads, sends image-only messages, reads ordered version images, and rejects another owner's media", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const writer = yield* Writer
      const reader = yield* Reader
      const image = yield* upload()
      assert.deepStrictEqual(yield* upload(), image, "content-addressed uploads deduplicate")
      const chat = yield* api.CreateChat({ title: "Drawing" })
      const images = [{ ...image, altText: "A synthetic drawing" }, image]
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "", images })
      )
      assert.deepStrictEqual(entry.version.images, [images[0]!, { ...image, altText: "" }])
      assert.isTrue(entry.inContext)
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      assert.deepStrictEqual(path.entries[0]!.version.images, entry.version.images)
      const file = yield* reader.GetMediaFile({ userId: me.id, mediaId: image.mediaId })
      assert.strictEqual(file.mime, "image/png")
      const port = yield* serverPort
      const served = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/library/media?id=${image.mediaId}`))
      assert.strictEqual(served.status, 200)
      assert.strictEqual(
        createHash("sha256")
          .update(Buffer.from(yield* Effect.promise(() => served.arrayBuffer())))
          .digest("hex"),
        createHash("sha256").update(png()).digest("hex")
      )
      const other = yield* writer.EnsureUser({ handle: "other", displayName: "Other" })
      yield* notFound(reader.GetMediaFile({ userId: other.id, mediaId: image.mediaId }))
      const foreignChat = yield* writer.CreateChat({
        userId: other.id,
        kind: "rp",
        status: "active",
        title: "Private",
        participants: [],
        greeting: null
      })
      yield* notFound(
        writer.AppendMessage({
          userId: other.id,
          chatId: foreignChat.id,
          parentSlotId: null,
          branch: false,
          version: { ...userVersion("Attempt"), images: [image] },
          commitDraft: null
        })
      )
      assert.lengthOf(
        (yield* reader.GetPath({ userId: other.id, chatId: foreignChat.id, leafSlotId: null, limit: 20 })).entries,
        0
      )
      const invalid = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/chat/image`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "<svg>not an inline upload</svg>"
        })
      )
      assert.strictEqual(invalid.status, 415)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the first turn from a card can contain only an image", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload()
      const writer = yield* Writer
      const card = yield* writer.CreateEntity({
        userId: (yield* api.Whoami()).id,
        kind: "card",
        label: "Synthetic artist",
        subtitle: "",
        doc: cardDoc("Synthetic artist"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "", speakerEntityId: null, images: [image] }
      })
      assert.deepStrictEqual(
        started.entry.version.images?.map((i) => i.mediaId),
        [image.mediaId]
      )
      assert.isTrue(started.entry.inContext)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("queued image references survive stopping and restarting the server", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const saved = yield* Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id
        const image = yield* upload()
        const chat = yield* api.CreateChat({ title: "Restart" })
        const running = yield* writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          version: { ...userVersion(""), writer: "model", status: "generating", origin: "generated" },
          commitDraft: null
        })
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: running.slotId,
          branch: false,
          content: "",
          images: [image],
          reply: false
        })
        return { userId, chatId: chat.id, image }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
      yield* Effect.gen(function* () {
        const reader = yield* Reader
        const path = yield* reader.GetPath({ userId: saved.userId, chatId: saved.chatId, leafSlotId: null, limit: 20 })
        assert.deepStrictEqual(
          path.entries.at(-1)!.version.images?.map((i) => i.mediaId),
          [saved.image.mediaId]
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
    })
  })

  it.live("keeps images through edits, amends in forks, version selection, deletion and restore", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload()
      const chat = yield* api.CreateChat({ title: "Versions" })
      const { entry } = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Original", images: [image] })
      )
      const edited = yield* api.EditVersion({
        slotId: entry.slotId,
        sourceVersionId: entry.version.id,
        content: "Edited",
        expectedRowVersion: entry.rowVersion
      })
      assert.deepStrictEqual(edited.version.images, entry.version.images)
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const made = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: entry.slotId
      })
      const main = chat.currentForkId!
      yield* api.AmendVersion({
        versionId: edited.version.id,
        forkId: main,
        content: "Amended",
        expectedRowVersion: edited.version.rowVersion
      })
      const versions = yield* api.ListVersions({ slotId: entry.slotId, forkId: main })
      assert.isTrue(versions.every((v) => v.images?.[0]?.mediaId === image.mediaId))
      const cleared = yield* api.EditVersion({
        slotId: entry.slotId,
        forkId: made.fork.id,
        sourceVersionId: edited.version.id,
        content: "No image",
        images: [],
        expectedRowVersion: (yield* (yield* Reader).GetSlot({ userId, slotId: entry.slotId, forkId: made.fork.id }))
          .entry.rowVersion
      })
      assert.deepStrictEqual(cleared.version.images, [])
      const selected = yield* api.SelectVersion({
        slotId: entry.slotId,
        forkId: made.fork.id,
        versionId: entry.version.id,
        expectedVersionId: cleared.version.id
      })
      assert.deepStrictEqual(selected.version.images, entry.version.images)
      const written = yield* api.WriteVersion({
        slotId: entry.slotId,
        forkId: made.fork.id,
        content: "Another version",
        expectedRowVersion: selected.rowVersion
      })
      assert.deepStrictEqual(written.version.images, entry.version.images)
      const changed = yield* api.ApplyHistoryEdits({
        title: "Revise drawing text",
        applications: [
          {
            chatId: chat.id,
            forkId: made.fork.id,
            edits: [
              {
                kind: "version_replace",
                targetId: written.version.id,
                beforeId: written.version.id,
                before: written.version.content,
                after: "History edit with the same drawing"
              }
            ]
          }
        ]
      })
      const historyEntry = (yield* (yield* Reader).GetSlot({ userId, slotId: entry.slotId, forkId: made.fork.id }))
        .entry
      assert.deepStrictEqual(historyEntry.version.images, entry.version.images)
      assert.strictEqual(historyEntry.version.content, "History edit with the same drawing")
      yield* api.UndoHistoryEdit({ chatId: chat.id, forkId: made.fork.id, changesetId: changed.changesetIds[0]! })
      assert.strictEqual(
        (yield* (yield* Reader).GetSlot({ userId, slotId: entry.slotId, forkId: made.fork.id })).entry.version.id,
        written.version.id
      )
      const deleted = yield* api.DeleteMessage({ slotId: entry.slotId, forkId: made.fork.id })
      yield* api.RestoreBinItem({ itemId: deleted.id })
      const restored = yield* (yield* Reader).GetSlot({ userId, slotId: entry.slotId, forkId: made.fork.id })
      assert.deepStrictEqual(restored.entry.version.images, entry.version.images)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  for (const action of ["hide", "unhide", "restore"] as const) {
    it.live(`can write an image version after a fork-local ${action}, using the row version returned by reads`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const reader = yield* Reader
        const userId = (yield* api.Whoami()).id
        const image = yield* upload()
        const chat = yield* api.CreateChat({ title: `Image ${action}` })
        const { entry } = yield* posted(
          api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Drawing", images: [image] })
        )
        const forkId = chat.currentForkId!
        const sibling = yield* writer.CreateFork({
          userId,
          chatId: chat.id,
          fromForkId: forkId,
          atSlotId: entry.slotId
        })
        if (action === "restore") {
          const deleted = yield* api.DeleteMessage({ slotId: entry.slotId, forkId })
          yield* api.RestoreBinItem({ itemId: deleted.id })
        } else {
          yield* writer.SetSlotHidden({ userId, slotId: entry.slotId, forkId, hidden: true })
          if (action === "unhide") yield* writer.SetSlotHidden({ userId, slotId: entry.slotId, forkId, hidden: false })
        }
        const current = (yield* reader.GetSlot({ userId, slotId: entry.slotId, forkId })).entry
        assert.isAbove(current.rowVersion, entry.rowVersion)
        const write = (expectedRowVersion: number) =>
          api.WriteVersion({
            slotId: entry.slotId,
            forkId,
            content: "Revised drawing",
            expectedRowVersion
          })
        const stale = yield* Effect.exit(write(entry.rowVersion))
        assert.isTrue(Exit.isFailure(stale), "visibility changes fence an older editor")
        assert.include(JSON.stringify(stale), "StaleWrite")
        const written = yield* write(current.rowVersion)
        assert.deepStrictEqual(written.version.images, entry.version.images)
        const unchanged = (yield* reader.GetSlot({ userId, slotId: entry.slotId, forkId: sibling.fork.id })).entry
        assert.strictEqual(unchanged.rowVersion, entry.rowVersion)
        assert.strictEqual(unchanged.version.id, entry.version.id)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
    )
  }

  it.live("queues image-only messages durably and posts their images after a reply completes", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const image = yield* upload()
      const chat = yield* api.CreateChat({ title: "Queue" })
      const running = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        version: { ...userVersion(""), writer: "model", status: "generating", origin: "generated" },
        commitDraft: null
      })
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: running.slotId,
        branch: false,
        content: "",
        images: [image],
        reply: false
      })
      assert.strictEqual(queued._tag, "Queued")
      if (queued._tag === "Queued") assert.deepStrictEqual(queued.queued.images, [image])
      yield* writer.FinishGeneration({
        userId,
        versionId: running.version.id,
        content: "Done",
        status: "complete",
        error: null
      })
      const path = yield* reader.GetPath({ userId, chatId: chat.id, leafSlotId: null, limit: 20 })
      assert.deepStrictEqual(
        path.entries.at(-1)!.version.images?.map((i) => i.mediaId),
        [image.mediaId]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("sends actual image bytes to a vision provider, pins their versions and applies the last-N limit", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const older = yield* upload(png(textChunk("fixture", "older")))
      const image = yield* upload()
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["A drawing."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { vision: true, maxImages: 1 },
        content: "",
        images: [older, image]
      })
      assert.strictEqual(generated.version.status, "complete", JSON.stringify(generated.version.error))
      // Image-aware planning can send a greeting summary before the actual reply.
      const body = JSON.stringify(mock.requests().findLast((r) => r.path === "/v1/chat/completions")!.body)
      assert.strictEqual(body.split('"type":"image_url"').length - 1, 1, body)
      assert.include(body, `data:image/png;base64,${Buffer.from(png()).toString("base64")}`)
      assert.notInclude(body, Buffer.from(png(textChunk("fixture", "older"))).toString("base64"))
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN rollout_payloads p ON p.rollout_id=v.rollout_id WHERE v.id=?",
            params: [generated.version.id]
          }
        ],
        { readOnly: true }
      )
      const stored = rows![0]!
      const snapshot = JSON.parse(stored.snapshot as string) as ContextSnapshot
      assert.lengthOf(
        snapshot.request.messages.flatMap((m) => m.images ?? []),
        2
      )
      assert.notInclude(stored!.snapshot as string, Buffer.from(png()).toString("base64"))
      assert.include(
        snapshot.issues.map((i) => i.kind),
        "images_limited"
      )
      const human = (yield* api.ReadPath({
        chatId: generated.chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 20
      })).entries.find((entry) => entry.version.writer === "human")!
      yield* api.EditVersion({
        slotId: human.slotId,
        sourceVersionId: human.version.id,
        content: "Images removed in a later edit",
        images: [],
        expectedRowVersion: human.rowVersion
      })
      const rebuilt = yield* (yield* Reader).RebuildContext({
        userId: (yield* api.Whoami()).id,
        snapshot: stored.snapshot as string
      })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snapshot)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  for (const kind of ["anthropic", "google", "openai-responses"]) {
    it.live(`carries image bytes through the ${kind} SDK conversion`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const image = yield* upload()
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((_request, res) => {
              if (kind === "anthropic")
                anthropicSse(res, [
                  {
                    type: "message_start",
                    message: {
                      id: "synthetic",
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: "mock-model",
                      usage: { input_tokens: 10, output_tokens: 0 }
                    }
                  },
                  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
                  { type: "message_stop" }
                ])
              else if (kind === "google")
                sse(
                  res,
                  [
                    {
                      candidates: [
                        { content: { role: "model", parts: [{ text: "A drawing." }] }, finishReason: "STOP" }
                      ],
                      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 }
                    }
                  ],
                  { done: false }
                )
              else
                sse(
                  res,
                  [
                    {
                      type: "response.completed",
                      response: {
                        id: "synthetic",
                        status: "completed",
                        model: "mock-model",
                        output: [],
                        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 }
                      }
                    }
                  ],
                  { done: false }
                )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const generated = yield* generateReply(api, {
          connection: {
            kind,
            baseUrl: kind === "openai-responses" ? `${mock.url}/v1` : mock.url,
            apiKey: "synthetic-key-for-images-0000"
          },
          model: { vision: true },
          content: "",
          images: [image]
        })
        assert.strictEqual(generated.version.status, "complete", JSON.stringify(generated.version.error))
        const body = JSON.stringify(mock.requests().find((r) => r.body !== null)!.body)
        assert.include(body, Buffer.from(png()).toString("base64"))
        assert.include(
          body,
          kind === "anthropic" ? '"type":"image"' : kind === "google" ? '"inlineData"' : '"type":"input_image"'
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )
  }

  it.live("a text-only model refuses images explicitly without calling a provider", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload()
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_r, res) => sse(res, completionChunks(["Unexpected"], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { vision: false },
        images: [image]
      })
      assert.strictEqual(generated.version.error?.class, "images_unsupported")
      assert.lengthOf(mock.requests(), 0)
      const path = yield* api.ReadPath({
        chatId: generated.chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 20
      })
      assert.deepStrictEqual(
        path.entries.find((e) => e.version.writer === "human")!.version.images?.map((i) => i.mediaId),
        [image.mediaId]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
