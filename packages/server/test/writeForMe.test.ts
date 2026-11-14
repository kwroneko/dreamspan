import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { draftGenerationParts } from "../src/chat/draftGeneration.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import type { Generation } from "../src/assembler/types.ts"
import { chatCompletionsFields } from "../src/assembler/wire.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { generateReply, eventually } from "./support/generation.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import type { DraftGenerationTarget } from "@rp/shared/generationTarget.ts"

it.live(
  "drafts one user turn with the preset, records usage without a message or presence, and matches a stored user turn",
  () =>
    Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_req, res) =>
            sse(
              res,
              completionChunks(["<thinking>private</thinking>", "I open the gate."], {
                prompt_tokens: 100,
                completion_tokens: 12
              })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const f = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "context.per_speaker", value: "separate" }],
        preset: { impersonation_prompt: "[Write {{user}}'s next message. Only write as {{user}}.]" }
      })
      const userId = (yield* api.Whoami()).id
      const chat = yield* api.GetChat({ chatId: f.chat.id })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
      const target: DraftGenerationTarget = {
        kind: "draft",
        chatId: chat.id,
        forkId: chat.currentForkId!,
        leafSlotId: chat.activeLeafSlotId,
        draftId: draft.id
      }
      const before = yield* api.ReadPath({
        chatId: chat.id,
        forkId: target.forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      const cast = yield* api.GetCast({ chatId: chat.id, slotId: null, forkId: target.forkId })
      const prepared = yield* reader.AssembleDraftTurn({ userId, target, now: 1_000, timeZone: "UTC" })
      const generation = JSON.parse(prepared.generation) as Generation
      assert.isNull(generation.viewers)
      assert.include(JSON.stringify(generation.request), "Only write as Tobin")
      const initial = mock.requests().length
      const chunks = yield* api.WriteForMe({ target }).pipe(Stream.runCollect)
      assert.strictEqual(mock.requests().length, initial + 1)
      assert.strictEqual(chunks.map((c) => c.text).join(""), "I open the gate.")
      const rolloutId = chunks[0]!.rolloutId
      const run = yield* api.GetDraftRunContext({ rolloutId })
      assert.isNull(run.slotId)
      assert.isNull(run.versionId)
      assert.strictEqual(run.status, "completed")
      assert.strictEqual(run.requests.length, 1)
      assert.strictEqual(run.requests[0]!.counts.output, 12)
      assert.strictEqual(run.type, "impersonate")
      assert.strictEqual(yield* api.GetLastDraftRollout({ chatId: chat.id, forkId: target.forkId }), rolloutId)
      assert.deepStrictEqual(yield* api.GetChat({ chatId: chat.id }), chat)
      assert.deepStrictEqual(yield* api.GetCast({ chatId: chat.id, slotId: null, forkId: target.forkId }), cast)
      assert.deepStrictEqual(
        yield* api.ReadPath({
          chatId: chat.id,
          forkId: target.forkId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 100
        }),
        before
      )
      const body = mock.requests().at(-1)!.body!
      const fields = chatCompletionsFields(generation.request, "openai-chat")
      for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(body[key], value, key)
      const stored = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          forkId: target.forkId,
          branch: false,
          speakerEntityId: cast.playedByMe[0]!
        })
      )
      yield* eventually(() => mock.requests().length === initial + 2)
      // Same causal branch and user prompt: a stored user turn receives identical provider bytes.
      assert.deepStrictEqual(mock.requests().at(-1)!.body, body)
      const other = yield* writer.EnsureUser({ handle: "outsider", displayName: "Outsider" })
      assert.strictEqual(
        (yield* reader.DraftRunContext({ userId: other.id, rolloutId }).pipe(Effect.flip))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* reader.AssembleDraftTurn({ userId: other.id, target, now: 1_000, timeZone: "UTC" }).pipe(Effect.flip))
          ._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* reader.AssembleDraftTurn({ userId, target, now: 1_000, timeZone: "UTC" }).pipe(Effect.flip))._tag,
        "StaleWrite"
      )
      assert.isNotNull(stored.entry.version.id)
    }).pipe(Effect.provide(serverLayer(testConfig())))
)

it.live("a retryable provider error makes exactly one attempt and remains inspectable", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider((_req, res) => sse(res, completionChunks(["Ready."], {})))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const f = yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat = yield* api.GetChat({ chatId: f.chat.id })
    const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
    const target: DraftGenerationTarget = {
      kind: "draft",
      chatId: chat.id,
      forkId: chat.currentForkId!,
      leafSlotId: chat.activeLeafSlotId,
      draftId: draft.id
    }
    const originalText = "Keep my exact text.\n"
    yield* api.SaveComposer({
      chatId: chat.id,
      draftId: draft.id,
      rowVersion: draft.rowVersion,
      session: draft.session,
      next: false,
      operationId: "failed-draft-base",
      content: originalText
    })
    mock.setHandler((_req, res) => json(res, 429, { error: { message: "Please try later." } }))
    const count = mock.requests().length
    const failure = yield* api.WriteForMe({ target }).pipe(Stream.runDrain, Effect.flip)
    assert.strictEqual(failure._tag, "ServerError")
    assert.include(failure.message, "Please try later")
    assert.strictEqual(mock.requests().length, count + 1)
    const id = yield* api.GetLastDraftRollout({ chatId: chat.id, forkId: target.forkId })
    const run = yield* api.GetDraftRunContext({ rolloutId: id! })
    assert.strictEqual(run.status, "failed")
    assert.strictEqual(run.requests.length, 1)
    assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: target.forkId })).content, originalText)
    const firstHistory = yield* api.ComposerHistory({ chatId: chat.id, draftId: draft.id, limit: 100 })
    yield* api.WriteForMe({ target }).pipe(Stream.runDrain, Effect.flip)
    assert.strictEqual(mock.requests().length, count + 2)
    const secondHistory = yield* api.ComposerHistory({ chatId: chat.id, draftId: draft.id, limit: 100 })
    assert.deepStrictEqual(secondHistory, firstHistory)
  }).pipe(Effect.provide(serverLayer(testConfig())))
)

