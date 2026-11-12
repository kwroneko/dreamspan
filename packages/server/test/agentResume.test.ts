// Resuming agent rollouts (spec/AGENTIC.md §4.2, §4.4; DESIGN §7.5): the interruption policies
// on synthetic transcripts, then through real generation against a scripted OpenAI-compatible
// mock. A resumed run sends the requests the stopped one would have sent, so the model can't
// tell; it's a new version sourced from the stopped one; the effects of the tool calls it keeps
// come with it, and those of a cut tail don't.
import { assert, describe, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { Deferred, Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import type { ServerResponse } from "node:http"
import { planResume, planStepResume, StepNotResumable } from "../src/agent/resume.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

// --- Synthetic transcripts

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const turn = (content: Array<unknown>, stopReason = "toolUse"): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "m",
    usage,
    stopReason,
    timestamp: 0
  }) as AgentMessage
const call = (id: string, args: unknown = { topic: "lighthouse" }) => ({
  type: "toolCall",
  id,
  name: "look_up",
  arguments: args
})
const result = (id: string, text = "Ansel.", details: unknown = null): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "look_up",
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp: 0
  }) as AgentMessage
const kickoff = { role: "rpRequest", timestamp: 0 } as AgentMessage
const json = (messages: ReadonlyArray<AgentMessage>) => JSON.stringify(messages)
const roles = (messages: ReadonlyArray<AgentMessage>) => messages.map((m) => m.role)

describe("resume policies", () => {
  it("a tool call without its result is run again", () => {
    const plan = planResume(json([kickoff, turn([call("c1")])]), { prefill: true })
    assert.strictEqual(plan.policy, "rerun")
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant"])
    assert.deepStrictEqual(plan.keptCalls, ["c1"])
    assert.isEmpty(plan.cut)
  })

  it("a call a stop cut short loses its result and is run again", () => {
    const stopped = [kickoff, turn([call("c1")]), result("c1", "Stopped.", { interrupted: true })]
    const plan = planResume(json(stopped), { prefill: false })
    assert.strictEqual(plan.policy, "rerun")
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant"])
  })

  it("a turn cut off inside a tool call is resampled", () => {
    const cut = turn([{ type: "text", text: "Let me" }, call("partial-1")], "aborted")
    const plan = planResume(json([kickoff, turn([call("c1")]), result("c1"), cut]), { prefill: true })
    assert.strictEqual(plan.policy, "resample")
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant", "toolResult"])
    assert.deepStrictEqual(plan.cut, [cut])
    assert.isUndefined(plan.continuation)
  })

  it("text cut off is continued through a prefill where the model takes one, else resampled", () => {
    const cut = turn(
      [
        { type: "thinking", thinking: "Hm." },
        { type: "text", text: "Ansel wa" }
      ],
      "error"
    )
    const messages = json([kickoff, turn([call("c1")]), result("c1"), cut])
    const prefilled = planResume(messages, { prefill: true })
    assert.strictEqual(prefilled.policy, "continuation")
    assert.strictEqual(prefilled.continuation, "Ansel wa")
    assert.deepStrictEqual(roles(prefilled.transcript), ["rpRequest", "assistant", "toolResult"])
    const plain = planResume(messages, { prefill: false })
    assert.strictEqual(plain.policy, "resample")
    assert.isUndefined(plain.continuation)
  })

  it("an empty, corrupt or kickoff-only transcript starts over from the frozen request", () => {
    for (const stored of [null, "{", "[]", json([kickoff]), json([kickoff, turn([], "aborted")])])
      assert.strictEqual(planResume(stored, { prefill: true }).policy, "fresh", String(stored))
  })

  const tools = [{ name: "look_up", description: "", parameters: {}, effect: "read" as const, label: "Looked up" }]
  const run = [
    kickoff,
    turn([{ type: "text", text: "Checking." }, call("c1"), call("c2", { topic: "harbour" })]),
    result("c1"),
    result("c2", "Brann."),
    turn([{ type: "text", text: "Ansel waves." }], "stop")
  ]

  it("editing a text step keeps its turn's results and cuts what followed", () => {
    const plan = planStepResume(json(run), tools, 0, { kind: "text", text: "Looking." }, "new")
    assert.notInstanceOf(plan, StepNotResumable)
    if (plan instanceof StepNotResumable) return
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant", "toolResult", "toolResult"])
    assert.deepInclude((plan.transcript[1] as { content: Array<unknown> }).content[0], { text: "Looking." })
    assert.strictEqual(plan.policy, "continue")
    assert.strictEqual(plan.cut.length, 4)
  })

  it("editing a call's arguments runs it again under a new id, without the calls after it", () => {
    const plan = planStepResume(json(run), tools, 1, { kind: "arguments", arguments: { topic: "pier" } }, "new")
    if (plan instanceof StepNotResumable) return assert.fail(plan.message)
    assert.strictEqual(plan.policy, "rerun")
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant"])
    const content = (plan.transcript[1] as { content: Array<unknown> }).content
    assert.deepStrictEqual(content.at(-1), {
      type: "toolCall",
      id: "new",
      name: "look_up",
      arguments: { topic: "pier" }
    })
    assert.strictEqual(content.length, 2)
    assert.deepStrictEqual(plan.keptCalls, [])
  })

  it("editing a result replaces it; the turn's later calls run again", () => {
    const plan = planStepResume(json(run), tools, 1, { kind: "result", text: "Mott." }, "new")
    if (plan instanceof StepNotResumable) return assert.fail(plan.message)
    assert.strictEqual(plan.policy, "rerun")
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant", "toolResult"])
    assert.deepInclude(plan.transcript[2], { toolCallId: "c1", content: [{ type: "text", text: "Mott." }] })
    assert.deepStrictEqual(plan.keptCalls, ["c1", "c2"])
  })

  it("resuming from an unedited call cuts after its result; a step that isn't there is refused", () => {
    const plan = planStepResume(json(run), tools, 2, undefined, "new")
    if (plan instanceof StepNotResumable) return assert.fail(plan.message)
    assert.deepStrictEqual(roles(plan.transcript), ["rpRequest", "assistant", "toolResult", "toolResult"])
    assert.strictEqual(plan.policy, "continue")
    assert.instanceOf(planStepResume(json(run), tools, 9, undefined, "new"), StepNotResumable)
    assert.instanceOf(planStepResume(null, tools, 0, undefined, "new"), StepNotResumable)
  })
})

