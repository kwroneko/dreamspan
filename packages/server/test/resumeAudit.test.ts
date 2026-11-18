// Resuming anything stopped midway (spec/AGENTIC.md §12; owner, 2026-11-12): the audit's cases,
// each reproduced against a scripted provider and carried on without a new user message. A
// stop while text, reasoning or a request is under way, parallel tool calls, each kind of
// provider failure, a tab that goes away, plain replies, and a resume after the user changed
// the chat's model, which sends the failed request to the new model in its own format.
// Process kills are in resumeKill.test.ts (slow).
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import type { ServerResponse } from "node:http"
import type { RolloutTool } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { anthropicSse, completionChunks, json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
type Body = { readonly messages: Array<Record<string, unknown>>; readonly tools?: Array<unknown>; model?: string }

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-t",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})
const toolCalls = (calls: ReadonlyArray<readonly [string, unknown, string]>, reasoning?: string) => [
  ...(reasoning ? [chunk({ role: "assistant", reasoning_content: reasoning })] : []),
  chunk({
    role: "assistant",
    tool_calls: calls.map(([name, args, id], index) => ({
      index,
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) }
    }))
  }),
  chunk({}, "tool_calls"),
  { id: "cmpl-t", object: "chat.completion.chunk", model: "served-model", choices: [], usage: { prompt_tokens: 9 } }
]
const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
const results = (body: Body) => body.messages.filter((m) => m.role === "tool").length

/** A read tool that answers at once, or holds its first `holds` runs until the run stops. */
const lookup = (id = "look_up", holds = 0) => {
  let runs = 0
  const tool: RolloutTool<{ readonly topic: string }> = {
    id,
    label: "Looked something up",
    effect: "read",
    description: "Looks up a detail of the story.",
    parameters: Type.Object({ topic: Type.String() }),
    execute: (_context, args) =>
      runs++ < holds ? Effect.never : Effect.succeed({ text: `${args.topic}: the keeper is Ansel.` })
  }
  return { tool, runs: () => runs }
}

const agentWith = (tools: ReadonlyArray<RolloutTool<never>>) =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    for (const tool of tools) yield* registry.rolloutTools.register(tool)
    yield* registry.orchestrationModes.register({
      ...registry.orchestrationModes.get("default")!,
      plan: () => ({ strategy: "agent", tools: tools.map((t) => t.id), contract: "final_text", turnCap: 6 })
    })
  })

// These replies end in plain text: the contract that takes it (the send tool's nudge is replyContract.test.ts).
const agentOn = [
  { key: "agent.enabled" as const, value: { on: true } },
  { key: "output.contract" as const, value: "both" as const }
]

const mockOf = (handler: (request: Recorded, res: ServerResponse) => void | Promise<void>) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

/** Resumes a stopped version as the client does, and waits for the new one to finish. */
const resume = (api: Api, events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const version = yield* (yield* Reader).GetVersion({ userId: me.id, versionId })
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
    const entry = yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    return finished(events, entry.version.id)!
  })

/** Starts a reply whose first request `hold` holds, and stops it once the holding point is reached. */
const stopWhen = (api: Api, events: ReadonlyArray<ChatEvent>, reached: () => boolean) =>
  Effect.gen(function* () {
    yield* eventually(() => reached())
    const running = events.flatMap((e) => (e._tag === "Slot" && e.entry.version.status === "generating" ? [e] : []))
    const versionId = running.at(-1)!.entry.version.id
    yield* api.StopGeneration({ versionId })
    yield* eventually(() => finished(events, versionId) !== undefined)
    return finished(events, versionId)!
  })

