// Generation at the edges (ARCHITECTURE §15), over a real server and local mock providers
// (no real keys): samplers on the APIs ST maps them for, and a stop at any moment.
import { assert, describe, it } from "@effect/vitest"
import { type Chat, type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ModelOverrides } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { databaseFile } from "../src/db/connection.ts"
import { Writer } from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const cardDoc = (name: string, description: string): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description } }))).card

const presetDoc = (fields: Record<string, unknown>) =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, ...fields })).document!

/** A chat with Mira, greeted, with the user's message sent; nothing generated yet. */
const setup = (
  api: Api,
  options: {
    readonly connection: { readonly kind: string; readonly baseUrl: string; readonly apiKey?: string }
    readonly key?: string
    readonly model?: ModelOverrides
    readonly preset?: Record<string, unknown>
  }
) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const userId = me.id as UserId
    const connection = yield* api.CreateConnection({
      kind: options.connection.kind,
      settings: {
        name: "Mock",
        baseUrl: options.connection.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      ...(options.connection.apiKey ? { apiKey: options.connection.apiKey } : {})
    })
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: options.key ?? "mock-model",
      overrides: options.model ?? {}
    })
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
    const mira = yield* entity("card", "Mira", cardDoc("Mira", "{{char}} keeps the ledger."))
    const preset = yield* entity("preset", "Preset", presetDoc(options.preset ?? {}))
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
    })
    const chat: Chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Ledger",
      participants: [mira.entityId as EntityId],
      greeting: new NewVersion({
        speakerEntityId: mira.entityId as EntityId,
        writer: "model",
        content: "Late again.",
        status: "complete",
        macroMode: "template",
        origin: "greeting"
      })
    })
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "The road flooded."
      })
    )
    return { chat, parent: sent.entry.slotId as SlotId }
  })

const waitFor = (check: () => boolean, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["ok"], { prompt_tokens: 10, completion_tokens: 1 }))

const mockWith = (handler: Parameters<typeof startMockProvider>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

describe("generation at the edges", () => {
  it.live("Google: the model's top_p and top_k reach generationConfig", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith((_r, res) => {
        res.writeHead(500)
        res.end()
      })
      const api = yield* client()
      const { chat, parent } = yield* setup(api, {
        connection: { kind: "google", baseUrl: mock.url, apiKey: "made-up-google-key-0000" },
        model: { settings: { samplers: { top_p: 0.5, top_k: 40, temperature: 0.7 } } }
      })
      yield* api.Generate({ chatId: chat.id, parentSlotId: parent, branch: false })
      yield* waitFor(() => mock.requests().some((r) => r.body !== null))
      const body = mock.requests().find((r) => r.body !== null)!.body!
      assert.deepInclude(body.generationConfig as object, { temperature: 0.7, topP: 0.5, topK: 40 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("o3 on OpenAI: one max-tokens field, the model's", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(completion)
      const api = yield* client()
      const { chat, parent } = yield* setup(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        key: "o3-mini",
        model: { settings: { samplers: { openai_max_tokens: 333 } } }
      })
      yield* api.Generate({ chatId: chat.id, parentSlotId: parent, branch: false })
      yield* waitFor(() => mock.requests().some((r) => r.path === "/v1/chat/completions"))
      const body = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
      assert.strictEqual(body.max_completion_tokens, 333)
      assert.notProperty(body, "max_tokens")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "stopping right after Generate never leaves a rollout running",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        // The provider never answers, so every generation is stopped by the user.
        const mock = yield* mockWith(() => new Promise<void>(() => {}))
        const api = yield* client()
        const { chat, parent } = yield* setup(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` } })
        // Stops land before the rollout opens, while it opens, and after.
        for (let i = 0; i < 40; i++) {
          const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: parent, branch: true }))
          yield* Effect.sleep(i % 8)
          yield* Effect.exit(api.StopGeneration({ versionId: entry.version.id }))
        }
        // A stop that lost the race with a generation still starting lets it end on its own.
        yield* Effect.sleep(1500)
        const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
        const rows = db
          .prepare(
            `SELECT r.status AS rollout, v.status AS version, count(*) AS n FROM rollouts r
           JOIN versions v ON v.rollout_id = r.id GROUP BY 1, 2`
          )
          .all()
        db.close()
        assert.isFalse(rows.some((r) => r.rollout === "running" && r.version !== "generating"))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )
})
