// Image token estimates through the whole server (ARCHITECTURE §6, §15): the formula in the
// snapshot and the context view, ledger calibration for a model without one, and exact counts
// fetched off the hot path. Synthetic images and a mock provider only: no network.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, generateReply, finished } from "./support/generation.ts"
import { png } from "./formats/support.ts"
import { anthropicSse, completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { AssemblyModules } from "../src/assembler/modules.ts"
import type * as ImageTokenPlugin from "./support/imageTokenPlugin.ts"

/** A PNG whose header says it is `width`×`height`; only the header is read. */
const sized = (width: number, height: number) => {
  const bytes = Buffer.from(png())
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

const upload = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200)
    return (yield* Effect.promise(() => response.json())) as { mediaId: string }
  })

const mockProvider = (handler: Parameters<typeof startMockProvider>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const snapshotOf = (dataDir: string, versionId: string) =>
  Effect.map(
    fixtureSql(
      dataDir,
      [
        {
          sql: "SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN rollout_payloads p ON p.rollout_id=v.rollout_id WHERE v.id=?",
          params: [versionId]
        }
      ],
      { readOnly: true }
    ),
    ([rows]) => JSON.parse(rows![0]!.snapshot as string) as ContextSnapshot
  )

describe("image token estimates", () => {
  it.live("use the model's formula in the snapshot, the context view and the next context", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload(sized(1024, 1024))
      const mock = yield* mockProvider((_r, res) => sse(res, completionChunks(["A map."], {})))
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        modelKey: "gpt-4o",
        model: { vision: true },
        content: "What is this?",
        images: [image]
      })
      assert.strictEqual(generated.version.status, "complete", JSON.stringify(generated.version.error))
      const snapshot = yield* snapshotOf(config.dataDir, generated.version.id)
      const sent = snapshot.request.messages.flatMap((m) => m.images ?? [])
      assert.deepInclude(sent[0]!.estimate, { tokens: 765, basis: "formula", detail: "auto" })
      assert.include(sent[0], { width: 1024, height: 1024 })

      const run = yield* api.GetRunContext({ versionId: generated.version.id })
      const withImage = run.messages.find((m) => m.images?.length)!
      assert.deepInclude(withImage.images![0], { tokens: 765, basis: "formula", budgeted: 765, sent: true })
      assert.isAbove(withImage.tokens, 765)

      const next = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
      assert.deepStrictEqual(next.imageTokens, { count: 1, tokens: 765, unknown: 0, bases: ["formula"] })
      assert.notProperty(next, "uncounted")
      const draft = yield* api.OpenComposer({ chatId: generated.chat.id, forkId: null })
      const attached = yield* upload(sized(512, 512))
      yield* api.SetComposerImage({
        chatId: generated.chat.id,
        draftId: draft.id,
        id: "synthetic-draft-image",
        mediaId: attached.mediaId,
        altText: "Drawing"
      })
      const preview = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
      assert.deepStrictEqual(preview.imageTokens, { count: 2, tokens: 765 + 255, unknown: 0, bases: ["formula"] })
      assert.notProperty(preview, "uncounted")
      const modules = yield* AssemblyModules
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* modules.register({
            id: "synthetic/image-tokens",
            module: new URL("./support/imageTokenPlugin.ts", import.meta.url).href,
            exportName: "fixed" satisfies keyof typeof ImageTokenPlugin
          })
          const overridden = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
          assert.deepStrictEqual(overridden.imageTokens, { count: 2, tokens: 84, unknown: 0, bases: ["formula"] })
        })
      )
      yield* api.SetComposerImage({
        chatId: generated.chat.id,
        draftId: draft.id,
        id: "synthetic-draft-image",
        mediaId: null,
        altText: ""
      })
      assert.deepStrictEqual(
        (yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })).imageTokens,
        next.imageTokens
      )
      const otherModel = yield* api.AddUserModel({
        connectionId: generated.connection.id,
        key: "gpt-5.1",
        overrides: { vision: true }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: generated.connection.id, model: otherModel.id }, preset: null }
      })
      const changedModel = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
      assert.deepStrictEqual(changedModel.imageTokens, { count: 1, tokens: 630, unknown: 0, bases: ["formula"] })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("show an unknown model's images as unknown until the ledger calibrates them", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload(sized(672, 672))
      const mock = yield* mockProvider((_r, res) =>
        sse(
          res,
          completionChunks(["A cat."], {
            prompt_tokens: 700,
            completion_tokens: 2,
            total_tokens: 702,
            prompt_tokens_details: { image_tokens: 576 }
          })
        )
      )
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        modelKey: "local-vision",
        model: { vision: true },
        content: "",
        images: [image]
      })
      assert.strictEqual(generated.version.status, "complete", JSON.stringify(generated.version.error))
      const snapshot = yield* snapshotOf(config.dataDir, generated.version.id)
      const before = snapshot.request.messages.flatMap((m) => m.images ?? [])[0]!.estimate!
      assert.deepInclude(before, { tokens: null, basis: "unknown" })
      assert.include(before.note, "first request with an image")

      const next = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
      assert.deepStrictEqual(next.imageTokens, { count: 1, tokens: 576, unknown: 0, bases: ["calibrated"] })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("counts draft attachments before Send, and sends without waiting", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      let block = true
      const waiting: Array<() => void> = []
      const mock = yield* mockProvider((request, res) => {
        if (request.path.endsWith("/count_tokens")) {
          const respond = () =>
            json(res, 200, { input_tokens: JSON.stringify(request.body).includes('"image"') ? 1311 : 11 })
          if (block) waiting.push(respond)
          else respond()
          return
        }
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "synthetic",
              type: "message",
              role: "assistant",
              model: "synthetic",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1400, output_tokens: 1 }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A drawing." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" }
        ])
      })
      const connection = yield* api.CreateConnection({
        kind: "anthropic",
        settings: {
          name: "Synthetic counter",
          baseUrl: mock.url,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic"
      })
      // The user chose to count with this connection's provider (off by default, DESIGN §11).
      yield* api.SetTokenCounting({ connectionId: connection.id, via: connection.id })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "claude-opus-4-7",
        overrides: { vision: true }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Synthetic draft" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const image = yield* upload(sized(1000, 1000))
      const events: ChatEvent[] = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* api.SetComposerImage({
        chatId: chat.id,
        draftId: draft.id,
        id: "before-send",
        mediaId: image.mediaId,
        altText: "Drawing"
      })
      yield* eventually(() => waiting.length === 1)
      // This Send and reply complete while the counting HTTP request is still stalled.
      const posted = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Describe",
        images: [image],
        speakerEntityId: null
      })
      assert.strictEqual(posted._tag, "Posted")
      if (posted._tag !== "Posted") return
      const reply = yield* api.Generate({ chatId: chat.id, parentSlotId: posted.entry.slotId, branch: false })
      assert.strictEqual(reply._tag, "Posted")
      if (reply._tag !== "Posted") return
      yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
      assert.strictEqual(
        finished(events, reply.entry.version.id)!.status,
        "complete",
        JSON.stringify(finished(events, reply.entry.version.id)!.error)
      )
      assert.isTrue(
        mock.requests().some((r) => r.path.startsWith("/v1/messages?") || r.path === "/v1/messages"),
        JSON.stringify(mock.requests().map((r) => r.path))
      )
      block = false
      waiting.splice(0).forEach((respond) => respond())
      yield* eventually(() => events.some((e) => e._tag === "Cache" && e.imageTokens?.bases.includes("counted")))
      assert.isTrue(
        events.every((e) => !JSON.stringify(e).includes('"uncounted"') && !JSON.stringify(e).includes('"base64"'))
      )
      assert.strictEqual(mock.requests().filter((r) => r.path.endsWith("/count_tokens")).length, 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("count an image once with the provider's endpoint, off the send, and use the count", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const image = yield* upload(sized(1000, 1000))
      // The chat is watched from before the send. When Generate comes more than 2 s after it (a
      // busy machine; REPLY_EXPECTED_MS in chat/CacheWarmth.ts), the hold on the next request's
      // estimate lapses and the estimate asks for a count, which could land before the reply's
      // assembly and be used there (2026-11-01: 1300 for 1296 in a full check under load; a 4 s
      // pause before Generate reproduces it). The counts' answers wait until the reply is written.
      let replied!: () => void
      const written = new Promise<void>((resolve) => (replied = resolve))
      const mock = yield* mockProvider(async (request, res) => {
        if (request.path === "/v1/messages/count_tokens") {
          await written
          return json(res, 200, { input_tokens: JSON.stringify(request.body).includes('"image"') ? 1311 : 11 })
        }
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "synthetic",
              type: "message",
              role: "assistant",
              model: "claude-opus-4-7",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1400, output_tokens: 1 }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A grid." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" }
        ])
      })
      const generated = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-synthetic" },
        modelKey: "claude-opus-4-7",
        model: { vision: true },
        content: "Describe it.",
        images: [image],
        countWithProvider: true
      })
      assert.strictEqual(generated.version.status, "complete", JSON.stringify(generated.version.error))
      // The send itself used the formula: counting never ran before it.
      const snapshot = yield* snapshotOf(config.dataDir, generated.version.id)
      assert.deepInclude(snapshot.request.messages.flatMap((m) => m.images ?? [])[0]!.estimate, {
        tokens: 1296,
        basis: "formula"
      })
      replied()

      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: generated.chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      const counted = () =>
        events.some(
          (e) => e._tag === "Cache" && e.imageTokens?.bases.includes("counted") && e.imageTokens.tokens === 1300
        )
      yield* eventually(counted)
      const counts = () => mock.requests().filter((r) => r.path === "/v1/messages/count_tokens").length
      assert.strictEqual(counts(), 2, "one count with the image, one without")
      assert.isTrue(
        events.every((e) => e._tag !== "Cache" || !("uncounted" in e)),
        "what to count never reaches the client"
      )
      // Counted once: a later estimate reads the stored count.
      const next = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: null })
      assert.deepStrictEqual(next.imageTokens, { count: 1, tokens: 1300, unknown: 0, bases: ["counted"] })
      assert.strictEqual(counts(), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
