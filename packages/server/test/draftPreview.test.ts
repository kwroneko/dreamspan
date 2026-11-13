// A chat not sent yet shows its first request (DESIGN §2.1; owner, 2026-11-12: "Make sure this
// doesn't cause anything to be sent to inference providers"). `PreviewChat` builds what the
// first send would send, through the same assembler, without writing anything or asking any
// provider anything, even with the connection's token counts set to that provider. The same
// chat, then started and replied to, sends exactly the previewed messages. Synthetic data and
// a mock provider only.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schedule } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { readFileSync } from "node:fs"
import { importStPreset } from "../src/formats/preset.ts"
import { cardDoc } from "./support/docs.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The ledger ", "balances."], { prompt_tokens: 120, completion_tokens: 4 }))
    )
  ),
  (m) => Effect.promise(() => m.close())
)

/** Mira (greeting with alternates), Tobin as the user's persona, a preset, and a model counted by its own provider. */
const setup = (api: Api, url: string) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const userId = me.id as UserId
    const entity = (kind: "card" | "preset", label: string, doc: object) =>
      writer.CreateEntity({
        userId,
        kind,
        label,
        subtitle: "",
        doc: doc as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const mira = yield* entity(
      "card",
      "Mira",
      cardDoc("Mira", {
        description: "{{char}} keeps the ledger for {{user}}.",
        first_mes: "*{{char}} looks up.* Late again, {{user}}.",
        alternate_greetings: ["Mira waves at {{user}}."]
      })
    )
    const tobin = yield* entity("card", "Tobin", cardDoc("Tobin", { description: "{{user}} draws maps." }))
    yield* writer.SetEntityTags({ userId, entityId: tobin.entityId, tags: ["persona"] })
    // ST's default preset: its chat history marker sends the greeting and the message.
    const preset = yield* entity(
      "preset",
      "Preset",
      importStPreset(readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))).document!
    )
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Mock",
        baseUrl: `${url}/v1`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-synthetic"
    })
    // Counting with the provider is on: a preview still counts locally.
    yield* api.SetTokenCounting({ connectionId: connection.id, via: connection.id })
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "mock-model", overrides: {} })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
    })
    return { mira: mira.entityId as EntityId, tobin: tobin.entityId as EntityId }
  })

/** A reply's context once its rollout has recorded it. */
const sentContext = (api: Api, versionId: Parameters<Api["GetRunContext"]>[0]["versionId"]) =>
  api.GetRunContext({ versionId }).pipe(
    // Its messages once the request was sent and recorded.
    Effect.filterOrFail((run) => run.messages.length > 0 && run.capture !== "unavailable"),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 })
  )

const shape = (messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>) =>
  messages.map((m) => ({ role: m.role, content: m.content }))

describe("a chat not sent yet", () => {
  it.live("previews Send's request without writing or sending anything, and the send matches it", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { mira, tobin } = yield* setup(api, mock.url)
      const input = {
        cards: [mira],
        persona: tobin,
        greeting: null,
        greeters: [{ entityId: mira, greeting: 1 }],
        first: { _tag: "Send" as const, content: "The road flooded.", speakerEntityId: tobin }
      }
      const preview = yield* api.PreviewChat({ ...input, replier: mira })
      assert.isNull(preview.assemblyError ?? null)
      assert.isNotNull(preview.request)
      const messages = shape(preview.request!.messages)
      const text = JSON.stringify(messages)
      assert.include(text, "Mira waves at Tobin.", "the greeting picked, its macros expanded")
      assert.notInclude(text, "Late again", "not the greeting not picked")
      assert.include(text, "The road flooded.")
      assert.include(text, "Mira keeps the ledger for Tobin.")
      assert.isAbove(preview.budget?.countedInput ?? 0, 0)
      assert.isFalse(preview.request!.tokenizer?.exact ?? false, "counted locally")

      // Nothing reached the provider, and no chat was made.
      yield* Effect.sleep("1500 millis")
      assert.lengthOf(mock.requests(), 0, JSON.stringify(mock.requests().map((r) => r.path)))
      const chats = yield* api.ListChats({ limit: 10, before: null })
      assert.lengthOf(chats, 0)

      // The same chat, started and replied to, as the client does after a first send.
      const started = yield* api.StartChat(input)
      const reply = yield* posted(
        api.Generate({
          chatId: started.chat.id,
          parentSlotId: started.entry.slotId,
          branch: false,
          speakerEntityId: mira
        })
      )
      const sent = yield* sentContext(api, reply.entry.version.id)
      assert.deepStrictEqual(messages, shape(sent.messages))
      const body = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body as {
        messages: ReadonlyArray<unknown>
      }
      assert.deepStrictEqual(messages, body.messages)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("with an empty box, previews Generate's request, which the first reply sends", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { mira, tobin } = yield* setup(api, mock.url)
      const input = {
        cards: [mira],
        persona: tobin,
        greeting: null,
        greeters: [{ entityId: mira, greeting: 0 }],
        first: { _tag: "Generate" as const, speakerEntityId: mira, direction: "" }
      }
      const preview = yield* api.PreviewChat(input)
      assert.isNotNull(preview.request)
      const messages = shape(preview.request!.messages)
      assert.include(JSON.stringify(messages), "Late again, Tobin.")
      yield* Effect.sleep("500 millis")
      assert.lengthOf(mock.requests(), 0)

      const started = yield* api.StartChat(input)
      const sent = yield* sentContext(api, started.entry.version.id)
      assert.deepStrictEqual(messages, shape(sent.messages))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("without a model builds nothing, even for a greeting too big to build quickly", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const crowd = yield* writer.CreateEntity({
        userId: me.id as UserId,
        kind: "card",
        label: "Crowd",
        subtitle: "",
        doc: cardDoc("Crowd", {
          first_mes: "{{random::x{{space::262145}}x}}",
          alternate_greetings: Array.from({ length: 1000 }, (_, i) => `Alternate ${i} at {{time}}`)
        }) as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const id = crowd.entityId as EntityId
      const started = Date.now()
      const preview = yield* api.PreviewChat({
        cards: [id],
        persona: null,
        greeting: null,
        greeters: [{ entityId: id, greeting: 0 }],
        first: { _tag: "Send", content: "Hello", speakerEntityId: null },
        replier: id
      })
      assert.isNull(preview.request)
      assert.isNull(preview.model ?? null)
      assert.isBelow(Date.now() - started, 10_000)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
