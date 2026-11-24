// Subagents after review (review-subagents679 findings 5–10 and 12): the approval names the model
// a fork really runs on; a fork resumed with nothing saved gets its conversation and task back; a
// fork's summaries never cover its parent's conversation or its task; a subagent's limits hold
// between summary requests, which count toward its request cap; a resumed fork keeps its parent's
// cache layout; the assistant's changes to subagent types are checked as the settings editor
// checks them, and rewriting a built-in type's instructions always asks; fork isn't offered
// where it can't run. Synthetic data and scripted loopback providers only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { Chat, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { SUMMARY } from "@dreamspan/shared/subagents.ts"
import { makePermit } from "../src/agent/approvals.ts"
import { agentTool, forkOf } from "../src/agent/subagents.ts"
import type { RolloutTool, ToolContext } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse } from "./support/mockProvider.ts"
import { resume, secondConnection, workshop } from "./support/subagentFlow.ts"
import {
  type Api,
  type Body,
  childOf,
  FORK,
  filesWorkshop,
  parentResults,
  scripted,
  startTask
} from "./support/subagentFiles.ts"

const TRIGGER = "Workshop task:"
const MEMORY = "SAVED CHILD MEMORY: the keepers were read."

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const all = (body: Body) => JSON.stringify(body.messages)
/** A summary request (workshopCompactor.ts): the transcript to summarize, as data. */
const isSummary = (body: Body) =>
  body.messages.length === 2 && JSON.stringify(body.messages[1]?.content ?? "").includes("workshop_transcript")

/** A tool context on a workshop chat, for calling a tool's parts directly. */
const contextOf = (api: Api, chat: Chat, rolloutId: string) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const current = yield* api.GetChat({ chatId: chat.id })
    const context: ToolContext = {
      userId: me.id,
      chatId: chat.id,
      forkId: current.currentForkId,
      slotId: current.activeLeafSlotId as SlotId,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "call",
      leafSlotId: current.activeLeafSlotId as SlotId | null,
      viewers: null,
      reader: yield* Reader,
      writer: yield* Writer,
      cache: new Map()
    }
    return context
  })

/** Synthetic cards with long descriptions, for summaries to cover. */
const keepers = (api: Api, count: number, words: number) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    for (let n = 0; n < count; n++)
      yield* (yield* Writer).CreateEntity({
        userId: me.id,
        kind: "card",
        label: `Synthetic keeper ${n}`,
        subtitle: "",
        schemaVersion: 1,
        origin: "user",
        sourcePath: null,
        doc: {
          ...newCardDoc(`Synthetic keeper ${n}`),
          description: `KEEPER ${n} ` + Array.from({ length: words }, (_, i) => `word${i}`).join(" ")
        }
      })
  })

/** The workshop's own summary sizes, small enough that a few reads pass the recent maximum. */
const smallSummaries = (api: Api, chat: Chat) =>
  api.ChangeLcmSettings({
    chatId: chat.id,
    change: { recentTarget: 1000, recentMax: 2200, leafInput: 500, leafTarget: 150, when: "next-reply" }
  })

/**
 * The reply reads a keeper, then starts a subagent (`spawn`); the subagent (a fork when `fork`)
 * reads keepers until it has read `reads`, then reports. Summary requests answer `summary()`.
 */
