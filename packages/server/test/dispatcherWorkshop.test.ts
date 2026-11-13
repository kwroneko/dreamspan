// Real loop, canonical persistence/consent/receipt/Undo and transport switches. Fake provider only.
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import { Effect, Stream } from "effect"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { Reader } from "../src/db/Database.ts"
import { loadedSet } from "../src/agent/toolLoading.ts"
import { liveSuffix } from "../src/agent/messages.ts"
import { dispatcherMessages } from "../src/agent/dispatcher.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { FrozenTool } from "../src/agent/tools.ts"
import { DISPATCH_DEFINITIONS, dispatcherDefinition } from "../src/agent/dispatcher.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Body = {
  tools?: Array<{ function: { name: string } }>
  messages: Array<{
    role: string
    content: string
    tool_call_id?: string
    tool_calls?: Array<{ function: { name: string; arguments: string } }>
  }>
}
const call = (name: string, args: unknown, id: string) => [
  {
    id: "synthetic",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          reasoning_content: "Synthetic reasoning.",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "synthetic",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const waiting = (events: ReadonlyArray<ChatEvent>, version: string): ApprovalPrompt | undefined => {
  const steps = events.flatMap((e) => (e._tag === "Steps" && e.versionId === version ? [e.steps] : [])).at(-1) ?? []
  const step = steps.find((s) => s.kind === "tool" && s.status === "waiting")
  return step?.kind === "tool" ? step.approval : undefined
}

it.live("dispatches through canonical approvals, receipts, step edits, capability Off and Undo", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const steps = [
      ["call_tool", { name: "read_card", arguments: { card: "Assistant" } }, "unloaded"],
      ["tool_search", { query: "select:read_card,create_card" }, "load"],
      ["call_tool", { name: "create_card", arguments: { name: "Bad", unexpected: true } }, "invalid"],
      ["call_tool", { name: "list_library", arguments: { kind: "card" } }, "immediate"],
      ["call_tool", { name: "read_card", arguments: { card: "Assistant" } }, "read"],
      ["call_tool", { name: "create_card", arguments: { name: "Dispatcher card" } }, "create"]
    ] as const
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.messages) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ data: [] }))
            return
          }
          if (!JSON.stringify(body.messages).includes("DISPATCH TASK"))
            return sse(res, completionChunks(["Ready."], {}))
          const task = body.messages.findLastIndex(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("DISPATCH TASK")
          )
          const done = body.messages.slice(task).filter((m) => m.role === "tool").length
          const step = steps[done]
          sse(res, step ? call(step[0], step[1], step[2]) : completionChunks(["Done."], {}))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const setup = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "dispatcher" } },
      model: {}
    })
    const chat = yield* api.CreateWorkshop({})
    yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const user = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "DISPATCH TASK" })
    )
    const from = mock.requests().length
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
    const id = reply.entry.version.id
    yield* eventually(() => waiting(events, id) !== undefined)
    const prompt = waiting(events, id)!
    assert.include(prompt.title, "Dispatcher card")
    assert.strictEqual(prompt.capability, "library.write")
    const pending = yield* api.GetRunTranscript({ versionId: id })
    assert.isTrue(
      pending.entries.some(
        (e) => e.role === "assistant" && e.parts.some((p) => p.type === "toolCall" && p.name === "create_card")
      )
    )
    assert.isFalse(pending.entries.some((e) => e.role === "toolResult" && e.tool === "call_tool"))
    assert.lengthOf(
      (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Dispatcher card"),
      0
    )
    yield* api.AnswerToolApproval({
      rolloutId: prompt.rolloutId,
      toolCallId: prompt.toolCallId,
      digest: prompt.digest,
      answer: "allow"
    })
    yield* eventually(() => finished(events, id) !== undefined)
    assert.strictEqual(finished(events, id)!.status, "complete")
    const bodies = mock
      .requests()
      .slice(from)
      .map((r) => r.body as unknown as Body)
    const tools = JSON.stringify(bodies[0]!.tools)
    for (const body of bodies) assert.strictEqual(JSON.stringify(body.tools), tools)
    assert.deepStrictEqual(
      bodies[0]!.tools!.map((t) => t.function.name),
      ["list_library", "tool_search", "load_skill", "send_message", "call_tool"]
    )
    assert.include(bodies[1]!.messages.at(-1)!.content, "Tool read_card not found")
    assert.include(bodies[2]!.messages.at(-1)!.content, DISPATCH_DEFINITIONS)
    assert.include(bodies[3]!.messages.at(-1)!.content, "arguments don't fit")
    assert.include(bodies[4]!.messages.at(-1)!.content, "Tool list_library not found")
    const raw = bodies
      .at(-1)!
      .messages.flatMap((m) => m.tool_calls ?? [])
      .find(
        (c) =>
          JSON.parse(c.function.arguments).name === "create_card" &&
          JSON.parse(c.function.arguments).arguments.name === "Dispatcher card"
      )!
    assert.strictEqual(raw.function.name, "call_tool")
    const createStep = (yield* api.GetRolloutSteps({ versionId: id })).findIndex(
      (s) => s.kind === "tool" && s.id === "create"
    )
    assert.isAtLeast(createStep, 0)
    const effects = yield* api.ListVersionEffects({ versionId: id })
    assert.lengthOf(effects, 1)
    const reader = yield* Reader
    const me = yield* api.Whoami()
    const slot = yield* reader.GetSlot({ userId: me.id, slotId: reply.entry.slotId })
    const material = yield* reader.RolloutMaterial({ userId: me.id, versionId: id })
    const frozen = JSON.parse(material.snapshot) as {
      inputs: { model: unknown }
      request: unknown
      agent: { tools: FrozenTool[] }
    }
    const count = (transcript: string, tools: FrozenTool[]) =>
      reader.CountRolloutContext({
        model: JSON.stringify(frozen.inputs.model),
        request: JSON.stringify(frozen.request),
        transcript,
        tools: JSON.stringify(tools)
      })
    const loaded = loadedSet(
      JSON.parse(material.transcript!) as AgentMessage[],
      new Set(frozen.agent.tools.filter((t) => t.deferred).map((t) => t.name))
    )
    const actualCount = yield* count(
      material.transcript!,
      frozen.agent.tools.filter((t) => !t.deferred || loaded.has(t.name))
    )
    const rendered = dispatcherMessages(
      liveSuffix(JSON.parse(material.transcript!) as AgentMessage[]),
      frozen.agent.tools
        .filter((t) => t.deferred)
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as never }))
    )
    const wireCount = yield* count(
      JSON.stringify(rendered),
      frozen.agent.tools.filter((t) => !t.deferred)
    )
    assert.strictEqual(
      actualCount,
      wireCount,
      "dispatcher budgets must count the replay wrappers and text definitions, with only its fixed declarations"
    )

    // A restart/deploy must keep the frozen transport definition as well as the real tools.
    const originalDescription = dispatcherDefinition.description
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        dispatcherDefinition.description = originalDescription
      })
    )
    dispatcherDefinition.description = "A newer dispatcher definition, not the one this run offered."
    const replayFrom = mock.requests().length
    // Keeping the successful create result must never ask or create twice.
    const replay = yield* api.ResumeFromStep({
      versionId: id,
      step: createStep,
      expectedRowVersion: slot.entry.rowVersion
    })
    yield* eventually(() => finished(events, replay.version.id) !== undefined)
    assert.lengthOf(
      (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Dispatcher card"),
      1
    )
    assert.lengthOf(yield* api.ListVersionEffects({ versionId: replay.version.id }), 1)
    const replayBody = mock
      .requests()
      .slice(replayFrom)
      .find((r) => r.body && Array.isArray(r.body.messages))!.body as unknown as Body
    assert.strictEqual(JSON.stringify(replayBody.tools), tools)
    dispatcherDefinition.description = originalDescription
    // A model switch on a several-message Resume retains canonical calls and changes only transport.
    let selected = replay
    for (const mode of ["every", "native", "dispatcher"] as const) {
      const connection = yield* api.CreateConnection({
        kind: "openrouter",
        settings: {
          name: `Switch ${mode}`,
          baseUrl: `${mock.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null,
          providerSettings: { toolLoading: mode === "native" ? "auto" : mode }
        },
        apiKey: "synthetic-key"
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "anthropic/claude-sonnet-4.5",
        overrides: { settings: { routing: { only: ["anthropic"], allow_fallbacks: false } } }
      })
      const slot = yield* reader.GetSlot({ userId: me.id, slotId: reply.entry.slotId })
      const from = mock.requests().length
      selected = yield* api.Regenerate({
        slotId: reply.entry.slotId,
        expectedRowVersion: slot.entry.rowVersion,
        model: { connection: connection.id, model: model.id }
      })
      yield* eventually(() => finished(events, selected.version.id) !== undefined)
      assert.strictEqual(finished(events, selected.version.id)!.status, "complete")
      const switched = mock
        .requests()
        .slice(from)
        .find((r) => r.body && Array.isArray(r.body.messages))!.body as unknown as Body
      const created = switched.messages
        .flatMap((m) => m.tool_calls ?? [])
        .find((c) => {
          const args = JSON.parse(c.function.arguments) as { name?: string; arguments?: { name?: string } }
          return args.name === "Dispatcher card" || args.arguments?.name === "Dispatcher card"
        })!
      assert.strictEqual(created.function.name, mode === "dispatcher" ? "call_tool" : "create_card")
      assert.strictEqual(
        switched.tools!.some((t) => t.function.name === "call_tool"),
        mode === "dispatcher"
      )
      assert.lengthOf(
        (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Dispatcher card"),
        1
      )
      assert.lengthOf(yield* api.ListVersionEffects({ versionId: selected.version.id }), 1)
      assert.include(
        (yield* api.GetRunContext({ versionId: selected.version.id })).continuity?.reason ?? "",
        "full input cost"
      )
    }
    const undone = yield* api.UndoRolloutEffect(effects[0]!)
    assert.isNotNull(undone.undoneAt)
    // Turning Off after a frozen load refuses a newly edited call using the unknown-name text.
    yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "off" })
    const now = yield* reader.GetSlot({ userId: me.id, slotId: reply.entry.slotId })
    const refused = yield* api.ResumeFromStep({
      versionId: id,
      step: createStep,
      edit: { kind: "arguments", arguments: { name: "Forbidden card" } },
      expectedRowVersion: now.entry.rowVersion
    })
    yield* eventually(() => finished(events, refused.version.id) !== undefined)
    const refusal = yield* api.GetRunTranscript({ versionId: refused.version.id })
    assert.isTrue(
      refusal.entries.some(
        (e) => e.role === "toolResult" && e.tool === "create_card" && e.text === "Tool create_card not found"
      )
    )
    // Saved transport choice survives current connection edits on Resume.
    const current = (yield* api.ListConnections()).find((c) => c.id === setup.connection.id)!
    yield* api.UpdateConnection({
      connectionId: current.id,
      expectedRowVersion: current.rowVersion,
      settings: {
        name: current.name,
        baseUrl: current.baseUrl,
        compat: current.compat,
        cacheTtlS: current.cacheTtlS,
        maxConcurrent: current.maxConcurrent,
        presetOverrideRefId: current.presetOverrideRefId,
        providerSettings: { toolLoading: "every" }
      }
    })
    assert.strictEqual(
      yield* outcome(
        api.ResumeFromStep({
          versionId: id,
          step: createStep,
          edit: { kind: "arguments", arguments: { name: "Bad", unexpected: true } },
          expectedRowVersion: now.entry.rowVersion
        })
      ),
      "NotResumable"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("parks a dispatcher call across restart and asks under a new identity before executing", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.messages) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ data: [] }))
            return
          }
          if (!JSON.stringify(body.messages).includes("RESTART TASK")) return sse(res, completionChunks(["Ready."], {}))
          const last = body.messages.filter((m) => m.role === "tool").at(-1)
          sse(
            res,
            !last
              ? call("tool_search", { query: "select:create_card" }, "load")
              : last.tool_call_id === "load"
                ? call("call_tool", { name: "create_card", arguments: { name: "Restart card" } }, "create")
                : completionChunks(["Done."], {})
          )
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const parked = yield* Effect.gen(function* () {
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "deepseek", baseUrl: `${mock.url}/v1`, apiKey: "synthetic-key" },
        modelKey: "deepseek-flash",
        model: {}
      })
      const chat = yield* api.CreateWorkshop({})
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((b) => Effect.sync(() => events.push(...b))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const user = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "RESTART TASK"
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
      yield* eventually(() => waiting(events, reply.entry.version.id) !== undefined)
      return { chat, entry: reply.entry, old: waiting(events, reply.entry.version.id)! }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    yield* fixtureSql(config.dataDir, [
      { sql: "UPDATE tool_approvals SET status = 'pending' WHERE tool_call_id = 'create'" }
    ])
    yield* Effect.gen(function* () {
      const api = yield* client()
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: parked.chat.id }).pipe(
        Stream.runForEach((b) => Effect.sync(() => events.push(...b))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: parked.entry.slotId })
      const resumed = yield* api.ResumeVersion({
        versionId: parked.entry.version.id,
        expectedRowVersion: slot.entry.rowVersion
      })
      yield* eventually(() => waiting(events, resumed.version.id) !== undefined)
      const prompt = waiting(events, resumed.version.id)!
      assert.notStrictEqual(prompt.rolloutId, parked.old.rolloutId)
      assert.isFalse(prompt.uncertain)
      yield* api.AnswerToolApproval({
        rolloutId: prompt.rolloutId,
        toolCallId: prompt.toolCallId,
        digest: prompt.digest,
        answer: "allow"
      })
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.lengthOf(
        (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Restart card"),
        1
      )
      const body = mock.requests().at(-1)!.body as unknown as Body
      assert.include(JSON.stringify(body.messages), "reasoning_content")
      assert.include(JSON.stringify(body.messages), "call_tool")
      assert.lengthOf(yield* api.ListVersionEffects({ versionId: resumed.version.id }), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  }).pipe(Effect.scoped)
})

it.live("review: Off targets reveal no schema oracle even with malformed arguments", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let release: (() => void) | undefined
    let queries = 0
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.messages) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ data: [] }))
            return
          }
          if (!JSON.stringify(body.messages).includes("ORACLE TASK")) return sse(res, completionChunks(["Ready."], {}))
          const respond = () => {
            const steps = [
              ["tool_search", { query: "select:create_card" }, "load"],
              ["call_tool", { name: "create_card", arguments: { name: "Bad", unexpected: true } }, "bad"],
              ["call_tool", { name: "create_card", arguments: { name: "Forbidden" } }, "valid"],
              ["call_tool", { name: "no_such_tool", arguments: {} }, "unknown"]
            ] as const
            const step = steps[queries++]
            sse(res, step ? call(step[0], step[1], step[2]) : completionChunks(["Done."], {}))
          }
          if (queries === 1) release = respond
          else respond()
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "dispatcher" } },
      model: {}
    })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((b) => Effect.sync(() => events.push(...b))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const user = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "ORACLE TASK" })
    )
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
    yield* eventually(() => release !== undefined)
    yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "off" })
    release!()
    yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
    const entries = (yield* api.GetRunTranscript({ versionId: reply.entry.version.id })).entries
    for (const id of ["bad", "valid", "unknown"]) {
      const result = entries.find((e) => e.role === "toolResult" && e.toolCallId === id)
      assert.isTrue(result?.role === "toolResult")
      if (result?.role === "toolResult")
        assert.strictEqual(result.text, `Tool ${id === "unknown" ? "no_such_tool" : "create_card"} not found`)
    }
    assert.lengthOf(yield* api.ListVersionEffects({ versionId: reply.entry.version.id }), 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("review: refuses malformed completed JSON instead of executing its repaired preview", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let n = 0
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.messages) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ data: [] }))
            return
          }
          if (!JSON.stringify(body.messages).includes("MALFORMED TASK"))
            return sse(res, completionChunks(["Ready."], {}))
          if (n++ === 0) return sse(res, call("tool_search", { query: "select:create_card" }, "load"))
          if (n === 2) {
            const chunks = call("call_tool", { name: "create_card", arguments: { name: "Repaired card" } }, "malformed")
            const delta = chunks[0]!.choices[0]!.delta!
            if ("tool_calls" in delta)
              delta.tool_calls![0]!.function.arguments = '{"name":"create_card","arguments":{"name":"Repaired card"}'
            return sse(res, chunks)
          }
          if (n === 3) return sse(res, call("send_message", { message: 42 }, "bad-output"))
          sse(res, completionChunks(["Done."], {}))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "dispatcher" } },
      model: {}
    })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((b) => Effect.sync(() => events.push(...b))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const user = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "MALFORMED TASK"
      })
    )
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
    assert.lengthOf(
      (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Repaired card"),
      0
    )
    const entries = (yield* api.GetRunTranscript({ versionId: reply.entry.version.id })).entries
    const result = entries.find((e) => e.role === "toolResult" && e.toolCallId === "malformed")
    assert.isTrue(result?.role === "toolResult" && result.isError)
    const badOutput = entries.find((e) => e.role === "toolResult" && e.toolCallId === "bad-output")
    assert.isTrue(badOutput?.role === "toolResult" && badOutput.isError)
    assert.lengthOf(yield* api.ListVersionEffects({ versionId: reply.entry.version.id }), 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
