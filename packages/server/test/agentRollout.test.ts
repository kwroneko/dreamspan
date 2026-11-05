// Agent rollouts (spec/AGENTIC.md §3): a pi-agent-core loop over the frozen request, against a
// scripted OpenAI-compatible mock that calls a tool and then answers. The version's text is the
// final turn's; the transcript is flushed with every turn; the snapshot freezes the tools.
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@rp/shared/chat.ts"
import { Effect, Fiber } from "effect"
import { DatabaseSync } from "node:sqlite"
import type { ServerResponse } from "node:http"
import { databaseFile } from "../src/db/connection.ts"
import { SEND_NUDGE, WRITE_NOW } from "../src/agent/session.ts"
import { agentInstructions } from "../src/agent/modes.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { Reader } from "../src/db/Database.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const read = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    const version = db.prepare("SELECT rollout_id FROM versions WHERE id = ?").get(versionId) as { rollout_id: string }
    const rollout = db.prepare("SELECT * FROM rollouts WHERE id = ?").get(version.rollout_id) as Record<string, unknown>
    const payload = db
      .prepare("SELECT context_snapshot_json, transcript_json FROM rollout_payloads WHERE rollout_id = ?")
      .get(version.rollout_id) as { context_snapshot_json: string; transcript_json: string | null }
    const requests = db.prepare("SELECT status FROM llm_requests WHERE rollout_id = ?").all(version.rollout_id)
    return {
      rollout,
      snapshot: JSON.parse(payload.context_snapshot_json) as Record<string, unknown>,
      transcript: JSON.parse(payload.transcript_json ?? "null") as Array<Record<string, unknown>> | null,
      requests
    }
  } finally {
    db.close()
  }
}

const toolCallChunks = (name: string, args: unknown, text = "", id = "call_1") => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(text ? { content: text } : {}),
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: { prompt_tokens: 90, completion_tokens: 5 }
  }
]

/** A read tool the test registers: what the lighthouse keeper's name is. */
const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  summarize: ({ topic }) => topic,
  execute: (_context, { topic }) => Effect.succeed({ text: `The ${topic} keeper is called Ansel.` })
}

/** Turn 1 calls the tool (after a sentence that isn't the reply); turn 2 answers. */
const scripted = (request: Recorded, res: ServerResponse) => {
  const messages = (request.body?.messages ?? []) as Array<{ role: string }>
  if (!request.body?.tools) sse(res, completionChunks(["A plain reply."], { prompt_tokens: 80, completion_tokens: 3 }))
  else if (messages.at(-1)?.role === "tool") {
    sse(res, completionChunks(["Ansel waves ", "from the lighthouse."], { prompt_tokens: 120, completion_tokens: 6 }))
  } else sse(res, toolCallChunks("look_up", { topic: "lighthouse" }, "Let me check."))
}

