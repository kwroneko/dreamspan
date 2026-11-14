// Choosing the summary model (audit item 067): the account's in Settings → Chats and a chat's
// own from a position on, each taken off again; a deleted model reads as none. Synthetic
// cards and a local connection that is never called.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

it.live("the account's and a chat's summary model are set and taken off", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const local = (name: string) =>
      api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name,
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
    const connection = yield* local("Local")
    const spare = yield* local("Spare")
    const cheap = yield* api.AddUserModel({ connectionId: spare.id, key: "cheap-model", overrides: {} })
    const other = yield* api.AddUserModel({ connectionId: connection.id, key: "other-model", overrides: {} })
    const choice = (on: { id: typeof connection.id }, id: typeof cheap.id) => ({ connection: on.id, model: id })

    // The account's, beside the fallback, which stays as it was.
    yield* api.ChangeGenerationDefaults({ change: { fallback: choice(connection, other.id) } })
    const set = yield* api.ChangeGenerationDefaults({ change: { summarizer: choice(spare, cheap.id) } })
    assert.deepStrictEqual(set.lcm?.summarizer, choice(spare, cheap.id))
    assert.deepStrictEqual(set.lcm?.fallback, choice(connection, other.id))

    // A chat's own, from a position on; the chat's model is untouched.
    const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
    const chat = yield* api.CreateChat({ title: "Summary model" })
    yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira.entityId } })
    const own = yield* api.ChangeCast({
      chatId: chat.id,
      slotId: null,
      change: { _tag: "SummaryModel", model: choice(connection, other.id) }
    })
    assert.deepStrictEqual(own.summaryModel, choice(connection, other.id))
    assert.isNull(own.model)
    const followed = yield* api.ChangeCast({
      chatId: chat.id,
      slotId: null,
      change: { _tag: "SummaryModel", model: null }
    })
    assert.isUndefined(followed.summaryModel)

    // A deleted model reads as none; taking the account's off leaves the fallback.
    yield* api.DeleteConnection({ connectionId: spare.id })
    assert.deepStrictEqual((yield* api.GetGenerationDefaults()).lcm?.summarizer, choice(spare, cheap.id))
    const cleared = yield* api.ChangeGenerationDefaults({ change: { summarizer: null } })
    assert.isUndefined(cleared.lcm?.summarizer)
    assert.deepStrictEqual(cleared.lcm?.fallback, choice(connection, other.id))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("planning uses the account summary model without a reply model, and fits its window", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      reader = yield* Reader
    const user = yield* api.Whoami()
    const conn = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Synthetic",
        baseUrl: "http://127.0.0.1:9/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const small = yield* api.AddUserModel({ connectionId: conn.id, key: "small", overrides: { context: 4096 } })
    const large = yield* api.AddUserModel({ connectionId: conn.id, key: "large", overrides: { context: 32000 } })
    const choice = (model: typeof small) => ({ connection: conn.id, model: model.id })
    yield* api.ChangeGenerationDefaults({ change: { summarizer: choice(small) } })
    const chat = yield* api.CreateChat({ title: "Planning" })
    yield* api.ChangeLcmSettings({ chatId: chat.id, change: { enabled: true } })
    const sent = yield* api.SendMessage({
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      content: "Synthetic rain. ".repeat(10),
      reply: false
    })
    assert.strictEqual(sent._tag, "Posted")
    if (sent._tag !== "Posted") return
    let leaf = sent.entry.slotId
    for (let i = 0; i < 80; i++) {
      const next = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: leaf,
        branch: false,
        content: `Message ${i}. ` + "Synthetic rain. ".repeat(80),
        reply: false
      })
      if (next._tag !== "Posted") return yield* Effect.die("unexpected queue")
      leaf = next.entry.slotId
    }
    const args = { userId: user.id, chatId: chat.id, leafSlotId: leaf }
    const withoutReply = yield* reader.PlanSummaries(args)
    assert.isNull(withoutReply.blocked)
    assert.isAbove(withoutReply.windowMax, 0)
    yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Model", ...choice(large) } })
    const withReply = yield* reader.PlanSummaries(args)
    assert.isAbove(withReply.windowMax, withoutReply.windowMax)
    assert.isAbove(withReply.chunks.length, 0)
    for (const chunk of withReply.chunks) assert.isAtMost(chunk.clipTokens ?? 0, 4096 - 1500)

    const root = chat.currentForkId!
    const at = leaf
    yield* api.ChangeCast({
      chatId: chat.id,
      forkId: root,
      slotId: at,
      change: { _tag: "SummaryModel", model: choice(large) }
    })
    const before = yield* api.CreateFork({ chatId: chat.id, fromForkId: root, atSlotId: null })
    const inherited = yield* api.CreateFork({ chatId: chat.id, fromForkId: root, atSlotId: at })
    const read = (forkId: typeof root, slotId: typeof at | null) => api.GetCast({ chatId: chat.id, forkId, slotId })
    assert.isUndefined((yield* read(before.fork.id, null)).summaryModel)
    assert.deepStrictEqual((yield* read(inherited.fork.id, at)).summaryModel, choice(large))
    yield* api.ChangeCast({
      chatId: chat.id,
      forkId: inherited.fork.id,
      slotId: at,
      change: { _tag: "SummaryModel", model: null }
    })
    assert.isUndefined((yield* read(inherited.fork.id, at)).summaryModel)
    assert.deepStrictEqual((yield* read(root, at)).summaryModel, choice(large))
    // Deleting a chosen summary model falls through to the account's, without blocking planning.
    const gone = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Gone",
        baseUrl: "http://127.0.0.1:9/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const missing = yield* api.AddUserModel({ connectionId: gone.id, key: "gone", overrides: {} })
    yield* api.ChangeCast({
      chatId: chat.id,
      forkId: root,
      slotId: at,
      change: { _tag: "SummaryModel", model: { connection: gone.id, model: missing.id } }
    })
    yield* api.DeleteConnection({ connectionId: gone.id })
    const recovered = yield* reader.PlanSummaries({ ...args, forkId: root })
    assert.isNull(recovered.blocked)
    assert.strictEqual(recovered.windowMax, withReply.windowMax)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
