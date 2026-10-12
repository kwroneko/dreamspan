// Real generation (ARCHITECTURE §13) over a real server, its workers and a socket, against
// local mock providers that record what they're sent: the assembled context goes out as
// assembled, the reply streams into the version, and the rollout, its snapshot and the
// ledger record it. No real keys: the Anthropic one is made up, and goes only to the mock.
import { assert, describe, it } from "@effect/vitest"
import { type Chat, type EntityId, NewVersion, type VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ModelOverrides } from "@rp/shared/providers.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect, Stream } from "effect"
import { DatabaseSync } from "node:sqlite"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { chatCompletionsFields } from "../src/assembler/wire.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Writer } from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import {
  anthropicSse,
  completionChunks,
  json as reply,
  type Recorded,
  sse,
  startMockProvider
} from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const cardDoc = (name: string, description: string): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description } }))).card

const presetDoc = (fields: Record<string, unknown>) =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, ...fields })).document!

const eventually = (check: () => boolean, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

const finished = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  events.flatMap((e) => (e._tag === "Version" && e.version.id === versionId ? [e.version] : [])).at(-1)

/** A chat with Mira and the user as Tobin, greeted, the user's message sent, and a reply generated. */
const generateReply = (
  api: Api,
  options: {
    readonly connection: { readonly kind: string; readonly baseUrl: string; readonly apiKey?: string }
    readonly model: ModelOverrides
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
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "mock-model", overrides: options.model })
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
    const mira = yield* entity("card", "Mira", cardDoc("Mira", "{{char}} keeps the ledger for {{user}}."))
    const tobin = yield* entity("card", "Tobin", cardDoc("Tobin", "{{user}} draws maps."))
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
        content: "*{{char}} looks up.* Late again, {{user}}.",
        status: "complete",
        macroMode: "template",
        origin: "greeting"
      })
    })
    const state = (data: StateEventData) =>
      writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
    yield* state({ key: "played_by_me.set", value: { entities: [tobin.entityId as EntityId] } })
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const sent = yield* api.SendMessage({
      chatId: chat.id,
      parentSlotId: chat.activeLeafSlotId,
      branch: false,
      content: "The road flooded."
    })
    const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    return { version: finished(events, entry.version.id)!, chat, connection, model }
  })

/** What the database recorded for a version: its rollout, its snapshot, its ledger rows. */
const recorded = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    const version = db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as Record<string, unknown>
    const rollout = db.prepare("SELECT * FROM rollouts WHERE id = ?").get(version.rollout_id as string) as Record<
      string,
      unknown
    >
    const payload = db
      .prepare("SELECT context_snapshot_json FROM rollout_payloads WHERE rollout_id = ?")
      .get(version.rollout_id as string) as { context_snapshot_json: string }
    const requests = db.prepare("SELECT * FROM llm_requests WHERE version_id = ?").all(versionId) as Array<
      Record<string, unknown>
    >
    return { version, rollout, snapshot: JSON.parse(payload.context_snapshot_json) as ContextSnapshot, requests }
  } finally {
    db.close()
  }
}

const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["The ledger ", "says otherwise."], { prompt_tokens: 120, completion_tokens: 6 }))

describe("generation", () => {
  it.live("sends the assembled context to an OpenAI-compatible model and records the run", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, connection, model } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { temperature: 0.7, top_p: 0.9, seed: 42, assistant_prefill: "Hm." }
      })
      assert.strictEqual(version.status, "complete")
      assert.strictEqual(version.content, "The ledger says otherwise.")

      const db = recorded(config.dataDir, version.id)
      const body = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
      // Exactly the assembled messages and ST's samplers, through pi-ai; its own additions
      // (the model, streaming and usage) around them.
      const fields = chatCompletionsFields(db.snapshot.request, "openai-chat")
      for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(body[key], value, key)
      assert.deepStrictEqual(body.messages, [
        { role: "system", content: "Write Mira's next reply in a fictional chat between Mira and Tobin." },
        { role: "system", content: "Tobin draws maps." },
        { role: "system", content: "Mira keeps the ledger for Tobin." },
        { role: "system", content: "[Start a new Chat]" },
        { role: "assistant", content: "*Mira looks up.* Late again, Tobin." },
        { role: "user", content: "The road flooded." }
      ])
      assert.deepInclude(body, { model: "mock-model", stream: true, temperature: 0.7, top_p: 0.9, seed: 42 })
      assert.notProperty(body, "max_completion_tokens")
      // The model isn't known to take a prefill, so it was dropped and that's recorded.
      assert.deepStrictEqual(
        db.snapshot.issues.map((i) => i.kind),
        ["prefill_dropped"]
      )

      assert.strictEqual(db.version.connection_id, connection.id)
      assert.strictEqual(db.version.model_id, model.id)
      assert.deepInclude(JSON.parse(db.version.usage_json as string), { requests: 1, output: 6 })
      assert.deepInclude(db.rollout, {
        status: "completed",
        kind: "generation",
        llm_requests: 1,
        usage_output_tokens: 6
      })
      assert.strictEqual(db.requests.length, 1)
      assert.deepInclude(db.requests[0]!, { rollout_id: db.rollout.id, purpose: "generation", status: "complete" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("fails the version with the provider's error, and the rollout with it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => reply(res, 400, { error: { message: "context too odd" } }))
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "bad_request")
      const db = recorded(config.dataDir, version.id)
      assert.deepInclude(db.rollout, { status: "failed", llm_requests: 1 })
      assert.include(String(db.rollout.error), "context too odd")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("sends Anthropic the system prompt, the prefill and the cache breakpoints", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            anthropicSse(res, [
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "mock-model",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 10, output_tokens: 1 }
                }
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " she says." } },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 3 }
              },
              { type: "message_stop" }
            ])
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
        model: { prefill: "assistant", cacheBreakpoints: "explicit" },
        preset: { use_sysprompt: true, assistant_prefill: "*{{char}} sighs.*", top_p: 0.8, top_k: 40 }
      })
      assert.strictEqual(
        version.status,
        "complete",
        JSON.stringify([version.error, mock.requests().map((r) => r.path)])
      )
      assert.strictEqual(version.content, " she says.")
      const body = mock.requests().find((r) => r.path.startsWith("/v1/messages"))!.body! as {
        system: ReadonlyArray<{ text: string }>
        messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ text: string; cache_control?: unknown }> }>
        top_p: number
        top_k: number
      }
      assert.deepStrictEqual(
        body.system.map((block) => block.text),
        [
          "Write Mira's next reply in a fictional chat between Mira and Tobin.\n\nTobin draws maps.\n\n" +
            "Mira keeps the ledger for Tobin.\n\n[Start a new Chat]"
        ]
      )
      assert.deepStrictEqual(
        body.messages.map((m) => [m.role, m.content.map((c) => c.text).join("")]),
        [
          ["assistant", "*Mira looks up.* Late again, Tobin."],
          ["user", "The road flooded."],
          ["assistant", "*Mira sighs.*"]
        ]
      )
      assert.deepInclude(body, { top_p: 0.8, top_k: 40 })
      // The history breakpoint, on the user's message, besides pi-ai's own markers.
      assert.isDefined(body.messages[1]!.content.at(-1)!.cache_control)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