describe("agent rollouts", () => {
  for (const turnCap of [1, 2]) {
    it.live(`the cap (${turnCap}) uses Write now even when send_message needs a nudge`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const registry = yield* ExecutionRegistry
        yield* registry.orchestrationModes.register({
          ...registry.orchestrationModes.get("narrator")!,
          plan: () => ({ strategy: "agent", tools: [], contract: "send_message", turnCap })
        })
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Done."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
        })
        const bodies = mock
          .requests()
          .filter((r) => r.path === "/v1/chat/completions")
          .map((r) => r.body!)
        assert.strictEqual(bodies.length, turnCap)
        const last = bodies.at(-1)!
        assert.deepStrictEqual((last.messages as Array<unknown>).at(-1), { role: "user", content: WRITE_NOW })
        assert.isEmpty((last.tools as Array<unknown> | undefined) ?? [])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })
  }

  it.live("send_message uses the same reply-section parser as plain replies", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, toolCallChunks("send_message", { message: "<think>Plan.</think>\n\nAnsel waves." }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Ansel waves.")
      assert.deepStrictEqual(
        version.replySections?.sections.map((s) => s.text),
        ["Plan."]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Continue in an agentic chat uses a plain prefilled turn", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => sse(res, toolCallChunks("send_message", { message: "Hello" })))
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" },
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      mock.setHandler((request, res) =>
        sse(
          res,
          request.body?.tools
            ? toolCallChunks("send_message", { message: "WRONG" })
            : completionChunks([" continued."], {})
        )
      )
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const continued = yield* api.ContinueVersion({ versionId: version.id, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      assert.strictEqual(finished(events, continued.version.id)!.content, "Hello continued.")
      const body = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .at(-1)!.body!
      assert.notProperty(body, "tools")
      assert.deepStrictEqual((body.messages as Array<unknown>).at(-1), { role: "assistant", content: "Hello" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a stop during text retains the partial assistant turn in the transcript", () => {
    const config = testConfig()
    let streaming = false
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            if (!streaming) return sse(res, completionChunks(["Hi."], {}))
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write(`data: ${JSON.stringify(completionChunks(["Partial reply."], {})[0])}\n\n`)
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      streaming = true
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() =>
        events.some((e) => e._tag === "Delta" && e.versionId === swipe.version.id && e.text.includes("Partial reply."))
      )
      yield* api.StopGeneration({ versionId: swipe.version.id })
      const saved = read(config.dataDir, swipe.version.id)
      const tail = saved.transcript!.at(-1)!
      assert.strictEqual(tail.stopReason, "aborted")
      assert.deepStrictEqual(tail.content, [{ type: "text", text: "Partial reply." }])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("card swap preserves the speaking card's example dialogue", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => sse(res, toolCallChunks("send_message", { message: "Hi." })))
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        example: "<START>\n{{user}}: What is that?\n{{char}}: The lighthouse gleams.",
        state: [{ key: "orchestration.mode", value: { mode: "card-swap" } }]
      })
      const messages = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!.messages
      assert.include(JSON.stringify(messages), "The lighthouse gleams.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("card swap budgets the tail card before sending a request", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => sse(res, toolCallChunks("send_message", { message: "Hi." })))
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { context: 2000 },
        preset: { openai_max_context: 2000, openai_max_tokens: 100 },
        mira: { description: "A long synthetic character description. ".repeat(500) },
        state: [{ key: "orchestration.mode", value: { mode: "card-swap" } }]
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "budget")
      assert.isEmpty(mock.requests())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("persists a pending tool call before its effect can commit", () => {
    const config = testConfig()
    let durable = false
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register({
        ...lookup,
        execute: (context: { versionId: VersionId }) =>
          Effect.sync(() => {
            const transcript = read(config.dataDir, context.versionId).transcript
            durable =
              transcript?.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("call_1")) ?? false
            return { text: "Found it." }
          })
      } as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "orchestration.mode", value: { mode: "narrator" } },
          { key: "agent.tools", value: { tools: ["look_up"] } }
        ]
      })
      assert.isTrue(durable, "a crash after the effect must retain its tool call ID for receipt replay")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("stopping an agent interrupts its running tool and flushes the transcript", () => {
    const config = testConfig()
    let blocked = false
    let started = false
    let interrupted = false
    let release = () => {}
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register({
        ...lookup,
        execute: () =>
          Effect.callback<{ text: string }>((resume) => {
            started = true
            release = () => resume(Effect.succeed({ text: "Released." }))
            return Effect.sync(() => {
              interrupted = true
            })
          })
      } as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, blocked ? toolCallChunks("look_up", { topic: "lighthouse" }) : completionChunks(["Hi."], {}))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "orchestration.mode", value: { mode: "narrator" } },
          { key: "agent.tools", value: { tools: ["look_up"] } }
        ]
      })
      blocked = true
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => started)
      const requestsBeforeStop = mock.requests().length
      const stopping = yield* api.StopGeneration({ versionId: swipe.version.id }).pipe(Effect.forkScoped)
      // Release even on the old broken implementation, so the reproduction cannot hang the suite.
      yield* eventually(() => interrupted, 2000).pipe(Effect.catchCause(() => Effect.void))
      release()
      yield* Fiber.join(stopping)
      assert.isTrue(interrupted)
      assert.strictEqual(mock.requests().length, requestsBeforeStop, "Stop cannot start another provider request")
      const saved = read(config.dataDir, swipe.version.id)
      assert.strictEqual(saved.rollout.status, "stopped")
      assert.isNotEmpty(saved.transcript)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("send_message waits for complete, validated arguments before publishing the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (_request, res) => {
            const delta = (args: string, first: boolean) => ({
              id: "cmpl-stream",
              object: "chat.completion.chunk",
              model: "served-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(first ? { role: "assistant" } : {}),
                    tool_calls: [
                      {
                        index: 0,
                        ...(first ? { id: "call_1", type: "function" } : {}),
                        function: { ...(first ? { name: "send_message" } : {}), arguments: args }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write(`data: ${JSON.stringify(delta('{"message":"Ansel', true))}\n\n`)
            // Let the first network fragment reach the agent before the rest arrives.
            await new Promise((resolve) => setTimeout(resolve, 100))
            for (const event of [
              delta(' waves."}', false),
              {
                id: "cmpl-stream",
                object: "chat.completion.chunk",
                model: "served-model",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
              }
            ])
              res.write(`data: ${JSON.stringify(event)}\n\n`)
            res.end("data: [DONE]\n\n")
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Ansel waves.")
      const snapshot = read(config.dataDir, version.id).snapshot.agent as { tools: Array<{ name: string }> }
      assert.include(
        snapshot.tools.map((t) => t.name),
        "send_message",
        "the contract tool is frozen too"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("final_text never publishes an unoffered send_message call", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: [], contract: "final_text", turnCap: 4 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body?.messages as Array<{ role: string }>
            sse(
              res,
              messages.at(-1)?.role === "tool"
                ? completionChunks(["The final reply."], {})
                : toolCallChunks("send_message", { message: "Unoffered." })
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "The final reply.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the last request cannot execute tools even if the provider calls one", () => {
    const config = testConfig()
    let executions = 0
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register({
        ...lookup,
        execute: () =>
          Effect.sync(() => {
            executions++
            return { text: "Found it." }
          })
      } as RolloutTool<never>)
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: ["look_up"], contract: "both", turnCap: 2 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => sse(res, toolCallChunks("look_up", { topic: "lighthouse" })))
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(executions, 1)
      assert.strictEqual(mock.requests().filter((r) => r.path === "/v1/chat/completions").length, 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("agent final text works on a schema-prefill model with a preset prefill", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Done."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "tool_schema" },
        preset: { assistant_prefill: "Hm." },
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.status, "complete")
      assert.strictEqual(version.content, "Done.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("runs the loop over the frozen request and keeps the final turn as the message", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: ["look_up"], contract: "final_text", turnCap: 4 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { assistant_prefill: "Hm." },
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.status, "complete")
      // The sentence before the tool call was intermediate output, not the reply.
      assert.strictEqual(version.content, "Ansel waves from the lighthouse.")
      assert.isTrue(
        events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.replace === true),
        "the body started over when the turn turned out to call a tool"
      )

      const bodies = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      assert.strictEqual(bodies.length, 2)
      const [first, second] = bodies as [Record<string, unknown>, Record<string, unknown>]
      const firstMessages = first.messages as Array<Record<string, unknown>>
      const secondMessages = second.messages as Array<Record<string, unknown>>
      // The frozen prefix is sent exactly, again, then the rollout's own turns after it.
      assert.deepStrictEqual(secondMessages.slice(0, firstMessages.length), firstMessages)
      assert.deepStrictEqual(secondMessages.slice(firstMessages.length), [
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "look_up", arguments: '{"topic":"lighthouse"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "The lighthouse keeper is called Ansel." }
      ])
      assert.strictEqual(firstMessages.at(-1)?.role, "user", "no prefill on a turn that may call tools")
      assert.deepStrictEqual(
        (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
        ["look_up"]
      )

      const db = read(config.dataDir, version.id)
      assert.deepInclude(db.rollout, { status: "completed", mode: "narrator", step_count: 1, llm_requests: 2 })
      assert.strictEqual(db.requests.length, 2)
      assert.deepStrictEqual(db.snapshot.agent, {
        mode: "narrator",
        contract: "final_text",
        turnCap: 4,
        tools: [
          {
            name: "look_up",
            description: "Looks up a detail of the story.",
            parameters: lookup.parameters,
            effect: "read",
            label: "Looked something up"
          }
        ]
      })
      const roles = db.transcript!.map((m) => m.role)
      assert.deepStrictEqual(
        roles.filter((r) => r !== "system"),
        ["rpRequest", "assistant", "toolResult", "assistant"]
      )

      // The run inspector's view: the offered tools and every turn after the request, verbatim.
      const run = yield* api.GetRunTranscript({ versionId: version.id })
      assert.deepStrictEqual(run.tools, [
        {
          name: "look_up",
          label: "Looked something up",
          description: "Looks up a detail of the story.",
          parameters: lookup.parameters,
          effect: "read"
        }
      ])
      assert.deepStrictEqual(
        run.entries.map((e) => (e.role === "assistant" ? { role: e.role, parts: e.parts } : e)),
        [
          {
            role: "assistant",
            parts: [
              { type: "text", text: "Let me check." },
              { type: "toolCall", id: "call_1", name: "look_up", args: { topic: "lighthouse" } }
            ]
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            tool: "look_up",
            text: "The lighthouse keeper is called Ansel.",
            isError: false
          },
          { role: "assistant", parts: [{ type: "text", text: "Ansel waves from the lighthouse." }] }
        ]
      )
      // A reply is reached from its message, never listed as Activity.
      assert.deepStrictEqual(yield* api.ListActivity({ chatId: chat.id }), { rows: [], before: null })
      // The settings list the registered tool, its label standing in for a missing explanation.
      const modes = yield* api.ListReplyModes({})
      assert.deepInclude(modes.tools, {
        id: "look_up",
        label: "Looked something up",
        explanation: "Looked something up",
        effect: "read"
      })
      assert.deepInclude(
        modes.modes.map((m) => ({ id: m.id, agentic: m.agentic })),
        { id: "plain", agentic: false }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("plain chats keep the single provider turn", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      assert.strictEqual(version.content, "A plain reply.")
      assert.notProperty(mock.requests()[0]!.body!, "tools")
      const db = read(config.dataDir, version.id)
      assert.deepInclude(db.rollout, { mode: null, step_count: 0 })
      assert.isNull(db.transcript)
      assert.notProperty(db.snapshot, "agent")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a mode that isn't registered fails the reply before any request", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "council" } }]
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "unavailable")
      assert.include(version.error?.message ?? "", "council")
      assert.isEmpty(mock.requests())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("send_message: the call's message is the reply, and it ends the loop", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: ["look_up"], contract: "send_message", turnCap: 6 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = (request.body?.messages ?? []) as Array<{ role: string }>
            if (messages.at(-1)?.role === "tool")
              sse(res, toolCallChunks("send_message", { message: "Ansel waves." }, "", "call_2"))
            else sse(res, toolCallChunks("look_up", { topic: "lighthouse" }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.status, "complete")
      assert.strictEqual(version.content, "Ansel waves.")
      assert.deepStrictEqual(version.steps?.count, 1)
      const bodies = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      assert.strictEqual(bodies.length, 2, "the sent message ended the loop")
      assert.deepStrictEqual(
        (bodies[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
        ["look_up", "send_message"]
      )
      // The live steps: the call running, then done with its result; the message's call isn't one.
      const live = events.flatMap((e) => (e._tag === "Steps" && e.versionId === version.id ? [e.steps] : []))
      assert.isNotEmpty(live)
      const step = {
        kind: "tool",
        id: "call_1",
        tool: "look_up",
        label: "Looked something up",
        title: "“lighthouse”",
        args: { topic: "lighthouse" },
        status: "done",
        result: "The lighthouse keeper is called Ansel.",
        effect: "read"
      } as const
      assert.deepStrictEqual(live.at(-1), [step])
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [step])
      assert.deepInclude(read(config.dataDir, version.id).rollout, { step_count: 1, llm_requests: 2 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("send_message: a reply written as text is asked once to be sent", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: [], contract: "send_message", turnCap: 6 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown }>
            if (messages.at(-1)?.content === SEND_NUDGE)
              sse(res, toolCallChunks("send_message", { message: "Sent words." }))
            else sse(res, completionChunks(["Plain ", "words."], { prompt_tokens: 80, completion_tokens: 3 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Sent words.")
      assert.isTrue(events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.replace === true))
      const bodies = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      assert.strictEqual(bodies.length, 2)
      const tail = (bodies[1]!.messages as Array<Record<string, unknown>>).slice(-2)
      assert.deepStrictEqual(tail, [
        { role: "assistant", content: "Plain words." },
        { role: "user", content: SEND_NUDGE }
      ])
      // The plain turn the app asked to be sent is a step: what the model wrote, then sent.
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
        { kind: "text", text: "Plain words." }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the turn cap's last request asks for the reply, without tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("narrator")!,
        plan: () => ({ strategy: "agent", tools: ["look_up"], contract: "both", turnCap: 2 })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if ((request.body?.tools as Array<unknown> | undefined)?.length)
              sse(res, toolCallChunks("look_up", { topic: "lighthouse" }))
            else sse(res, completionChunks(["Done."], { prompt_tokens: 80, completion_tokens: 1 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Done.")
      const bodies = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      assert.strictEqual(bodies.length, 2)
      // pi-ai sends an empty list when the history holds tool calls, as proxies require.
      assert.isEmpty((bodies[1]!.tools as Array<unknown> | undefined) ?? [])
      assert.deepStrictEqual((bodies[1]!.messages as Array<unknown>).at(-1), { role: "user", content: WRITE_NOW })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  /** Answers every request by sending the reply. */
  const sends = (request: Recorded, res: ServerResponse) => {
    void request
    sse(res, toolCallChunks("send_message", { message: "Hi." }))
  }

  it.live("the narrator is told its tools and how to reply, with the end of the request", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(sends)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Hi.")
      const [first] = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      // The built-in tools registered so far, in the mode's order, then the contract's own.
      const offered = [
        "expand_summary",
        "search_summaries",
        "search_chat",
        "read_messages",
        "list_notes",
        "switch_note",
        "set_presence"
      ]
      assert.deepStrictEqual(
        (first!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
        [...offered, "send_message"]
      )
      const last = (first!.messages as Array<{ role: string; content: string }>).at(-1)!
      assert.strictEqual(last.role, "user")
      assert.isTrue(last.content.endsWith(`\n${agentInstructions(offered, "both")}`), last.content)
      const db = read(config.dataDir, version.id)
      assert.deepStrictEqual(db.snapshot.agentAssembly, {
        instructions: agentInstructions(offered, "both"),
        cardsAtTail: false
      })
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const rebuilt = yield* reader.RebuildContext({ userId: me.id, snapshot: JSON.stringify(db.snapshot) })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") {
        const snapshot = JSON.parse(rebuilt.snapshot) as Record<string, unknown>
        assert.deepStrictEqual(snapshot.agentAssembly, db.snapshot.agentAssembly)
        assert.deepStrictEqual(snapshot.request, db.snapshot.request)
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("card swap moves the speaker's card to the tail; agent.tools picks the tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(sends)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "orchestration.mode", value: { mode: "card-swap" } },
          { key: "agent.tools", value: { tools: ["look_up"] } }
        ]
      })
      assert.strictEqual(version.content, "Hi.")
      const [first] = mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body!)
      assert.deepStrictEqual(
        (first!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
        ["look_up", "send_message"]
      )
      const messages = first!.messages as Array<{ role: string; content: string }>
      const card = messages.flatMap((m, i) => (m.content.includes("keeps the ledger") ? [i] : []))
      assert.deepStrictEqual(card, [messages.length - 2], "the card only just before the end of the request")
      assert.strictEqual(messages.at(-2)?.role, "system")
      assert.include(messages.at(-1)!.content, agentInstructions(["look_up"], "both"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("one message a turn: a second send_message is refused and the first is the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const twice = [
        {
          id: "cmpl-t",
          object: "chat.completion.chunk",
          model: "served-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    type: "function",
                    function: { name: "send_message", arguments: '{"message":"First."}' }
                  },
                  {
                    index: 1,
                    id: "call_b",
                    type: "function",
                    function: { name: "send_message", arguments: '{"message":"Second."}' }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          id: "cmpl-t",
          object: "chat.completion.chunk",
          model: "served-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        }
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, twice))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "First.")
      assert.strictEqual(mock.requests().filter((r) => r.path === "/v1/chat/completions").length, 1)
      const results = read(config.dataDir, version.id).transcript!.filter((m) => m.role === "toolResult")
      assert.deepStrictEqual(
        results.map((m) => [m.toolCallId, m.isError]),
        [
          ["call_a", false],
          ["call_b", true]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
