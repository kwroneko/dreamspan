// Real generation (ARCHITECTURE §15) over a real server, its workers and a socket, against
// local mock providers that record what they're sent: the assembled context goes out as
// assembled, the reply streams into the version, and the rollout, its snapshot and the
// ledger record it. No real keys: the Anthropic one is made up, and goes only to the mock.
import { assert, describe, it } from "@effect/vitest"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { chatCompletionsFields } from "../src/assembler/wire.ts"
import { databaseFile } from "../src/db/connection.ts"
import { client, posted, serverLayer, testConfig, takenFrom, typeInto } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import {
  anthropicSse,
  completionChunks,
  json as reply,
  type Recorded,
  sse,
  startMockProvider
} from "./support/mockProvider.ts"

/** What the database recorded for a version: its rollout, its snapshot, its ledger rows. */
const recorded = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    const version = db.prepare("SELECT * FROM version_records WHERE id = ?").get(versionId) as Record<string, unknown>
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
      assert.strictEqual(db.version.authoring_fork_id, db.rollout.fork_id)
      const body = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
      // Exactly the assembled messages and ST's samplers, through pi-ai; its own additions
      // (the model, streaming and usage) around them.
      const fields = chatCompletionsFields(db.snapshot.request, "openai-chat")
      for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(body[key], value, key)
      assert.deepStrictEqual(body.messages, [
        { role: "system", content: "Write Mira's next reply in a fictional chat between Mira and Tobin." },
        { role: "system", content: "<Tobin>\nTobin draws maps.\n</Tobin>" },
        { role: "system", content: "<Mira>\nMira keeps the ledger for Tobin.\n</Mira>" },
        { role: "system", content: "[Start a new Chat]" },
        { role: "assistant", content: "*Mira looks up.* Late again, Tobin." },
        { role: "user", content: "The road flooded." },
        // ST's default group nudge, the end-of-request message: sent last whenever the model
        // writes as a character (DESIGN §2.2).
        { role: "user", content: "[Write the next reply only as Mira.]" }
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

  it.live("fails the version with the assembly's own error class when the context can't fit", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { openai_max_context: 100, openai_max_tokens: 99 }
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "budget")
      assert.isEmpty(mock.requests())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("records what a template greeting writes at the greeting, the first time it expands", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        greeting: "{{setvar::mood::grim}}*{{char}} looks up.*",
        preset: { prompts: [{ identifier: "main", role: "system", content: "Mood: {{getvar::mood}}." }] }
      })
      assert.strictEqual(version.status, "complete")
      // A second reply reads the write back from the greeting's state, and doesn't record it again.
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const sent = mock.requests().filter((r) => r.path === "/v1/chat/completions")
      assert.strictEqual(sent.length, 2)
      for (const request of sent) {
        assert.deepStrictEqual((request.body!.messages as Array<{ content: string }>)[0]!.content, "Mood: grim.")
      }
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      try {
        const greeting = db
          .prepare("SELECT id, frozen_macros FROM version_records WHERE origin = 'greeting'")
          .get() as {
          id: string
          frozen_macros: string
        }
        assert.strictEqual(greeting.frozen_macros, "{}")
        const writes = db
          .prepare("SELECT key, value_json, origin FROM state_events WHERE version_id = ?")
          .all(greeting.id) as Array<Record<string, unknown>>
        assert.deepStrictEqual(writes, [
          { key: "var.set", value_json: JSON.stringify({ name: "mood", value: "grim" }), origin: "rollout" }
        ])
      } finally {
        db.close()
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("generates the reply to a message the send queue posts, from the context after it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      // The next reply is held until the test lets it end; a message sent meanwhile queues.
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      mock.setHandler((request, res) => void held.then(() => completion(request, res)))
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => mock.requests().length === 2)
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: entry.slotId,
        branch: false,
        content: "Wait for me."
      })
      assert.strictEqual(queued._tag, "Queued")
      release()
      yield* eventually(() => finished(events, entry.version.id)?.status === "complete")
      // The queue posts the message and starts its reply, which the real generator writes.
      yield* eventually(() => mock.requests().length === 3)
      const replies = () =>
        events.flatMap((e) =>
          e._tag === "Version" && e.version.status === "complete" && e.version.writer === "model" ? [e.version.id] : []
        )
      yield* eventually(() => new Set(replies()).size === 3)
      const last = mock.requests()[2]!.body!.messages as ReadonlyArray<{ role: string; content: string }>
      assert.deepStrictEqual(last.slice(-4), [
        { role: "assistant", content: "The ledger says otherwise." },
        { role: "assistant", content: "The ledger says otherwise." },
        { role: "user", content: "Wait for me." },
        { role: "user", content: "[Write the next reply only as Mira.]" }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("generates a reply queued from the composer after a branch switch, on the branch switched to", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const bottom = () =>
        Effect.map(
          api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }),
          (window) => window.entries
        )
      const [greeting, message] = yield* bottom()
      // Another branch from the greeting, then back to the first.
      const other = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: greeting!.slotId,
          branch: true,
          content: "Take the hill road."
        })
      )
      const switched = yield* api.SwitchBranch({ chatId: chat.id, slotId: other.entry.slotId, index: 0 })
      assert.strictEqual(switched.slotId, message!.slotId)
      assert.strictEqual(switched.fork.tipSlotId, version.slotId)

      // A reply there, held; a Generate from the composer onto it queues and commits the composer.
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      mock.setHandler((request, res) => void held.then(() => completion(request, res)))
      const { entry } = yield* posted(
        api.Generate({ chatId: chat.id, forkId: switched.fork.id, parentSlotId: version.slotId, branch: false })
      )
      yield* eventually(() => mock.requests().length === 2)
      const draft = yield* typeInto(api, chat.id, switched.fork.id, "Make it rain.")
      const queued = yield* api.Generate({
        chatId: chat.id,
        forkId: switched.fork.id,
        parentSlotId: entry.slotId,
        branch: false,
        direction: "Make it rain.",
        composer: takenFrom(draft)
      })
      assert.strictEqual(queued._tag, "Queued")
      assert.strictEqual(queued.draft?.status, "committed")
      release()
      yield* eventually(() => finished(events, entry.version.id)?.status === "complete")
      yield* eventually(() => mock.requests().length === 3)
      const tip = () => Effect.map(api.GetChat({ chatId: chat.id }), (c) => c.activeLeafSlotId)
      let leaf = yield* tip()
      while (leaf === entry.slotId) {
        yield* Effect.sleep(10)
        leaf = yield* tip()
      }
      // On the branch switched to, with its composer gone along and nothing left to resend.
      const path = yield* bottom()
      assert.deepStrictEqual(
        path.map((e) => [e.slotId === message!.slotId, e.branchIndex, e.branchCount]).slice(0, 2),
        [
          [false, 0, 1],
          [true, 0, 2]
        ]
      )
      assert.strictEqual(path.at(-1)!.slotId, leaf)
      assert.strictEqual(path.at(-1)!.version.direction, "Make it rain.")
      const moved = yield* api.OpenComposer({ chatId: chat.id, forkId: switched.fork.id })
      assert.deepStrictEqual([moved.id, moved.status, moved.content], [draft.id, "committed", ""])
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
      // The reply is what the model wrote: ST sends the prefill, and saves only the response.
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
          "Write Mira's next reply in a fictional chat between Mira and Tobin.\n\n<Tobin>\nTobin draws maps.\n</Tobin>\n\n" +
            "<Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n\n[Start a new Chat]"
        ]
      )
      assert.deepStrictEqual(
        body.messages.map((m) => [m.role, m.content.map((c) => c.text).join("")]),
        [
          ["assistant", "*Mira looks up.* Late again, Tobin."],
          ["user", "The road flooded."],
          // The group nudge, the end-of-request message, right before the prefill.
          ["user", "[Write the next reply only as Mira.]"],
          ["assistant", "*Mira sighs.*"]
        ]
      )
      assert.deepInclude(body, { top_p: 0.8, top_k: 40 })
      // The history breakpoint, on the user's message, besides pi-ai's own markers.
      assert.isDefined(body.messages[1]!.content.at(-1)!.cache_control)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