describe("resume review regressions", () => {
  for (const action of ["resume", "continue", "regenerate"] as const)
    it.live(`${action} does not recover an earlier binding when the default was also cleared`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockOf((_request, res) =>
          action === "continue"
            ? sse(res, completionChunks(["Mira waits."], {}))
            : json(res, 400, { error: { message: "Try again." } })
        )
        const api = yield* client()
        const { version, chat, connection, model, preset } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          ...(action === "resume" ? { state: agentOn } : {})
        })
        const me = yield* api.Whoami()
        yield* (yield* Writer).AddStateEvent({
          userId: me.id,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "model.binding", value: { connection: connection.id, model: model.id } }
        })
        yield* api.ChangeCast({ chatId: chat.id, slotId: version.slotId, change: { _tag: "DefaultModel" } })
        yield* api.SetGenerationDefaults({ defaults: { model: null, preset: preset.ref.id } })
        const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
        const sent = bodies(mock.requests()).length
        const input = { versionId: version.id, expectedRowVersion: slot.entry.rowVersion }
        const refused = yield* action === "resume"
          ? api.ResumeVersion(input).pipe(Effect.flip)
          : action === "continue"
            ? api.ContinueVersion(input).pipe(Effect.flip)
            : api.Regenerate({ slotId: version.slotId, expectedRowVersion: slot.entry.rowVersion }).pipe(Effect.flip)
        assert.strictEqual(
          refused._tag,
          action === "resume" ? "NotResumable" : action === "continue" ? "NotContinuable" : "GenerationUnavailable"
        )
        assert.include(refused.message, "No model is chosen")
        assert.lengthOf(bodies(mock.requests()), sent)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  for (const removed of ["connection", "chat", "host consent"] as const)
    it.live(`saved-request replay respects removed ${removed} and sends nothing`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockOf((_request, res) => json(res, 400, { error: { message: "Try again." } }))
        const api = yield* client()
        const { version, events, chat, connection } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, apiKey: "synthetic-secret-only" },
          model: {},
          state: agentOn
        })
        const me = yield* api.Whoami()
        const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
        if (removed === "connection") yield* api.DeleteConnection({ connectionId: connection.id })
        else if (removed === "chat") yield* api.DeleteChat({ chatId: chat.id })
        else {
          const other = yield* mockOf((_request, res) => sse(res, completionChunks(["Must not send."], {})))
          yield* api.UpdateConnection({
            connectionId: connection.id,
            expectedRowVersion: connection.rowVersion,
            settings: {
              name: connection.name,
              baseUrl: `${other.url}/v1`,
              compat: connection.compat,
              cacheTtlS: connection.cacheTtlS,
              maxConcurrent: connection.maxConcurrent,
              presetOverrideRefId: connection.presetOverrideRefId
            }
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => assert.lengthOf(bodies(other.requests()), 0)))
        }
        const sent = bodies(mock.requests()).length
        const result = yield* api
          .ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion, saved: true })
          .pipe(Effect.result)
        // Credential refusal can occur in the provider layer, after the new version was created.
        if (result._tag === "Success") {
          yield* eventually(() => finished(events, result.success.version.id) !== undefined)
          assert.strictEqual(finished(events, result.success.version.id)!.status, "failed")
        }
        assert.lengthOf(bodies(mock.requests()), sent, "removed authority is never used")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("provider errors keep the provider's words and redact credentials in every durable error", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const secret = "synthetic-resume-secret-0000"
      const mock = yield* mockOf((_request, res) =>
        json(res, 401, { error: { message: `Wrong key ${secret}; please replace it.` } })
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, apiKey: secret },
        model: {},
        state: agentOn
      })
      assert.include(version.error!.message, "please replace it")
      assert.notInclude(version.error!.message, secret)
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT error_json AS error FROM version_records UNION ALL SELECT error FROM rollouts UNION ALL SELECT error_json AS error FROM llm_requests"
          }
        ],
        { readOnly: true }
      )
      assert.notInclude(JSON.stringify(rows), secret)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const action of ["resume", "continue", "regenerate"] as const)
    it.live(`${action} follows the default after the reply's model binding is removed`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockOf((_request, res) =>
          action === "continue"
            ? sse(res, completionChunks(["Mira"], {}))
            : json(res, 400, { error: { message: "Try another model." } })
        )
        const api = yield* client()
        const { version, events, chat, connection, model, preset } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: { prefill: "assistant" },
          ...(action === "resume" ? { state: agentOn } : {})
        })
        const me = yield* api.Whoami()
        yield* (yield* Writer).AddStateEvent({
          userId: me.id,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "model.binding", value: { connection: connection.id, model: model.id } }
        })
        const next = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "new-default",
          overrides: { prefill: "assistant" }
        })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: next.id }, preset: preset.ref.id }
        })
        yield* api.ChangeCast({ chatId: chat.id, slotId: version.slotId, change: { _tag: "DefaultModel" } })
        mock.setHandler((_request, res) => sse(res, completionChunks([" waves."], {})))
        const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
        const input = { versionId: version.id, expectedRowVersion: slot.entry.rowVersion }
        const entry = yield* action === "resume"
          ? api.ResumeVersion(input)
          : action === "continue"
            ? api.ContinueVersion(input)
            : api.Regenerate({ slotId: version.slotId, expectedRowVersion: slot.entry.rowVersion })
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        assert.strictEqual(bodies(mock.requests()).at(-1)!.model, "new-default")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a removed tool's committed receipt still answers its dangling call", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let committed = false
      let runs = 0
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register({
        id: "commit_once",
        label: "Changes a note",
        effect: "chat_state",
        description: "Changes a note.",
        parameters: Type.Object({}),
        execute: (context) =>
          Effect.gen(function* () {
            runs++
            yield* context.writer
              .ApplyRolloutEffect({
                userId: context.userId,
                rolloutId: context.rolloutId,
                toolCallId: context.toolCallId,
                events: [],
                result: "Committed once."
              })
              .pipe(Effect.orDie)
            committed = true
            return yield* Effect.never
          })
      })
      const mock = yield* mockOf((request, res) =>
        results(request.body as unknown as Body) === 0
          ? sse(res, toolCalls([["commit_once", {}, "c1"]]))
          : sse(res, completionChunks(["Done."], {}))
      )
      const api = yield* client()
      const events: Array<ChatEvent> = []
      let chatId: string | undefined
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          events,
          state: [...agentOn, { key: "agent.tools", value: { tools: ["commit_once"] } }],
          before: (chat) =>
            Effect.sync(() => {
              chatId = chat.id
            })
        })
      )
      const stopped = yield* stopWhen(api, events, () => committed)
      yield* api.ChangeCast({
        chatId: chatId as never,
        slotId: stopped.slotId,
        change: { _tag: "AgentTools", tools: [] }
      })
      const resumed = yield* resume(api, events, stopped.id)
      assert.strictEqual(resumed.status, "complete")
      const result = bodies(mock.requests())
        .at(-1)!
        .messages.find((m) => m.role === "tool")!
      assert.strictEqual(result.content, "Committed once.")
      assert.strictEqual(runs, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refuses a smaller model when the kept tool results exceed its window before sending", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const tool = { ...lookup().tool, execute: () => Effect.succeed({ text: "keeper ledger ".repeat(1100) }) }
      yield* agentWith([tool as RolloutTool<never>])
      const mock = yield* mockOf((request, res) =>
        results(request.body as unknown as Body) === 0
          ? sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
          : json(res, 400, { error: { message: "Try another model." } })
      )
      const api = yield* client()
      const { version, chat, connection } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { context: 32768 },
        state: agentOn,
        preset: { openai_max_context: 32768, openai_max_tokens: 256 }
      })
      const smaller = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "small-window",
        overrides: { context: 2048 }
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: version.slotId,
        change: { _tag: "Model", connection: connection.id, model: smaller.id }
      })
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const sent = bodies(mock.requests()).length
      const result = yield* api
        .ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
        .pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure", "the kept transcript cannot fit")
      assert.lengthOf(bodies(mock.requests()), sent, "no oversized request is sent")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("audit: a stop midway", () => {
  it.live("while text streams: kept, and carried on through a prefill on a model that takes one", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let release: (() => void) | null = null
      let n = 0
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        if (n++ === 0) {
          // The final turn starts, then hangs until the test stops it.
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write(`data: ${JSON.stringify(completionChunks(["Ansel wa"], {})[0])}\n\n`)
          release = () => res.destroy()
          return
        }
        sse(res, completionChunks(["ves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const events: Array<ChatEvent> = []
      const started = yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: { prefill: "assistant" },
          state: agentOn,
          events
        })
      )
      const stopped = yield* stopWhen(api, events, () =>
        events.some((e) => e._tag === "Delta" && e.text.includes("Ansel wa"))
      )
      ;(release as (() => void) | null)?.()
      void started
      assert.strictEqual(stopped.status, "stopped")
      assert.strictEqual(stopped.content, "Ansel wa", "the text so far is kept on the stopped reply")
      const resumed = yield* resume(api, events, stopped.id)
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      assert.strictEqual(resumed.content, "Ansel waves.")
      const sent = bodies(mock.requests())
      const [, held, carried] = sent as [Body, Body, Body]
      assert.deepStrictEqual(carried.messages.slice(0, -1), held.messages, "the same request, then the text so far")
      assert.deepInclude(carried.messages.at(-1), { role: "assistant", content: "Ansel wa" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const kind of ["text on a model without prefill", "reasoning"] as const)
    it.live(`while ${kind} streams: the turn is written again from the same request`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        yield* agentWith([lookup().tool as RolloutTool<never>])
        let n = 0
        let release: (() => void) | null = null
        const mock = yield* mockOf((request, res) => {
          const body = request.body as unknown as Body
          if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
          if (n++ === 0) {
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write(
              `data: ${JSON.stringify(
                kind === "reasoning"
                  ? chunk({ role: "assistant", reasoning_content: "Mira would" })
                  : completionChunks(["Ansel wa"], {})[0]
              )}\n\n`
            )
            release = () => res.destroy()
            return
          }
          sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
        })
        const api = yield* client()
        const events: Array<ChatEvent> = []
        yield* Effect.forkScoped(
          generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
            model: { prefill: "none" },
            state: agentOn,
            events
          })
        )
        const stopped = yield* stopWhen(api, events, () => n > 0 && bodies(mock.requests()).length >= 2)
        ;(release as (() => void) | null)?.()
        assert.strictEqual(stopped.status, "stopped")
        const resumed = yield* resume(api, events, stopped.id)
        assert.strictEqual(resumed.content, "Ansel waves.")
        const [, held, again] = bodies(mock.requests()) as [Body, Body, Body]
        assert.deepStrictEqual(again, held, "the cut-off turn is sampled again from the identical request")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("between tool calls, before the next request answers: that request is sent again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let held = 0
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        if (held++ === 0) return // never answers: the user stops it
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const events: Array<ChatEvent> = []
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: agentOn,
          events
        })
      )
      const stopped = yield* stopWhen(api, events, () => held > 0)
      assert.strictEqual(stopped.status, "stopped")
      const resumed = yield* resume(api, events, stopped.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
      const [, first, again] = bodies(mock.requests()) as [Body, Body, Body]
      assert.deepStrictEqual(again, first)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("during the second of two calls in one turn: the first keeps its result, the second runs again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const quick = lookup("look_up")
      const slow = lookup("ask_around", 1)
      yield* agentWith([quick.tool, slow.tool] as Array<RolloutTool<never>>)
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0)
          return sse(
            res,
            toolCalls([
              ["look_up", { topic: "keeper" }, "c1"],
              ["ask_around", { topic: "harbour" }, "c2"]
            ])
          )
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const events: Array<ChatEvent> = []
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: agentOn,
          events
        })
      )
      const stopped = yield* stopWhen(api, events, () => slow.runs() > 0)
      assert.strictEqual(quick.runs(), 1)
      const resumed = yield* resume(api, events, stopped.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
      assert.strictEqual(quick.runs(), 1, "a finished call isn't run again")
      assert.strictEqual(slow.runs(), 2, "the call the stop cut short runs again")
      const sent = bodies(mock.requests())
      assert.lengthOf(sent, 2, "the model is asked once more, after both results")
      const tail = sent[1]!.messages.slice(-2)
      assert.deepStrictEqual(
        tail.map((m) => m.tool_call_id),
        ["c1", "c2"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

/** How each failure is served: always (an error the provider gives each time), or once. */
const failures: ReadonlyArray<{
  readonly name: string
  readonly fail: (res: ServerResponse) => void
  readonly class: string
  readonly said: string
  /** Retried before the first token: served this many times before it's given up. */
  readonly attempts?: number
}> = [
  {
    name: "bad request (400)",
    fail: (res) => json(res, 400, { error: { message: "Invalid value for 'temperature'." } }),
    class: "bad_request",
    said: "Invalid value for 'temperature'."
  },
  {
    name: "a refused key (401)",
    fail: (res) => json(res, 401, { error: { message: "Incorrect API key provided." } }),
    class: "auth",
    said: "Incorrect API key provided."
  },
  {
    name: "context too long",
    fail: (res) =>
      json(res, 400, {
        error: { message: "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens." }
      }),
    class: "context_overflow",
    said: "maximum context length is 4096 tokens"
  },
  {
    name: "a content refusal",
    fail: (res) => sse(res, [chunk({ role: "assistant", content: "" }), chunk({}, "content_filter")], { done: true }),
    class: "refused",
    said: ""
  },
  {
    name: "rate limited (429), after its retries",
    fail: (res) => json(res, 429, { error: { message: "Rate limit reached." } }, { "retry-after": "0" }),
    class: "rate_limited",
    said: "Rate limit reached.",
    attempts: 4
  },
  {
    name: "a server error (500), after its retries",
    fail: (res) => json(res, 500, { error: { message: "The server had an error." } }, { "retry-after": "0" }),
    class: "overloaded",
    said: "The server had an error.",
    attempts: 4
  }
]

describe("audit: the provider request fails", () => {
  for (const failure of failures)
    it.live(`${failure.name}: the error shows the provider's words, and Resume sends the same request`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        yield* agentWith([lookup().tool as RolloutTool<never>])
        let failing = true
        let served = 0
        const mock = yield* mockOf((request, res) => {
          const body = request.body as unknown as Body
          if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
          if (failing) {
            served++
            return failure.fail(res)
          }
          sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
        })
        const api = yield* client()
        const { version, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: agentOn
        })
        assert.strictEqual(version.status, "failed")
        assert.strictEqual(version.error?.class, failure.class, JSON.stringify(version.error))
        assert.include(version.error?.message ?? "", failure.said)
        assert.strictEqual(served, failure.attempts ?? 1)
        failing = false
        const before = bodies(mock.requests())
        const resumed = yield* resume(api, events, version.id)
        assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
        assert.strictEqual(resumed.content, "Ansel waves.")
        const after = bodies(mock.requests()).slice(before.length)
        assert.lengthOf(after, 1, "the finished tool call isn't redone; the failed request is sent once")
        assert.deepStrictEqual(after[0], before.at(-1))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a connection that fails before answering, after its retries, is resumed the same way", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let failing = true
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        if (failing) return void res.socket?.destroy()
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: agentOn
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "network", JSON.stringify(version.error))
      failing = false
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("a provider that goes silent (spec/AGENTIC.md §12.5)", () => {
  it.live("nothing for the connection's limit fails as no response, once, and Resume sends it again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let silent = true
      let closed = false
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        // Headers, then nothing: a provider that took the request and went quiet.
        if (silent) {
          res.on("close", () => {
            closed = true
          })
          return void res.writeHead(200, { "content-type": "text/event-stream" })
        }
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const started = Date.now()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { idleTimeoutS: 1 } },
        model: {},
        state: agentOn
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "no_response", JSON.stringify(version.error))
      assert.include(version.error?.message ?? "", "nothing for 1 s")
      assert.isBelow(Date.now() - started, 15_000)
      assert.lengthOf(bodies(mock.requests()), 2, "a silent request isn't retried by itself")
      yield* eventually(() => closed)
      silent = false
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
      const [, cut, again] = bodies(mock.requests()) as [Body, Body, Body]
      assert.deepStrictEqual(again, cut)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("keep-alive comments count as hearing from it: a slow start isn't cut off", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockOf((_request, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        // A queued request: DeepSeek and OpenRouter send SSE comments while it waits.
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 300)
        setTimeout(() => {
          clearInterval(beat)
          for (const chunk of completionChunks(["Mira waves."], { prompt_tokens: 20, completion_tokens: 2 }))
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          res.end("data: [DONE]\n\n")
        }, 2500)
      })
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { idleTimeoutS: 1 } },
        model: {}
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Mira waves.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("Resume uses the chat's Tools setting as it is now (spec/AGENTIC.md §12.3)", () => {
  it.live("a tool turned off isn't offered; the call already made keeps its result", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let failing = true
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["search_chat", { query: "bridge" }, "c1"]]))
        if (failing) return json(res, 400, { error: { message: "This model can't take that request." } })
        sse(res, completionChunks(["Mira waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [...agentOn, { key: "agent.tools" as const, value: { tools: ["search_chat", "read_messages"] } }]
      })
      assert.strictEqual(version.status, "failed")
      const names = (body: Body) =>
        (body.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name) ?? []
      const [, cut] = bodies(mock.requests()) as [Body, Body]
      assert.includeMembers(names(cut), ["search_chat", "read_messages"])
      // The user turns search_chat off in This chat, with the failed reply last.
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: version.slotId,
        change: { _tag: "AgentTools", tools: ["read_messages"] }
      })
      failing = false
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.content, "Mira waves.")
      const again = bodies(mock.requests()).at(-1)!
      assert.deepStrictEqual(
        names(again),
        names(cut).filter((name) => name !== "search_chat"),
        "the tool turned off isn't offered; the rest are as they were"
      )
      assert.deepStrictEqual(again.messages, cut.messages, "the call made and its result are kept")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("Resume when the chat's context can't be built now (spec/AGENTIC.md §12.4)", () => {
  it.live("says why and sends nothing; the saved request goes only when asked for, unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let failing = true
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["search_chat", { query: "bridge" }, "c1"]]))
        if (failing) return json(res, 500, { error: { message: "Busy." } })
        sse(res, completionChunks(["Mira waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const { version, events, preset } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: agentOn
      })
      assert.strictEqual(version.status, "failed")
      const sent = bodies(mock.requests()).length
      const cut = bodies(mock.requests()).at(-1)!
      // The chat's preset no longer reads as one: the chat's context can't be built now.
      const me = yield* api.Whoami()
      // (A fixture only: revisions are immutable, so the trigger is set aside for the write.)
      yield* fixtureSql(config.dataDir, [
        { sql: "DROP TRIGGER entity_revisions_immutable" },
        {
          sql: `UPDATE entity_revisions SET doc_json = '{"samplers":"broken"}' WHERE entity_id = ?`,
          params: [preset.entityId]
        }
      ])
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const refused = yield* api
        .ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "NotResumable")
      assert.isTrue((refused as { savedRequest?: boolean }).savedRequest, JSON.stringify(refused))
      assert.lengthOf(bodies(mock.requests()), sent, "nothing is sent silently")
      failing = false
      const entry = yield* api.ResumeVersion({
        versionId: version.id,
        expectedRowVersion: slot.entry.rowVersion,
        saved: true
      })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.strictEqual(finished(events, entry.version.id)!.content, "Mira waves.")
      assert.deepStrictEqual(bodies(mock.requests()).at(-1), cut, "the stored request, unchanged")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("audit: Resume uses the chat's model as it is now", () => {
  it.live(
    "a failed request goes to the newly chosen model, converted for its API, without the old model's thinking",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        yield* agentWith([lookup().tool as RolloutTool<never>])
        const first = yield* mockOf((request, res) => {
          const body = request.body as unknown as Body
          if (results(body) === 0)
            return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]], "I should check the keeper."))
          json(res, 400, { error: { message: "This model can't take that request." } })
        })
        const start = {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "other-model",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 }
          }
        }
        const second = yield* mockOf((_request, res) =>
          anthropicSse(res, [
            start,
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ansel waves." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
            { type: "message_stop" }
          ])
        )
        const api = yield* client()
        const { version, events, chat } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${first.url}/v1` },
          model: {},
          state: agentOn
        })
        assert.strictEqual(version.status, "failed")
        // The user picks another connection and model for the chat, as the composer's picker does.
        const connection = yield* api.CreateConnection({
          kind: "anthropic",
          settings: {
            name: "Other",
            baseUrl: second.url,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "sk-ant-made-up-for-tests-0000"
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "other-model", overrides: {} })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: version.slotId,
          change: { _tag: "Model", connection: connection.id, model: model.id }
        })
        const resumed = yield* resume(api, events, version.id)
        assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
        assert.strictEqual(resumed.content, "Ansel waves.")
        assert.include(resumed.model ?? "", "other-model")
        const [failed] = bodies(first.requests()).slice(-1)
        void failed
        const sent = second.requests().filter((r) => r.path.startsWith("/v1/messages"))
        assert.lengthOf(sent, 1)
        type Block = { type: string; text?: string; id?: string; tool_use_id?: string; name?: string }
        const body = sent[0]!.body as unknown as {
          model: string
          messages: Array<{ role: string; content: Array<Block> }>
        }
        assert.strictEqual(body.model, "other-model")
        const tail = body.messages.slice(-2)
        assert.deepStrictEqual(
          tail.map((m) => [m.role, m.content.map((b) => b.type)]),
          [
            ["assistant", ["tool_use"]],
            ["user", ["tool_result"]]
          ],
          "the call and its result, in Anthropic's own blocks"
        )
        assert.notInclude(JSON.stringify(body), "I should check the keeper.", "another model's thinking isn't sent")
        // The transcript says which model wrote each turn; the run is recorded on the new model.
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT p.transcript_json AS transcript, m.model_key AS model FROM versions v JOIN rollouts r ON r.id = v.rollout_id
              JOIN rollout_payloads p ON p.rollout_id = r.id JOIN models m ON m.id = r.model_id WHERE v.id = ?`,
              params: [resumed.id]
            }
          ],
          { readOnly: true }
        )
        const row = rows![0] as { transcript: string; model: string }
        assert.strictEqual(row.model, "other-model")
        const turns = (JSON.parse(row.transcript) as Array<{ role: string; model?: string }>).filter(
          (m) => m.role === "assistant"
        )
        assert.deepStrictEqual(
          turns.map((t) => t.model),
          ["mock-model", "other-model"]
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("in a chat with separate contexts, an unchanged model keeps the frozen request byte for byte", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let failing = true
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        if (failing) return json(res, 400, { error: { message: "Try again." } })
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [...agentOn, { key: "context.per_speaker", value: "separate" }]
      })
      assert.strictEqual(version.status, "failed")
      failing = false
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: `SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN rollout_payloads p ON p.rollout_id = v.rollout_id
              WHERE v.id IN (?, ?) ORDER BY v.created_at`,
            params: [version.id, resumed.id]
          }
        ],
        { readOnly: true }
      )
      assert.lengthOf(rows!, 2)
      assert.strictEqual(rows![1]!.snapshot, rows![0]!.snapshot)
      const sent = bodies(mock.requests())
      assert.deepStrictEqual(sent.at(-1), sent.at(-2))
      const raw = mock
        .requests()
        .filter((request) => request.path === "/v1/chat/completions")
        .slice(-2)
      assert.isString(raw[0]!.raw)
      assert.strictEqual(raw[1]!.raw, raw[0]!.raw, "the actual HTTP request body is byte-identical")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("audit: everything else", () => {
  it.live("a stop before the first word: Resume starts the reply over from its saved request", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let held = 0
      const mock = yield* mockOf((_request, res) => {
        if (held++ === 0) return
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const api = yield* client()
      const events: Array<ChatEvent> = []
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: agentOn,
          events
        })
      )
      const stopped = yield* stopWhen(api, events, () => held > 0)
      assert.strictEqual(stopped.content, "")
      assert.isUndefined(stopped.steps)
      const resumed = yield* resume(api, events, stopped.id)
      assert.strictEqual(resumed.content, "Ansel waves.")
      const [first, again] = bodies(mock.requests()) as [Body, Body]
      assert.deepStrictEqual(again, first)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a tab that goes away mid-run: the run goes on, and another tab sees it finish", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* agentWith([lookup().tool as RolloutTool<never>])
      let release: () => void = () => {}
      const gate = new Promise<void>((done) => (release = done))
      const mock = yield* mockOf(async (request, res) => {
        const body = request.body as unknown as Body
        if (results(body) === 0) return sse(res, toolCalls([["look_up", { topic: "keeper" }, "c1"]]))
        await gate
        sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      })
      const watcher = yield* client()
      let chatId: string | null = null
      // The first tab starts the reply, then closes while the model is still working.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tab = yield* client()
          yield* Effect.forkScoped(
            generateReply(tab, {
              connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
              model: {},
              state: agentOn,
              before: (chat) => Effect.sync(() => void (chatId = chat.id))
            })
          )
          yield* eventually(() => bodies(mock.requests()).length >= 2)
        })
      )
      const events: Array<ChatEvent> = []
      yield* watcher.SubscribeChat({ chatId: chatId! as never }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.some((e) => e._tag === "Hello"))
      release()
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.status === "complete" && e.version.content === "Ansel waves."
        )
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("plain replies: a stop keeps the text, and Continue sends it to the model chosen now", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let release: (() => void) | null = null
      const first = yield* mockOf((_request, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify(completionChunks(["Mira sets down"], {})[0])}\n\n`)
        release = () => res.destroy()
      })
      const second = yield* mockOf((_request, res) =>
        sse(res, completionChunks([" the ledger."], { prompt_tokens: 20, completion_tokens: 3 }))
      )
      const api = yield* client()
      const events: Array<ChatEvent> = []
      const chatOf: { id: string | null } = { id: null }
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${first.url}/v1` },
          model: { prefill: "assistant" },
          events,
          before: (chat) => Effect.sync(() => void (chatOf.id = chat.id))
        })
      )
      const stopped = yield* stopWhen(api, events, () =>
        events.some((e) => e._tag === "Delta" && e.text.includes("Mira sets down"))
      )
      ;(release as (() => void) | null)?.()
      assert.strictEqual(stopped.status, "stopped")
      assert.strictEqual(stopped.content, "Mira sets down")
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Other",
          baseUrl: `${second.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "other-model",
        overrides: { prefill: "assistant" }
      })
      yield* api.ChangeCast({
        chatId: chatOf.id as never,
        slotId: stopped.slotId,
        change: { _tag: "Model", connection: connection.id, model: model.id }
      })
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: stopped.slotId })
      const continued = yield* api.ContinueVersion({ versionId: stopped.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      assert.strictEqual(finished(events, continued.version.id)!.content, "Mira sets down the ledger.")
      const sent = bodies(second.requests())
      assert.lengthOf(sent, 1)
      assert.strictEqual(sent[0]!.model, "other-model")
      assert.deepInclude(sent[0]!.messages.at(-1), { role: "assistant", content: "Mira sets down" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("plain replies: a failure says what the provider said, and a new version tries again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let failing = true
      const mock = yield* mockOf((_request, res) =>
        failing
          ? json(res, 401, { error: { message: "Incorrect API key provided." } })
          : sse(res, completionChunks(["Mira waves."], { prompt_tokens: 20, completion_tokens: 2 }))
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "auth")
      assert.include(version.error?.message ?? "", "Incorrect API key provided.")
      failing = false
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const entry = yield* api.Regenerate({ slotId: version.slotId, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.strictEqual(finished(events, entry.version.id)!.content, "Mira waves.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