it.live("cancelling the draft stream closes its rollout and retains the delivered text", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider((_req, res) => sse(res, completionChunks(["Ready."], {})))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const f = yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat = yield* api.GetChat({ chatId: f.chat.id })
    const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
    const target: DraftGenerationTarget = {
      kind: "draft",
      chatId: chat.id,
      forkId: chat.currentForkId!,
      leafSlotId: chat.activeLeafSlotId,
      draftId: draft.id
    }
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of completionChunks(["Keep this."], {}).slice(0, 1))
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    })
    const chunks: Array<{ rolloutId: string; text: string }> = []
    const fiber = yield* api.WriteForMe({ target }).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk)
        })
      ),
      Effect.forkScoped
    )
    yield* eventually(() => chunks.some((c) => c.text.includes("Keep this.")))
    yield* Fiber.interrupt(fiber)
    assert.strictEqual(chunks.map((c) => c.text).join(""), "Keep this.")
    let status = "running"
    while (status === "running") {
      status = (yield* api.GetDraftRunContext({ rolloutId: chunks[0]!.rolloutId })).status
      if (status === "running") yield* Effect.sleep(10)
    }
    assert.strictEqual(status, "stopped")
    assert.deepStrictEqual(yield* api.GetChat({ chatId: chat.id }), chat)
  }).pipe(Effect.provide(serverLayer(testConfig())))
)

it.live("an earlier branch and parallel thread use only their own causal history and draft", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider((_req, res) => sse(res, completionChunks(["A later unseen reply."], {})))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const f = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren"],
      state: [{ key: "context.per_speaker", value: "separate" }]
    })
    const chat = yield* api.GetChat({ chatId: f.chat.id })
    const original = yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
    yield* api.SaveComposer({
      chatId: chat.id,
      draftId: original.id,
      rowVersion: original.rowVersion,
      session: original.session,
      next: false,
      operationId: "original-draft",
      content: "Other branch draft."
    })
    const forked = yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: f.sent.slotId })
    const entry = (yield* api.ReadPath({
      chatId: chat.id,
      forkId: forked.fork.id,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 1
    })).entries[0]!
    const threads = yield* api.StartThreads({
      chatId: chat.id,
      forkId: forked.fork.id,
      slotId: entry.slotId,
      expectedRowVersion: entry.rowVersion,
      threads: [
        { name: "Market", cast: [f.mira.entityId as never], writesAs: null },
        { name: "Harbor", cast: [f.characters[0]!.entityId as never], writesAs: null }
      ]
    })
    mock.setHandler((_req, res) =>
      sse(res, completionChunks(["I take the harbor path."], { prompt_tokens: 100, completion_tokens: 8 }))
    )
    const forkId = threads.forkIds[1]!
    const draft = yield* api.OpenComposer({ chatId: chat.id, forkId })
    const chunks = yield* api
      .WriteForMe({ target: { kind: "draft", chatId: chat.id, forkId, leafSlotId: entry.slotId, draftId: draft.id } })
      .pipe(Stream.runCollect)
    const body = JSON.stringify(mock.requests().at(-1)!.body)
    assert.include(body, "The road flooded.")
    assert.notInclude(body, "A later unseen reply.")
    assert.include(body, "Tobin")
    assert.strictEqual(chunks.map((c) => c.text).join(""), "I take the harbor path.")
    assert.strictEqual(
      (yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })).content,
      "Other branch draft."
    )
    assert.strictEqual(yield* api.GetLastDraftRollout({ chatId: chat.id, forkId: chat.currentForkId! }), null)
    assert.strictEqual(yield* api.GetLastDraftRollout({ chatId: chat.id, forkId }), chunks[0]!.rolloutId)
  }).pipe(Effect.provide(serverLayer(testConfig())))
)

it.effect("the draft policy is registered with source and scoped replacement restores it", () =>
  Effect.gen(function* () {
    const original = draftGenerationParts.get("draft")!
    assert.isString(original.source)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* draftGenerationParts.disable("draft")
        assert.isUndefined(draftGenerationParts.get("draft"))
      })
    )
    assert.strictEqual(draftGenerationParts.get("draft"), original)
  })
)