const reading = (options: {
  readonly fork: boolean
  readonly reads: number
  readonly summary: () => { readonly text: string; readonly usage: Record<string, unknown> }
}) => {
  const summaries: Array<Body> = []
  let childRequests = 0
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
    if (isSummary(body)) {
      summaries.push(body)
      const { text, usage } = options.summary()
      return sse(res, completionChunks([text], usage))
    }
    const child = options.fork
      ? all(body).includes(FORK)
      : JSON.stringify(body.messages[0]).includes("You are a subagent")
    if (child) {
      // Counted by requests: summaries take its earlier results out of what it's sent.
      const n = childRequests++
      return sse(
        res,
        n < options.reads && body.tools?.length
          ? toolCall("read_card", { card: `Synthetic keeper ${n + 1}`, fields: ["description"] }, `child-read-${n}`)
          : completionChunks(["Report: the keepers were read."], {})
      )
    }
    if (!all(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const done = body.messages.filter((m) => m.role === "tool").length
    return sse(
      res,
      done === 0
        ? toolCall("read_card", { card: "Synthetic keeper 0", fields: ["description"] }, "parent-read")
        : done === 1
          ? toolCall(
              "agent",
              {
                type: "research",
                task: "Read the keepers.",
                ...(options.fork ? { context: "fork" } : {})
              },
              "spawn"
            )
          : completionChunks(["Done."], {})
    )
  }
  return { handler, summaries, childRequests: () => childRequests }
}

const spawnRow = (api: Api, versionId: VersionId) =>
  Effect.map(api.GetRolloutSteps({ versionId }), (steps) => {
    const spawn = steps.find((s) => s.kind === "tool" && s.id === "spawn")
    return spawn?.kind === "tool" ? spawn.subagent : undefined
  })

describe("subagent forks and types after review", () => {
  // Finding 5.
  it.live("the approval shows the model a fork runs on: the chat's own, not its type's default", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, mock } = yield* workshop((_request, res) => sse(res, completionChunks(["Ready."], {})))
      const other = yield* secondConnection(api, mock.url)
      yield* api.ChangeSubagentSettings({
        picks: ["same", other.pick],
        rows: { [SUMMARY]: { alias: "summary", note: "" }, [other.pick]: { alias: "fast", note: "" } }
      })
      const ctx = yield* contextOf(api, chat, "unused")
      const forked = yield* agentTool.describe!(ctx, { type: "research", task: "Check.", context: "fork" })
      assert.include(forked.rows.find((r) => r.label === "Model")!.value, "The model this chat uses")
      const own = yield* agentTool.describe!(ctx, { type: "research", task: "Check." })
      assert.strictEqual(own.rows.find((r) => r.label === "Model")!.value, "fast: cheap-model")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 12.
  it.live("fork isn't offered where the chat's own model isn't picked for subagents", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, mock } = yield* workshop((_request, res) => sse(res, completionChunks(["Ready."], {})))
      const other = yield* secondConnection(api, mock.url)
      const ctx = yield* contextOf(api, chat, "unused")
      const offer = () =>
        Effect.gen(function* () {
          const execution = yield* ExecutionRegistry
          const tool = yield* agentTool.offerFor!({ ...ctx, contract: "several", kind: "workshop", execution })
          return JSON.stringify({ description: tool!.description, parameters: tool!.parameters })
        })
      assert.include(yield* offer(), 'context: \\"fork\\"')
      yield* api.ChangeSubagentSettings({ picks: [other.pick], rows: { [other.pick]: { alias: "quick", note: "" } } })
      const without = yield* offer()
      assert.notInclude(without, "fork")

      yield* api.ChangeSubagentType({ id: "research", edit: { id: "research", context: "fork" } })
      const override = JSON.parse(yield* offer())
      assert.strictEqual(override.parameters.properties.context.const, "task")
      assert.notInclude(override.parameters.required, "context")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 9.
  it("a resumed or continued fork keeps its parent's cache layout", () => {
    const wire = { wireTools: [], offered: [], checkpoints: [2, 5], recentPrefix: 1200 }
    const subagent = { type: "research", task: "Check.", instructions: "Synthetic." }
    assert.deepStrictEqual(forkOf({ subagent: { ...subagent, context: "fork", fork: wire } }), wire)
    assert.isUndefined(forkOf({ subagent: { ...subagent, context: "task", fork: wire } }))
  })

  // Finding 6.
  it.live("a fork resumed with nothing of its run saved gets the reply's conversation and its task back", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [{ name: "agent", args: { type: "research", task: "[[forked]] Check.", context: "fork" } }],
        {}
      )
      flow.hold("forked", 0)
      const { api, chat, events, mock } = yield* filesWorkshop(flow.handler)
      const versionId = yield* startTask(api, chat, "fork, stop, resume")
      yield* eventually(() => flow.isHeld(), 60_000)
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      flow.release()
      // Stopped before anything of its run was saved.
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE rollout_payloads SET transcript_json = NULL WHERE rollout_id IN (SELECT id FROM rollouts WHERE spawned_by_rollout_id IS NOT NULL)"
        }
      ])
      const before = childOf(mock.requests(), "forked").length
      const resumed = yield* resume(api, chat, versionId)
      yield* eventually(() => finished(events, resumed) !== undefined, 60_000)
      assert.strictEqual(finished(events, resumed)!.status, "complete")
      const forks = childOf(mock.requests(), "forked")
      assert.isAbove(forks.length, before, "it ran again, as a fork with its task")
      const last = forks.at(-1)!
      assert.include(all(last), TRIGGER, "with the reply's conversation")
      assert.include(all(last), "[[forked]] Check.")
      assert.include(parentResults(mock.requests()).at(-1), "Report forked.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 7.
  it.live("a fork's summaries cover only its own run, never the reply's conversation or its task", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = reading({ fork: true, reads: 6, summary: () => ({ text: MEMORY, usage: {} }) })
      const { api, chat, events } = yield* workshop(flow.handler)
      yield* keepers(api, 7, 420)
      yield* smallSummaries(api, chat)
      const versionId = yield* startTask(api, chat, "read, then fork")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      assert.strictEqual(finished(events, versionId)!.status, "complete")
      const forked = flow.summaries.filter((b) => all(b).includes("child-read-"))
      assert.isAbove(forked.length, 0, "the fork's own run was summarized")
      for (const summary of forked) {
        assert.notInclude(all(summary), "parent-read", "the reply's conversation is never summarized")
        assert.notInclude(all(summary), "From here on you are a subagent", "nor the fork's task")
      }
      assert.strictEqual((yield* spawnRow(api, versionId))?.status, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 8.
  it.live("a subagent's limits are checked between its summary requests", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // Dense text: each summary is still too long once cut, so one pass would ask again and again.
      const long = "字".repeat(6000)
      const flow = reading({
        fork: false,
        reads: 6,
        summary: () => ({ text: long, usage: { prompt_tokens: 6000, completion_tokens: 3000, total_tokens: 9000 } })
      })
      const { api, chat, events } = yield* workshop(flow.handler)
      yield* keepers(api, 7, 420)
      yield* smallSummaries(api, chat)
      yield* api.ChangeSubagentSettings({ limits: { tokens: 1000 } })
      const versionId = yield* startTask(api, chat, "read until the limit")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      const child = flow.summaries.filter((b) => all(b).includes("child-read-") || all(b).includes("字"))
      assert.lengthOf(child, 1, "after one summary past its token limit, no other is sent")
      assert.strictEqual((yield* spawnRow(api, versionId))?.status, "limit")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 8.
  it.live("a subagent's summary requests count toward its request cap", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = reading({ fork: false, reads: 6, summary: () => ({ text: MEMORY, usage: {} }) })
      const { api, chat, events } = yield* workshop(flow.handler)
      yield* keepers(api, 7, 2000)
      yield* smallSummaries(api, chat)
      yield* api.ChangeSubagentSettings({ limits: { requests: 3 } })
      const versionId = yield* startTask(api, chat, "read within three requests")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT count(*) AS n FROM llm_requests WHERE rollout_id IN (SELECT id FROM rollouts WHERE spawned_by_rollout_id IS NOT NULL)"
          }
        ],
        { readOnly: true }
      )
      assert.isAtMost(Number(rows![0]!["n"]), 3, "its requests, summaries included, stay within its cap")
      assert.strictEqual((yield* spawnRow(api, versionId))?.status, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 10.
  it.live("the assistant's subagent types are checked as the editor checks them", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat } = yield* workshop((_request, res) => sse(res, completionChunks(["Ready."], {})))
      const rolloutId = `op-${chat.id}`
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
          params: [rolloutId, chat.id]
        }
      ])
      const ctx = yield* contextOf(api, chat, rolloutId)
      const registry = yield* ExecutionRegistry
      const tool = toolForKind(registry, "workshop", "change_setting")!
      const write = (value: unknown, id: string) =>
        tool.execute({ ...ctx, toolCallId: id }, { key: "subagents.types", value } as never)
      const research = (yield* api.GetSubagentTypes({})).types.find((t) => t.id === "research")!
      for (const [value, says] of [
        [[{ id: "research", tools: ["no_such_tool"] }], "Not a tool workshops offer"],
        [[{ id: "helper", off: true }], "its own settings"],
        [[{ id: "mine", label: "Mine" }], "needs a name and instructions"],
        [
          [
            { id: "research", off: true },
            { id: "research", label: "Again" }
          ],
          "listed twice"
        ]
      ] as const) {
        const refused = yield* write(value, `bad-${says}`)
        assert.isTrue(refused.isError, refused.text)
        assert.include(refused.text, says)
      }
      // Only what differs from a built-in type is kept, as the editor keeps it.
      const kept = yield* write(
        [{ id: "research", label: "Look up", instructions: research.instructions, tools: [...research.tools] }],
        "same-but-label"
      )
      assert.isUndefined(kept.isError, kept.text)
      assert.deepStrictEqual((yield* api.GetSubagentSettings({})).types, [{ id: "research", label: "Look up" }])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 10.
  it.live("rewriting a built-in type's instructions always asks, even where settings are Allowed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat } = yield* workshop((_request, res) => sse(res, completionChunks(["Ready."], {})))
      const rolloutId = `op-${chat.id}`
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
          params: [rolloutId, chat.id]
        }
      ])
      const ctx = yield* contextOf(api, chat, rolloutId)
      const registry = yield* ExecutionRegistry
      const tool = toolForKind(registry, "workshop", "change_setting")! as RolloutTool<never>
      const asks = (value: unknown, key = "subagents.types") => tool.mustAsk!(ctx, { key, value } as never)
      assert.isTrue(yield* asks([{ id: "research", instructions: "Synthetic new instructions." }]))
      assert.isFalse(yield* asks([{ id: "research", label: "Look up" }]))
      assert.isFalse(yield* asks([{ id: "mine", label: "Mine", instructions: "Synthetic own type." }]))
      assert.isFalse(yield* asks(true, "shell.pinsCollapsed"))
      // Through the permit: it asks, and only for this call.
      const shown = yield* Deferred.make<ApprovalPrompt>()
      const permit = makePermit({
        registries: registry,
        reader: ctx.reader,
        writer: yield* Writer,
        userId: ctx.userId,
        chatId: ctx.chatId,
        rolloutId
      })
      const asking = yield* permit({
        tool,
        context: { ...ctx, toolCallId: "rewrite" },
        args: { key: "subagents.types", value: [{ id: "research", instructions: "Synthetic new instructions." }] },
        dangling: false,
        onWaiting: (prompt) => {
          if (prompt) Deferred.doneUnsafe(shown, Effect.succeed(prompt))
        }
      }).pipe(Effect.forkScoped)
      const prompt = yield* Deferred.await(shown).pipe(Effect.timeout("10 seconds"))
      assert.isTrue(prompt.once)
      yield* Fiber.interrupt(asking)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