// --- Through generation

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
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
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  { id: "cmpl-t", object: "chat.completion.chunk", model: "served-model", choices: [], usage: { prompt_tokens: 9 } }
]

type Body = { readonly messages: Array<Record<string, unknown>>; readonly tools?: Array<unknown> }
const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
const tools = (body: Body) => body.messages.filter((m) => m.role === "tool").length

const rolloutOf = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT r.*, p.context_snapshot_json AS snapshot, p.transcript_json AS transcript, v.origin,
           v.source_version_id, v.status AS version_status
         FROM versions v JOIN rollouts r ON r.id = v.rollout_id JOIN rollout_payloads p ON p.rollout_id = r.id
         WHERE v.id = ?`
      )
      .get(versionId) as Record<string, string | number | null>
  } finally {
    db.close()
  }
}

const lookup = (behave: () => Effect.Effect<string>): RolloutTool<{ readonly topic: string }> => ({
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  execute: () => Effect.map(behave(), (text) => ({ text }))
})

const narrator = (toolIds: ReadonlyArray<string>, contract: "final_text" | "both" = "final_text") =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    yield* registry.orchestrationModes.register({
      ...registry.orchestrationModes.get("default")!,
      plan: () => ({ strategy: "agent", tools: toolIds, contract, turnCap: 6 })
    })
  })

const mode = [{ key: "agent.enabled" as const, value: { on: true } }]

describe("resuming agent replies", () => {
  it.live("a crash after send_message's result restores the sent text without another model turn", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* narrator([], "both")
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) =>
            sse(
              res,
              tools(request.body as unknown as Body) === 0
                ? toolCall("send_message", { message: "Mira keeps the ledger." }, "sent")
                : completionChunks(["Unexpected next turn."], { prompt_tokens: 20, completion_tokens: 1 })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: mode
      })
      assert.strictEqual(version.content, "Mira keeps the ledger.")
      const row = rolloutOf(config.dataDir, version.id)
      // The transcript's terminal tool result reached disk; FinishRollout has not yet run.
      const db = new DatabaseSync(databaseFile(config.dataDir))
      db.exec("PRAGMA busy_timeout = 5000")
      db.prepare("UPDATE rollouts SET status = 'interrupted' WHERE id = ?").run(row.id as string)
      db.close()
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const slot = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const entry = yield* api.ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const [provenance] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT v.authoring_fork_id, r.fork_id FROM versions v JOIN rollouts r ON r.id=v.rollout_id WHERE v.id=?",
            params: [entry.version.id]
          }
        ],
        { readOnly: true }
      )
      assert.lengthOf(provenance!, 1)
      assert.strictEqual(provenance![0]!.authoring_fork_id, provenance![0]!.fork_id)
      assert.strictEqual(finished(events, entry.version.id)!.content, version.content)
      assert.strictEqual(bodies(mock.requests()).length, 1, "the terminal send is already durable")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const interruptedCall of [0, 1, 2])
    it.live(`replays the committed note call ${interruptedCall + 1} before validating changed state`, () => {
      const config = testConfig()
      const script = [
        ["write_note", { title: "Injury", content: "A grey bandage." }],
        ["edit_note", { note: "Injury", find: "grey", replace: "red" }],
        ["edit_card", { character: "Mira", field: "description", find: "grey coat", replace: "red gown" }]
      ] as const
      return Effect.gen(function* () {
        yield* narrator(script.map(([name]) => name))
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const done = tools(request.body as unknown as Body)
              const next = script[done]
              sse(
                res,
                next
                  ? toolCall(next[0], next[1], `call_${done}`)
                  : completionChunks(["Done."], { prompt_tokens: 20, completion_tokens: 1 })
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const { version, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          mira: { description: "She wears a grey coat.", agent_editable_fields: ["description"] },
          state: mode
        })
        const row = rolloutOf(config.dataDir, version.id)
        // Crash after committing the effect but before saving that call's result.
        const transcript = JSON.parse(row.transcript as string) as Array<{ role: string }>
        const callAt = transcript.findIndex((m) => m.role === "assistant") + interruptedCall * 2
        const db = new DatabaseSync(databaseFile(config.dataDir))
        db.exec("PRAGMA busy_timeout = 5000")
        db.prepare("UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?").run(
          JSON.stringify(transcript.slice(0, callAt + 1)),
          row.id as string
        )
        db.prepare("UPDATE rollouts SET status = 'interrupted' WHERE id = ?").run(row.id as string)
        db.close()
        const before = bodies(mock.requests())
        const me = yield* api.Whoami()
        const reader = yield* Reader
        const slot = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
        const entry = yield* api.ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        assert.strictEqual(finished(events, entry.version.id)!.content, "Done.")
        const after = bodies(mock.requests()).slice(before.length)
        assert.deepStrictEqual(after[0], before[interruptedCall + 1], "the receipt restores the original result")
        const inspect = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
        const resumed = rolloutOf(config.dataDir, entry.version.id)
        const receipts = inspect
          .prepare("SELECT tool_call_id FROM rollout_receipts WHERE rollout_id = ?")
          .all(resumed.id as string)
        assert.strictEqual(receipts.length, 3)
        const revisions = inspect
          .prepare("SELECT count(*) AS n FROM entity_revisions WHERE origin_ref = ?")
          .get(`${resumed.id}:call_${interruptedCall}`)
        assert.strictEqual(revisions!.n, 0, "a receipted call makes no new note revisions")
        inspect.close()
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a stop mid-tool resumes as a new version that runs the call again, unseen by the model", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const started = yield* Deferred.make<VersionId>()
      let runs = 0
      const registry = yield* ExecutionRegistry
      const holding: RolloutTool<{ readonly topic: string }> = {
        ...lookup(() => Effect.succeed("The lighthouse keeper is called Ansel.")),
        execute: (context) =>
          runs++ === 0
            ? Deferred.succeed(started, context.versionId).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ text: "The lighthouse keeper is called Ansel." })
      }
      yield* registry.rolloutTools.register(holding as RolloutTool<never>)
      yield* narrator(["look_up"])
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (request: Recorded, res: ServerResponse) => {
            const body = request.body as unknown as Body
            if (tools(body) === 0) return sse(res, toolCall("look_up", { topic: "lighthouse" }, "call_1"))
            await held
            sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 3 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const me = yield* api.Whoami()
      const reader = yield* Reader
      // The tool's first run holds; the test stops the reply there.
      yield* Deferred.await(started).pipe(
        Effect.andThen((versionId) => api.StopGeneration({ versionId })),
        Effect.ignore,
        Effect.forkScoped
      )
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: mode
      })
      const stopped = generated.version
      assert.strictEqual(stopped.status, "stopped")
      const before = rolloutOf(config.dataDir, stopped.id)
      assert.strictEqual(before.status, "stopped")

      const slot = yield* reader.GetSlot({ userId: me.id, slotId: stopped.slotId })
      const entry = yield* api.ResumeVersion({ versionId: stopped.id, expectedRowVersion: slot.entry.rowVersion })
      const resumedId = entry.version.id
      assert.notStrictEqual(resumedId, stopped.id)
      assert.strictEqual(entry.version.origin, "resumed")
      assert.strictEqual(entry.version.sourceVersionId, stopped.id)
      // While it's being written, another resume of the same reply is refused.
      const again = yield* reader.GetSlot({ userId: me.id, slotId: stopped.slotId })
      const refused = yield* Effect.flip(
        api.ResumeVersion({ versionId: stopped.id, expectedRowVersion: again.entry.rowVersion })
      )
      assert.strictEqual(refused._tag, "NotResumable")
      release()
      yield* eventually(() => finished(generated.events, resumedId) !== undefined)
      const resumed = finished(generated.events, resumedId)!
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      assert.strictEqual(resumed.content, "Ansel waves.")
      assert.strictEqual(runs, 2, "the call was run again")

      // The model was sent its own request again, then the call and its result: as if never stopped.
      const sent = bodies(mock.requests())
      assert.strictEqual(sent.length, 2)
      const [first, second] = sent as [Body, Body]
      assert.deepStrictEqual(second.messages.slice(0, first.messages.length), first.messages)
      assert.deepStrictEqual(second.tools, first.tools)
      assert.deepStrictEqual(second.messages.slice(first.messages.length), [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "look_up", arguments: '{"topic":"lighthouse"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "The lighthouse keeper is called Ansel." }
      ])
      assert.notInclude(JSON.stringify(second), "Stopped.")

      const after = rolloutOf(config.dataDir, resumedId)
      assert.deepInclude(after, {
        status: "completed",
        parent_rollout_id: before.id,
        mode: "default",
        origin: "resumed",
        source_version_id: stopped.id,
        step_count: 1
      })
      assert.strictEqual(after.snapshot, before.snapshot)
      assert.deepStrictEqual(
        (JSON.parse(after.transcript as string) as Array<{ role: string }>)
          .map((m) => m.role)
          .filter((r) => r !== "system"),
        ["rpRequest", "assistant", "toolResult", "assistant"]
      )
      // The stopped version is as it was.
      assert.strictEqual(rolloutOf(config.dataDir, stopped.id).version_status, "stopped")
      assert.deepInclude((yield* api.GetRolloutSteps({ versionId: resumedId }))[0], { status: "done", tool: "look_up" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a reply interrupted by a restart mid-call resumes with the exact request it would have made", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(
        lookup(() => Effect.succeed("The lighthouse keeper is called Ansel.")) as RolloutTool<never>
      )
      yield* narrator(["look_up"])
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) =>
            tools(request.body as unknown as Body) === 0
              ? sse(res, toolCall("look_up", { topic: "lighthouse" }, "call_1"))
              : sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 3 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: mode
      })
      assert.strictEqual(version.content, "Ansel waves.")
      // What a crash during the call leaves: the call saved without its result, and at the
      // next start the rollout and its version interrupted (InterruptRollouts, Generations).
      const row = rolloutOf(config.dataDir, version.id)
      const kept = (JSON.parse(row.transcript as string) as Array<{ role: string }>).slice(0, -2)
      assert.strictEqual(kept.at(-1)?.role, "assistant")
      const db = new DatabaseSync(databaseFile(config.dataDir))
      db.exec("PRAGMA busy_timeout = 5000")
      db.prepare("UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?").run(
        JSON.stringify(kept),
        row.id as string
      )
      db.prepare("UPDATE rollouts SET status = 'interrupted' WHERE id = ?").run(row.id as string)
      db.close()

      const me = yield* api.Whoami()
      const reader = yield* Reader
      const slot = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const entry = yield* api.ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.strictEqual(finished(events, entry.version.id)!.content, "Ansel waves.")
      const sent = bodies(mock.requests())
      assert.strictEqual(sent.length, 3)
      assert.deepStrictEqual(sent[2], sent[1], "the resumed request is the one the run had sent")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("text cut off by an error goes on through a prefill, without tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup(() => Effect.succeed("Ansel.")) as RolloutTool<never>)
      yield* narrator(["look_up"])
      let first = true
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            if (!first) return sse(res, completionChunks(["ves."], { prompt_tokens: 20, completion_tokens: 2 }))
            first = false
            // The text starts, and the connection drops.
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write(`data: ${JSON.stringify(completionChunks(["Ansel wa"], {})[0])}\n\n`)
            setTimeout(() => res.destroy(), 50)
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" },
        state: mode
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.content, "Ansel wa")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const slot = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const entry = yield* api.ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const resumed = finished(events, entry.version.id)!
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      assert.strictEqual(resumed.content, "Ansel waves.")
      const [original, carried] = bodies(mock.requests()) as [Body, Body]
      assert.deepStrictEqual(carried.messages.slice(0, -1), original.messages)
      assert.deepInclude(carried.messages.at(-1), { role: "assistant", content: "Ansel wa" })
      assert.isEmpty(carried.tools ?? [])
      const transcript = JSON.parse(rolloutOf(config.dataDir, entry.version.id).transcript as string) as Array<{
        role: string
        content: Array<{ type: string; text?: string }>
      }>
      assert.deepInclude(transcript.at(-1)!.content, { type: "text", text: "Ansel waves." })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("editing a step resumes as a new version: kept calls' effects come along, cut ones' don't", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(
        lookup(() => Effect.succeed("The lighthouse keeper is called Ansel.")) as RolloutTool<never>
      )
      yield* narrator(["set_presence", "look_up"])
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const done = tools(request.body as unknown as Body)
            if (done === 0) return sse(res, toolCall("set_presence", { character: "Mira", present: false }, "call_1"))
            if (done === 1) return sse(res, toolCall("look_up", { topic: "lighthouse" }, "call_2"))
            sse(res, completionChunks(["Done."], { prompt_tokens: 20, completion_tokens: 1 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, chat, mira } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: mode
      })
      assert.strictEqual(version.content, "Done.")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const absent = Effect.map(
        reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId }),
        (e) => foldState(e).away
      )
      assert.deepStrictEqual(yield* absent, [mira.entityId])
      const resumeFrom = (step: number, edit?: Parameters<typeof api.ResumeFromStep>[0]["edit"]) =>
        Effect.gen(function* () {
          const slot = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
          const entry = yield* api.ResumeFromStep({
            versionId: version.id,
            step,
            ...(edit ? { edit } : {}),
            expectedRowVersion: slot.entry.rowVersion
          })
          yield* eventually(() => finished(events, entry.version.id) !== undefined)
          return finished(events, entry.version.id)!
        })

      // A new result for the lookup: Mira's going away was before it, so it holds.
      const edited = yield* resumeFrom(1, { kind: "result", text: "The keeper is called Brann." })
      assert.strictEqual(edited.status, "complete", JSON.stringify(edited.error))
      assert.strictEqual(edited.origin, "resumed")
      const lastSent = bodies(mock.requests()).at(-1)!
      assert.deepInclude(lastSent.messages.at(-1), { role: "tool", content: "The keeper is called Brann." })
      assert.deepStrictEqual(yield* absent, [mira.entityId])
      const branch = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const cut = branch
        .prepare("SELECT reason FROM rollout_branches WHERE rollout_id = ?")
        .all(rolloutOf(config.dataDir, edited.id).id as string)
      branch.close()
      assert.deepStrictEqual(
        cut.map((r) => r.reason),
        ["edit"]
      )

      // New arguments for the first call: it runs again under a new id, and her going away goes.
      const rerun = yield* resumeFrom(0, { kind: "arguments", arguments: { character: "Mira", present: true } })
      assert.strictEqual(rerun.status, "complete", JSON.stringify(rerun.error))
      assert.deepStrictEqual(yield* absent, [])
      const sentAfter = bodies(mock.requests())
      const rerunFirst = sentAfter.at(-2)!
      const calledWith = (rerunFirst.messages.at(-2) as { tool_calls: Array<{ id: string; function: unknown }> })
        .tool_calls[0]!
      assert.notStrictEqual(calledWith.id, "call_1")
      assert.deepStrictEqual(calledWith.function, {
        name: "set_presence",
        arguments: '{"character":"Mira","present":true}'
      })
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const presence = db
        .prepare("SELECT value_json FROM state_events WHERE version_id = ? AND key = 'away.set'")
        .all(rerun.id)
      db.close()
      assert.strictEqual(presence.length, 1, "only the re-run call's effect")
      // The edited and re-run versions are new; the first is unchanged and still selectable.
      assert.strictEqual(rolloutOf(config.dataDir, version.id).version_status, "complete")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
