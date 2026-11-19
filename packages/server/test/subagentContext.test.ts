// Subagents, milestone SA7 (spec/SUBAGENTS.md §2.3, §10): a long subagent is summarized as it
// goes, with the same request-boundary compaction a workshop reply uses; a fork sees the reply's
// conversation and shares its request's prefix. Synthetic data and a scripted loopback provider only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { Writer } from "../src/db/Database.ts"
import { settingsRegistry } from "../src/db/settings.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
}
interface Body {
  readonly model?: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"
const MEMORY = "SAVED CHILD MEMORY: the keeper was read; nothing changed."
const RAW = "RAW OLD LOOKUP"

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

const text = (body: Body) => JSON.stringify(body.messages)
const isSummary = (body: Body) => !Array.isArray(body.tools) || body.tools.length === 0
const isChild = (body: Body) => !isSummary(body) && JSON.stringify(body.messages[0]?.content ?? "").includes(CHILD)

const workshop = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return { mock, api, chat, events }
  })

const task = (api: Api, chat: Chat, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        content: `${TRIGGER} ${content}`
      })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    return generated.entry.version.id as VersionId
  })

const completions = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

describe("subagent context (SA7)", () => {
  it.live("a long subagent is summarized as it goes, as a workshop reply is", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let childRequests = 0
      const READS = 6
      const handler = (request: Recorded, res: ServerResponse) => {
        const body = request.body as unknown as Body
        if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
        if (isSummary(body)) return sse(res, completionChunks([MEMORY], {}))
        if (isChild(body)) {
          const n = childRequests++
          return sse(
            res,
            n < READS
              ? toolCall("read_card", { card: `Synthetic keeper ${n}`, fields: ["description"] }, `child-read-${n}`)
              : completionChunks(["Report: the keeper's description is long."], {})
          )
        }
        if (!text(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
        const answered = body.messages.some((m) => m.role === "tool")
        return sse(
          res,
          answered
            ? completionChunks(["Done."], {})
            : toolCall("agent", { type: "research", task: "Read the six keepers' descriptions." }, "spawn")
        )
      }
      const { api, chat, events, mock } = yield* workshop(handler)
      const me = yield* api.Whoami()
      for (let n = 0; n < READS; n++)
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
            description: `${RAW} ` + Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ")
          }
        })
      // The workshop's own summary sizes, small enough that six reads pass the recent maximum.
      yield* api.ChangeLcmSettings({
        chatId: chat.id,
        change: { recentTarget: 1000, recentMax: 2200, leafInput: 500, leafTarget: 150, when: "next-reply" }
      })
      const versionId = yield* task(api, chat, "read the keeper through a subagent")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      assert.strictEqual(finished(events, versionId)!.status, "complete")

      const bodies = completions(mock.requests())
      const children = bodies.filter(isChild)
      assert.lengthOf(children, READS + 1)
      // Summary requests were made for the child's own steps, as a reply's are summarized.
      const summaries = bodies.filter((b) => isSummary(b) && text(b).includes("child-read-0"))
      assert.isAbove(summaries.length, 0, "the child's transcript was summarized")
      // The child's last request carries the summary instead of every read it made.
      const last = children.at(-1)!
      assert.include(text(last), MEMORY.slice(0, 20))
      const raws = text(last).split(RAW).length - 1
      assert.isBelow(raws, READS, "summarized reads aren't sent again")
      assert.include(text(last), "child-read-5", "the newest read is sent as it came")
      // The summary is saved in the child's own transcript, append-only.
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT p.transcript_json AS t FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id WHERE r.spawned_by_rollout_id IS NOT NULL"
          }
        ],
        { readOnly: true }
      )
      const transcript = JSON.parse(String(rows![0]!["t"])) as ReadonlyArray<AgentMessage>
      assert.isTrue(transcript.some((m) => m.role === "rpCompaction"))
      assert.strictEqual(
        transcript.filter((m) => m.role === "toolResult").length,
        READS,
        "every original result is kept"
      )
      // The row is done, its report back with the reply.
      const steps = yield* api.GetRolloutSteps({ versionId })
      const spawn = steps.find((s) => s.kind === "tool" && s.id === "spawn")
      assert.strictEqual(spawn?.kind === "tool" ? spawn.subagent?.status : undefined, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a fork sees the reply's conversation and sends its request's prefix, with only its own tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const FORK = "From here on you are a subagent"
      let childRequests = 0
      const handler = (request: Recorded, res: ServerResponse) => {
        const body = request.body as unknown as Body
        if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
        if (text(body).includes(FORK)) {
          const n = childRequests++
          return sse(
            res,
            n === 0
              ? toolCall("create_card", { name: "Forbidden" }, "child-create")
              : n === 1
                ? toolCall("list_library", { kind: "card" }, "child-list")
                : completionChunks(["Report: the library holds what the reply listed."], {})
          )
        }
        if (!text(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
        const done = body.messages.filter((m) => m.role === "tool").length
        return sse(
          res,
          done === 0
            ? toolCall("list_library", { kind: "card" }, "parent-list")
            : done === 1
              ? toolCall(
                  "agent",
                  { type: "research", task: "Check the list above against the library.", context: "fork" },
                  "spawn"
                )
              : completionChunks(["Done."], {})
        )
      }
      const { api, chat, events, mock } = yield* workshop(handler)
      const versionId = yield* task(api, chat, "list, then fork a check")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      assert.strictEqual(finished(events, versionId)!.status, "complete")

      const bodies = completions(mock.requests())
      const forks = bodies.filter((b) => text(b).includes(FORK))
      assert.lengthOf(forks, 3)
      const spawning = bodies.find(
        (b) =>
          text(b).includes(TRIGGER) &&
          !text(b).includes(FORK) &&
          b.messages.filter((m) => m.role === "tool").length === 1
      )!
      // Its request is the reply's, as the reply was just sent, then its task.
      const first = forks[0]!
      assert.deepStrictEqual(first.messages.slice(0, -1), spawning.messages)
      assert.strictEqual(first.messages.at(-1)!.role, "user")
      assert.include(JSON.stringify(first.messages.at(-1)!.content), "Check the list above against the library.")
      // The same tool definitions on the wire, so the provider reads the prefix from cache.
      assert.deepStrictEqual(first.tools, (spawning as { tools?: unknown }).tools as Body["tools"])
      // But it may use only its own tools: the reply's create_card isn't one.
      const created = forks[1]!.messages.filter((m) => m.role === "tool")
      assert.include(JSON.stringify(created.at(-1)!.content), "not found")
      const [made] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT count(*) AS n FROM entity_revisions WHERE doc_json LIKE '%Forbidden%'" }],
        { readOnly: true }
      )
      assert.strictEqual(made![0]!["n"], 0)

      // Its row: a fork, with its own steps only (not the reply's list_library).
      const steps = yield* api.GetRolloutSteps({ versionId })
      const spawn = steps.find((s) => s.kind === "tool" && s.id === "spawn")
      const row = spawn?.kind === "tool" ? spawn.subagent : undefined
      assert.strictEqual(row?.status, "done")
      assert.isTrue(row?.forked)
      assert.deepStrictEqual(
        row?.steps?.map((s) => (s.kind === "tool" ? s.id : s.kind)),
        ["child-create", "child-list"]
      )
      assert.strictEqual(row?.count, 2)
      // The inspector shows its run from its task on.
      const run = yield* api.GetSubagentRun({ versionId, rolloutId: row!.rolloutId })
      assert.notInclude(JSON.stringify(run.entries), "parent-list")
      assert.include(JSON.stringify(run.entries), "child-list")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a fork runs only on the reply's own model", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const handler = (request: Recorded, res: ServerResponse) => {
        const body = request.body as unknown as Body
        if (!body?.messages || !text(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
        const done = body.messages.filter((m) => m.role === "tool").length
        return sse(
          res,
          done === 0
            ? toolCall("agent", { type: "research", task: "Anything.", context: "fork", model: "fast" }, "spawn")
            : completionChunks(["Done."], {})
        )
      }
      const { api, chat, events, mock } = yield* workshop(handler)
      const versionId = yield* task(api, chat, "fork on another model")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      const last = completions(mock.requests())
        .filter((b) => text(b).includes(TRIGGER))
        .at(-1)!
      const result = JSON.stringify(last.messages.filter((m) => m.role === "tool").at(-1)!.content)
      // `fast` isn't picked here; either way no fork runs on another model.
      assert.match(result, /no subagent model|only on the model this chat uses/)
      assert.isFalse(completions(mock.requests()).some((b) => text(b).includes("From here on you are a subagent")))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("types: the user's own, changes to a built-in one, and a plugin's, as the agent tool offers them", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const CHECKER = "You are a checker subagent."
      let spawn: Record<string, unknown> = { type: "checker", task: "Check the card names." }
      const handler = (request: Recorded, res: ServerResponse) => {
        const body = request.body as unknown as Body
        if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
        if (text(body).includes(CHECKER) && !text(body).includes(TRIGGER))
          return sse(res, completionChunks(["Names look fine."], {}))
        if (!text(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
        const at = body.messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
        const done = body.messages.slice(at).filter((m) => m.role === "tool").length
        return sse(res, done === 0 ? toolCall("agent", spawn, `spawn-${at}`) : completionChunks(["Done."], {}))
      }
      const { api, chat, events, mock } = yield* workshop(handler)
      const registry = yield* ExecutionRegistry

      // Validation: a tool workshops don't offer, and a new type without instructions.
      const unknownTool = yield* api
        .ChangeSubagentType({
          id: "checker",
          edit: { id: "checker", label: "Check", instructions: CHECKER, tools: ["no_such_tool"] }
        })
        .pipe(Effect.flip)
      assert.strictEqual(unknownTool._tag, "SubagentSettingsRejected")
      const incomplete = yield* api
        .ChangeSubagentType({ id: "checker", edit: { id: "checker", label: "Check" } })
        .pipe(Effect.flip)
      assert.strictEqual(incomplete._tag, "SubagentSettingsRejected")

      // The user's own type, with one tool.
      yield* api.ChangeSubagentType({
        id: "checker",
        edit: {
          id: "checker",
          label: "Check names",
          description: "Checks card names.",
          instructions: CHECKER,
          tools: ["list_library"]
        }
      })
      // A plugin's type, plain data.
      yield* registry.subagentTypes.register({
        id: "plugged",
        label: "From a plugin",
        description: "A plugin's type.",
        kinds: ["workshop"],
        tools: { effects: ["read"] },
        defaultAlias: "same",
        instructions: "You are a plugin's subagent."
      })
      // Saving a built-in type unchanged keeps no change.
      const listed = yield* api.GetSubagentTypes({})
      const research = listed.types.find((t) => t.id === "research")!
      yield* api.ChangeSubagentType({
        id: "research",
        edit: {
          id: "research",
          label: research.label,
          description: research.description,
          instructions: research.instructions,
          tools: [...research.tools],
          defaultAlias: research.defaultAlias,
          context: research.context
        }
      })
      assert.deepStrictEqual((yield* api.GetSubagentSettings({})).types, [
        {
          id: "checker",
          label: "Check names",
          description: "Checks card names.",
          instructions: CHECKER,
          tools: ["list_library"],
          defaultAlias: "same",
          context: "task"
        }
      ])
      const types = (yield* api.GetSubagentTypes({})).types
      assert.deepStrictEqual(
        types.map((t) => [t.id, t.source]),
        [
          ["research", "builtin"],
          ["plugged", "plugin"],
          ["checker", "user"]
        ]
      )
      // The story helper isn't listed (it has its own settings) and can't be changed here.
      const helper = yield* api
        .ChangeSubagentType({ id: "helper", edit: { id: "helper", off: true } })
        .pipe(Effect.flip)
      assert.include(helper.message, "its own settings")
      assert.deepStrictEqual(types.find((t) => t.id === "checker")!.tools, ["list_library"])
      assert.isTrue(types.find((t) => t.id === "research")!.tools.includes("list_library"))

      // Research turned off, the checker run: the agent tool lists what's offered, and the child
      // gets its own instructions and only its own tool (and report_progress).
      yield* api.ChangeSubagentType({ id: "research", edit: { ...research, off: true } })
      const versionId = yield* task(api, chat, "check names")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      const bodies = completions(mock.requests())
      const parent = bodies.find((b) => text(b).includes(TRIGGER))!
      const agent = JSON.stringify((parent.tools ?? []).find((t) => t.function.name === "agent"))
      assert.include(agent, "checker")
      assert.include(agent, "plugged")
      assert.notInclude(agent, '\\"research\\"')
      const child = bodies.find((b) => text(b).includes(CHECKER) && !text(b).includes(TRIGGER))!
      assert.deepStrictEqual((child.tools ?? []).map((t) => t.function.name).sort(), [
        "list_library",
        "report_progress"
      ])
      const steps = yield* api.GetRolloutSteps({ versionId })
      const row = steps.find((s) => s.kind === "tool" && s.tool === "agent")
      assert.strictEqual(row?.kind === "tool" ? row.subagent?.typeLabel : undefined, "Check names")

      // A type turned off isn't started.
      spawn = { type: "research", task: "Anything." }
      const off = yield* task(api, chat, "research while it's off")
      yield* eventually(() => finished(events, off) !== undefined, 60_000)
      const last = completions(mock.requests())
        .filter((b) => text(b).includes(TRIGGER))
        .at(-1)!
      assert.include(JSON.stringify(last.messages.at(-1)!.content), "no subagent type")

      // Restore drops the change; deleting the user's type removes it.
      yield* api.ChangeSubagentType({ id: "research", edit: null })
      yield* api.ChangeSubagentType({ id: "checker", edit: null })
      const after = (yield* api.GetSubagentTypes({})).types
      assert.isFalse(after.find((t) => t.id === "research")!.off)
      assert.isFalse(after.some((t) => t.id === "checker"))
      // The workshop's assistant may write types (as a setup change), never models or limits.
      assert.isDefined(settingsRegistry.get("subagents.types")?.agent)
      assert.isUndefined(settingsRegistry.get("subagents.models")?.agent)
      assert.isUndefined(settingsRegistry.get("subagents.limits")?.agent)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
