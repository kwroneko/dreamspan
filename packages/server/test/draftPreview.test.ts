import { vi } from "vitest"

// Trap every server HTTP transport call, including an unexpected host or endpoint. A
// swallowed counting failure still fails the zero-call assertion. Ordinary send-comparison
// tests use the real transport to the loopback recorder.
const transport = vi.hoisted(() => ({ blocked: false, calls: [] as string[] }))
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>()
  return {
    ...actual,
    fetch: (...args: Parameters<typeof actual.fetch>) => {
      if (transport.blocked) {
        transport.calls.push(String(args[0]))
        return Promise.reject(new Error("Unexpected outbound HTTP during preview"))
      }
      return actual.fetch(...args)
    }
  }
})

// A chat not sent yet shows its first request (DESIGN §2.1; owner, 2026-11-12: "Make sure this
// doesn't cause anything to be sent to inference providers"). `PreviewChat` builds what the
// first send would send, through the same assembler, without writing anything or asking any
// provider anything, even with the connection's token counts set to that provider. The same
// chat, then started and replied to, sends exactly the previewed messages. Synthetic data and
// a mock provider only.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Schedule } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { readFileSync } from "node:fs"
import { importStPreset } from "../src/formats/preset.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
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
const setup = (api: Api, url: string, kind = "openai-chat", key = "mock-model") =>
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
        character_book: loreBook([
          loreEntry({
            keys: ["zeppelin"],
            vectorized: true,
            content: "An airship crosses the river.",
            decision_hint: "Is the airship relevant?"
          })
        ]).document,
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
      kind,
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
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key,
      overrides: { vision: true, tools: true }
    })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
    })
    return { mira: mira.entityId as EntityId, tobin: tobin.entityId as EntityId, connection, model }
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
        first: {
          _tag: "Send" as const,
          content: `The road flooded.${" ".repeat(8193)}Still flooded.`,
          speakerEntityId: tobin
        }
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

  it.live("includes owned first-send images without remote image counting, and rejects foreign images", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { mira, tobin } = yield* setup(api, mock.url)
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const mediaId = yield* writer.RecordMessageImage({
        userId: me.id as UserId,
        media: { sha256: "a".repeat(64) as never, mime: "image/png", byteSize: 100, width: 512, height: 512 }
      })
      const input = {
        cards: [mira],
        persona: tobin,
        greeting: null,
        replier: mira,
        first: { _tag: "Send" as const, content: "Look", speakerEntityId: tobin, images: [{ mediaId }] }
      }
      const preview = yield* api.PreviewChat(input)
      assert.isNotNull(preview.request)
      assert.isTrue(
        preview.request!.messages.some((m) => m.images?.some((image) => image.sent)),
        "the first send's image must be in its preview"
      )
      assert.isAbove(preview.imageTokens?.tokens ?? 0, 0)
      assert.lengthOf(mock.requests(), 0, "image estimates must stay local")
      assert.strictEqual(
        yield* outcome(
          api.PreviewChat({ ...input, first: { ...input.first, images: [{ mediaId: "someone-elses-image" }] } })
        ),
        "NotFound"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("refuses a greeter outside the proposed cast, as the real start does", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { mira, tobin } = yield* setup(api, mock.url)
      assert.strictEqual(
        yield* outcome(
          api.PreviewChat({
            cards: [mira],
            persona: null,
            greeting: null,
            greeters: [{ entityId: tobin, greeting: 0 }],
            first: { _tag: "Generate", speakerEntityId: mira, direction: "" }
          })
        ),
        "NotFound"
      )
      assert.lengthOf(mock.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("checks ownership of cast cards even when none greets", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { mira } = yield* setup(api, mock.url)
      assert.strictEqual(
        yield* outcome(
          api.PreviewChat({
            cards: [mira, "missing-or-foreign-card" as EntityId],
            persona: null,
            greeting: null,
            greeters: [],
            first: { _tag: "Generate", speakerEntityId: mira, direction: "" }
          })
        ),
        "NotFound"
      )
      assert.lengthOf(mock.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  for (const [kind, key] of [
    ["openai-chat", "unknown-model"],
    ["openai-chat", "gpt-4o"],
    ["openai-chat", "gpt-4"],
    ["openai-chat", "meta-llama/llama-3.1-8b-instruct"],
    ["openai-responses", "future-openai-model"],
    ["openai-chat", "qwen/qwen3-8b"],
    ["anthropic", "claude-sonnet-4-5"],
    ["google", "gemini-2.5-pro"]
  ])
    it.live(
      `zero HTTP calls for ${kind}/${key}: group, remote counts, vector lore, decisions, agents and workshop tools`,
      () =>
        Effect.gen(function* () {
          const mock = yield* mockProvider
          const api = yield* client()
          const { mira, tobin, connection, model } = yield* setup(
            api,
            key === "future-openai-model" ? "https://api.openai.com" : mock.url,
            kind,
            key
          )
          const judge = yield* api.CreateConnection({
            kind: "system-one",
            settings: {
              name: "Decision stub",
              baseUrl: `${mock.url}/decide`,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: "sk-synthetic"
          })
          const judgeModel = yield* api.AddUserModel({
            connectionId: judge.id,
            key: "typesafe/jev-1.13",
            overrides: {}
          })
          yield* api.SetDecisionSettings({
            connectionId: judge.id,
            model: judgeModel.id,
            points: { lore: { on: true, threshold: 0.5 }, presence: { on: true, threshold: 0.5 } }
          })
          const before = mock.requests().length
          const mediaId = yield* (yield* Writer).RecordMessageImage({
            userId: (yield* api.Whoami()).id as UserId,
            media: { sha256: "b".repeat(64) as never, mime: "image/png", byteSize: 100, width: 512, height: 512 }
          })
          transport.calls.length = 0
          transport.blocked = true
          const preview = yield* api.PreviewChat({
            cards: [mira, tobin],
            persona: null,
            greeting: null,
            greeters: [
              { entityId: mira, greeting: 0 },
              { entityId: tobin, greeting: 0 }
            ],
            first: {
              _tag: "Send",
              // Third-party media in the text: saved media is never looked up or fetched for a preview.
              content:
                'A zeppelin arrives. ![map](https://media.example.invalid/map.png) <img src="https://media.example.invalid/sky.webp">',
              speakerEntityId: null,
              images: [{ mediaId }]
            },
            replier: mira
          })
          assert.isNotNull(preview.request)
          assert.strictEqual(preview.imageTokens?.count, 1)
          assert.lengthOf(mock.requests(), before, "no inference, count, embedding, decision or model-list HTTP")
          assert.lengthOf(yield* api.ListChats({ limit: 10, before: null }), 0)
          // Workshops already exist when their unsent composer opens. Its estimator must stay local too,
          // story agent mode exercises the same read path. Tool-definition counting is tested separately below.
          const workshop = yield* api.CreateWorkshop({ title: "Unsent workshop" })
          yield* api.ChangeCast({
            chatId: workshop.id,
            slotId: null,
            change: { _tag: "Model", connection: connection.id, model: model.id }
          })
          const estimate = yield* api.GetNextContext({ chatId: workshop.id, leafSlotId: null })
          assert.isNotNull(estimate.budget)
          // Sized from the model's window (workctx1), with the workshop persona and tools: still local.
          assert.notStrictEqual(estimate.budget!.maximum, 4_095)
          const chat = yield* api.CreateChat({ title: "Unsent agent" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "AgentEnabled", on: true } })
          yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
          // Exercise the separate tool-definition budget counter too; the composer estimator
          // itself doesn't build a rollout or tool dispatch.
          const reader = yield* Reader
          const counting = {
            model: JSON.stringify({
              connectionId: connection.id,
              modelId: model.id,
              kind,
              key,
              api:
                kind === "anthropic"
                  ? "anthropic-messages"
                  : kind === "google"
                    ? "google-generative-ai"
                    : kind === "openai-responses"
                      ? "openai-responses"
                      : "openai-completions",
              prefill: "none",
              cacheBreakpoints: "none",
              context: 8192,
              presetOverride: null
            }),
            request: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: "Look",
                  images: [{ mediaId: "synthetic", estimate: { tokens: 100, basis: "formula" } }]
                }
              ],
              prefill: null,
              samplers: { max_tokens: 128, temperature: 1 },
              useSystemPrompt: true,
              breakpoints: [],
              names: { user: "User", char: "Assistant", group: [] }
            }),
            transcript: "[]"
          }
          const bare = yield* reader.CountRolloutContext({ ...counting, tools: "[]" })
          const withTools = yield* reader.CountRolloutContext({
            ...counting,
            tools: JSON.stringify([
              {
                name: "read_synthetic",
                description: "Read a synthetic fixture.",
                parameters: { type: "object", properties: { query: { type: "string" } } },
                effect: "read",
                label: "Read fixture"
              }
            ])
          })
          assert.isAbove(withTools, bare, "tool definitions are actually counted")
          yield* Effect.sleep("100 millis")
          assert.lengthOf(mock.requests(), before, "unsent agent/workshop estimates must never dispatch")
          assert.deepStrictEqual(transport.calls, [], "zero outbound HTTP calls, to any host")
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              transport.blocked = false
            })
          ),
          Effect.scoped,
          Effect.provide(serverLayer(testConfig()))
        )
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

  // Owner, 2026-11-24: an imported card's greeting, unchanged, was boxed "rewritten" in the
  // first request. Its CRLF line breaks go out as LF; that isn't a change to the text.
  it.live("finds an unchanged CRLF greeting with macros in its message, not marked changed", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { tobin } = yield* setup(api, mock.url)
      const me = yield* api.Whoami()
      const card = yield* (yield* Writer).CreateEntity({
        userId: me.id as UserId,
        kind: "card",
        label: "Ilse",
        subtitle: "",
        doc: cardDoc("Ilse", {
          description: "{{char}} keeps the lighthouse.",
          first_mes: '*{{char}} looks up from the lamp.* "You\'re late, {{user}}."\r\n\r\n*She sets down the oil can.* "Sit."'
        }) as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const ilse = card.entityId as EntityId
      const preview = yield* api.PreviewChat({
        cards: [ilse],
        persona: tobin,
        greeting: null,
        greeters: [{ entityId: ilse, greeting: 0 }],
        first: { _tag: "Generate", speakerEntityId: ilse, direction: "" }
      })
      const message = preview.request!.messages.find((m) => m.role === "assistant")!
      assert.strictEqual(
        message.content,
        '*Ilse looks up from the lamp.* "You\'re late, Tobin."\n\n*She sets down the oil can.* "Sit."'
      )
      assert.deepStrictEqual(message.parts, [{ start: 0, end: message.content.length, source: 0 }])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
