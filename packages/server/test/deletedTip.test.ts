// A deleted structural tip retains its shown gap. Exercise the RPC callers that used
// to assume that boundary was live, with a real synthetic provider and database workers.
import { assert, it } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { cardDoc } from "./support/docs.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

it.live("cast, next-context, regenerate and send accept the deleted tip that retains a shown insertion", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, response) =>
          sse(response, completionChunks(["A synthetic reply."], { prompt_tokens: 10, completion_tokens: 3 }))
        )
      ),
      (provider) => Effect.promise(() => provider.close())
    )
    const api = yield* client()
    const writer = yield* Writer
    const reader = yield* Reader
    const { chat, version, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {}
    })
    const userId = (yield* api.Whoami()).id as UserId
    const anchor = (yield* reader.GetSlot({ userId, slotId: version.slotId })).entry
    const insertion = yield* writer.InsertMessage({
      userId,
      chatId: chat.id,
      forkId: chat.currentForkId!,
      anchorSlotId: anchor.slotId,
      expectedRowVersion: anchor.rowVersion,
      body: { _tag: "Duplicate", versionId: version.id }
    })
    yield* api.DeleteMessage({ slotId: anchor.slotId, forkId: chat.currentForkId })
    yield* api.GetCast({ chatId: chat.id, forkId: chat.currentForkId, slotId: anchor.slotId })
    yield* api.GetNextContext({ chatId: chat.id, forkId: chat.currentForkId, leafSlotId: anchor.slotId })
    const entry = (yield* reader.GetSlot({ userId, slotId: insertion.slotId, forkId: chat.currentForkId })).entry
    const swipe = yield* api.Regenerate({
      slotId: entry.slotId,
      forkId: chat.currentForkId,
      expectedRowVersion: entry.rowVersion
    })
    yield* eventually(() => finished(events, swipe.version.id) !== undefined)
    assert.strictEqual(finished(events, swipe.version.id)!.status, "complete")
    // The provider's second request is the swipe, proving it passed the speaker-state read.
    yield* eventually(() => mock.requests().filter((request) => request.path === "/v1/chat/completions").length >= 2)
    const sent = yield* api.SendMessage({
      chatId: chat.id,
      forkId: chat.currentForkId,
      parentSlotId: anchor.slotId,
      branch: false,
      content: "After the gap.",
      reply: false
    })
    assert.strictEqual(sent._tag, "Posted")
    const path = yield* reader.GetPath({
      userId,
      chatId: chat.id,
      forkId: chat.currentForkId,
      leafSlotId: null,
      limit: 100
    })
    assert.deepStrictEqual(
      path.entries.slice(-2).map((message) => message.slotId),
      [insertion.slotId, sent._tag === "Posted" ? sent.entry.slotId : null]
    )
    assert.notInclude(
      path.entries.map((message) => message.slotId),
      anchor.slotId
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("a cast or setting change at the deleted tip goes to the display end and reaches the next turn", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, response) =>
          sse(response, completionChunks(["A synthetic reply."], { prompt_tokens: 10, completion_tokens: 3 }))
        )
      ),
      (provider) => Effect.promise(() => provider.close())
    )
    const api = yield* client()
    const writer = yield* Writer
    const reader = yield* Reader
    const { chat, version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {}
    })
    const userId = (yield* api.Whoami()).id as UserId
    const forkId = chat.currentForkId!
    const anchor = (yield* reader.GetSlot({ userId, slotId: version.slotId })).entry
    const insertion = yield* writer.InsertMessage({
      userId,
      chatId: chat.id,
      forkId,
      anchorSlotId: anchor.slotId,
      expectedRowVersion: anchor.rowVersion,
      body: { _tag: "Write", speaker: null, content: "The inserted turn." }
    })
    yield* api.DeleteMessage({ slotId: anchor.slotId, forkId })
    const card = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Joiner",
      subtitle: "",
      doc: cardDoc("Joiner", { description: "JOINER-DESCRIPTION" }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    // The composer names the fork's tip, the deleted message that keeps X shown.
    yield* api.ChangeCast({
      chatId: chat.id,
      forkId,
      slotId: anchor.slotId,
      change: { _tag: "Join", entityId: card.entityId }
    })
    const cast = yield* api.ChangeCast({
      chatId: chat.id,
      forkId,
      slotId: anchor.slotId,
      change: { _tag: "MacroBinding", name: "user", value: "Captain Vey" }
    })
    assert.include(cast.participants, card.entityId)
    assert.strictEqual(cast.macroNames.user, "Captain Vey")
    // Both events are on X, the display end: read through X, not through the deleted tip.
    const through = (slotId: SlotId) =>
      Effect.map(reader.StateEventsAt({ userId, chatId: chat.id, slotId, forkId }), foldState)
    const atX = yield* through(insertion.slotId)
    assert.include(atX.participants, card.entityId)
    assert.strictEqual(atX.macroBindings.user, "Captain Vey")
    const atTip = yield* through(anchor.slotId)
    assert.notInclude(atTip.participants, card.entityId)
    assert.isUndefined(atTip.macroBindings.user)
    // An explicit position at the deleted message is still refused: its events don't fold.
    const refused = yield* writer
      .AddStateEvent({
        userId,
        chatId: chat.id,
        forkId,
        slotId: anchor.slotId,
        versionId: null,
        scope: null,
        data: { key: "macro.binding", value: { name: "char", value: "Nobody" } }
      })
      .pipe(Effect.flip)
    assert.strictEqual(refused._tag, "NotFound")
    const before = mock.requests().length
    const sent = yield* api.SendMessage({
      chatId: chat.id,
      forkId,
      parentSlotId: anchor.slotId,
      branch: false,
      content: "After the gap."
    })
    assert.strictEqual(sent._tag, "Posted")
    // The reply the client asks for after a posted send.
    yield* api.Generate({
      chatId: chat.id,
      forkId,
      parentSlotId: sent._tag === "Posted" ? sent.entry.slotId : null,
      branch: false,
      speakerEntityId: card.entityId
    })
    yield* eventually(() => mock.requests().length > before)
    const body = JSON.stringify(mock.requests().at(-1)!.body)
    assert.include(body, "JOINER-DESCRIPTION")
    assert.include(body, "Captain Vey")
    assert.include(body, "The inserted turn.")
    assert.include(body, "After the gap.")
    assert.isBelow(body.indexOf("The inserted turn."), body.indexOf("After the gap."))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
