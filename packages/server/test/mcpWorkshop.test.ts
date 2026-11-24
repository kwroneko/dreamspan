// MCP servers in workshops (spec/MCP.md M2): which servers' tools a workshop offers and in what
// order, the per-workshop On and Off over the account's Workshops switch, calls through the M1
// client with their ledger rows, receipts and `mcp.call` changes, results as quoted data with a
// page for the model, Stop and timeouts cancelling the call, and Resume never re-running a call
// that may have happened without asking. A scripted loopback provider and a local fake MCP
// server only.
import { OPEN_LIBRARY } from "./support/libraryGrants.ts"
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Reader } from "../src/db/Database.ts"
import { TOOL_DATA_NOTICE } from "../src/agent/toolData.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { fakeTool, type FakeMcpServer, startFakeMcpServer } from "./support/fakeMcpServer.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
  readonly tool_call_id?: string
}
interface Body {
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string; readonly description: string } }>
}

const TRIGGER = "Workshop task:"
const callChunks = (name: string, args: unknown, id: string) => [
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

/** Calls these tools in turn after the last task, one a request, then answers. */
const scripted = (steps: ReadonlyArray<{ readonly name: string; readonly args: unknown; readonly id: string }>) => {
  let current = steps
  const handler = (request: Recorded, res: ServerResponse) => {
    const messages = (request.body as unknown as Body).messages
    if (!JSON.stringify(messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
    const done = messages.slice(lastTask).filter((m) => m.role === "tool").length
    const step = current[done]
    sse(res, step ? callChunks(step.name, step.args, step.id) : completionChunks(["Done."], {}))
  }
  return { handler, set: (next: typeof steps) => void (current = next) }
}

const chatRequests = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
const toolNames = (body: Body) => (body.tools ?? []).map((t) => t.function.name)
const toolMessages = (requests: ReadonlyArray<Recorded>) =>
  chatRequests(requests).flatMap((b) => b.messages.filter((m) => m.role === "tool"))

const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })

const waitingFor = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) => {
  const steps = events.flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? [e.steps] : [])).at(-1) ?? []
  const step = steps.find((s) => s.kind === "tool" && s.id === toolCallId)
  return step?.kind === "tool" && step.status === "waiting" ? step.approval : undefined
}
const awaitApproval = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) =>
  Effect.gen(function* () {
    yield* eventually(() => waitingFor(events, versionId, toolCallId) !== undefined)
    return waitingFor(events, versionId, toolCallId)!
  })
const answer = (api: Api, prompt: ApprovalPrompt, reply: "allow" | "deny") =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: reply
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
    return generated.entry.version.id
  })
const run = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>, content: string) =>
  Effect.gen(function* () {
    const versionId = yield* task(api, chat, content)
    yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
    return versionId
  })

const fakeServer = (tools: Array<Record<string, unknown>>) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeMcpServer({ tools })),
    (server) => Effect.promise(() => server.close())
  )
const addServer = (api: Api, server: FakeMcpServer, name: string, about = "", timeoutS = 30) =>
  Effect.gen(function* () {
    const created = yield* api.CreateMcpConnection({
      settings: { name, about, transport: "streamable-http", url: server.streamableUrl, timeoutS }
    })
    assert.isTrue(created.check.ok, created.check.detail)
    server.reset()
    return created.connection
  })

/** A model as the account default, a fresh workshop and its events. */
const workshop = (handler: (request: Recorded, res: ServerResponse) => void, context?: number) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: context === undefined ? {} : { context }
    })
    const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
    const events = yield* watch(api, chat)
    return { mock, api, chat, events }
  })

const calls = (server: FakeMcpServer) => server.methods().filter((m) => m === "tools/call")

describe("MCP servers in workshops", () => {
  it.live("offers the servers on here after the built-ins, by creation then name, the same each turn", () =>
    Effect.gen(function* () {
      const script = scripted([])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const alpha = yield* fakeServer([fakeTool("zeta"), fakeTool("alpha"), fakeTool("hidden")])
      const beta = yield* fakeServer([fakeTool("find")])
      const a = yield* addServer(api, alpha, "Alpha", "Looks things up in the alpha archive.")
      const b = yield* addServer(api, beta, "Beta")
      yield* api.SetMcpUse({ connectionId: a.id, workshops: true })
      yield* api.SetMcpUse({
        connectionId: a.id,
        tools: { choices: { hidden: { on: false } }, reviewedRevision: a.catalogRevision }
      })
      // With two tools, Automatically sends them from the start with no skill (spec/MCP.md §4.4);
      // When the model asks makes Alpha a skill. This wire carries no deferral, so all are sent.
      yield* api.SetMcpLoading({ connectionId: a.id, loading: "deferred" })

      yield* run(api, chat, events, "first")
      yield* run(api, chat, events, "second")
      const [first, second] = chatRequests(mock.requests()).filter((b) => JSON.stringify(b.messages).includes(TRIGGER))
      const names = toolNames(first!)
      const mcp = names.filter((n) => n.startsWith("mcp_"))
      assert.deepStrictEqual(mcp, ["mcp_alpha_alpha", "mcp_alpha_zeta"])
      // Built-ins first; the servers' tools follow them, before the loading and send tools.
      const firstMcp = names.indexOf("mcp_alpha_alpha")
      assert.isTrue(names.slice(0, firstMcp).every((n) => !n.startsWith("mcp_")))
      assert.isTrue(names.includes("list_library") && names.indexOf("list_library") < firstMcp)
      assert.isAbove(names.indexOf("load_skill"), names.indexOf("mcp_alpha_zeta"))
      // The skill index line is the user's own words.
      const loadSkill = first!.tools!.find((t) => t.function.name === "load_skill")!
      assert.include(loadSkill.function.description, "- mcp-alpha: Looks things up in the alpha archive.")
      // Byte for byte the same on the next turn.
      assert.strictEqual(JSON.stringify(second!.tools), JSON.stringify(first!.tools))

      // The workshop's own choice wins either way.
      const rows = yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "mcp", target: b.id, mode: "allow" })
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "mcp", target: a.id, mode: "off" })
      const server = rows.filter((r) => r.id === "mcp")
      assert.deepStrictEqual(
        server.map((r) => [r.label, r.target, r.modes, r.defaultMode]),
        [
          ["Alpha", a.id, ["off", "allow"], "allow"],
          ["Beta", b.id, ["off", "allow"], "off"]
        ]
      )
      yield* run(api, chat, events, "third")
      const third = chatRequests(mock.requests())
        .filter((b) => JSON.stringify(b.messages).includes(TRIGGER))
        .at(-1)!
      assert.deepStrictEqual(
        toolNames(third).filter((n) => n.startsWith("mcp_")),
        ["mcp_beta_find"]
      )
      // A choice the row doesn't offer is refused.
      const refused = yield* Effect.flip(
        api.SetWorkshopGrant({ chatId: chat.id, capability: "mcp", target: b.id, mode: "ask" })
      )
      assert.strictEqual(refused._tag, "GrantRefused")
      // Planning never reached either server.
      assert.isEmpty(alpha.requests())
      assert.isEmpty(beta.requests())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an enabled tool runs without asking, even one its server calls destructive, and is recorded", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_vault_wipe", args: { text: "drawer 3" }, id: "w1" }])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const vault = yield* fakeServer([fakeTool("wipe", { annotations: { destructiveHint: true } })])
      const connection = yield* addServer(api, vault, "Vault")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* run(api, chat, events, "wipe it")
      assert.strictEqual(finished(events, versionId as VersionId)!.status, "complete")
      assert.deepStrictEqual(calls(vault), ["tools/call"])
      const [result] = toolMessages(mock.requests()).filter((m) => m.tool_call_id === "w1")
      const text = String(result!.content)
      assert.include(text, TOOL_DATA_NOTICE)
      assert.include(text, "<tool_data>")
      assert.include(text, "wipe {&quot;text&quot;:&quot;drawer 3&quot;}")
      assert.include(text, "<result_metadata>")
      const [ledger, receipts] = yield* fixtureSql(
        config.dataDir,
        [
          { sql: "SELECT method, status, purpose, tool, tool_call_id, attempt FROM mcp_calls ORDER BY started_at, id" },
          { sql: "SELECT is_error FROM rollout_receipts WHERE tool_call_id = 'w1'" }
        ],
        { readOnly: true }
      )
      const workshopRows = (ledger as Array<Record<string, unknown>>).filter((r) => r.purpose === "workshop")
      assert.deepStrictEqual(workshopRows, [
        { method: "initialize", status: "complete", purpose: "workshop", tool: null, tool_call_id: null, attempt: 1 },
        { method: "tools/call", status: "complete", purpose: "workshop", tool: "wipe", tool_call_id: "w1", attempt: 1 }
      ])
      assert.deepStrictEqual(receipts, [{ is_error: 0 }])
      const effects = yield* api.ListVersionEffects({ versionId: versionId as VersionId })
      assert.deepStrictEqual(
        effects.map((e) => [e.kind, e.targetKind, e.targetId, e.title, e.undo]),
        [["mcp.call", "mcp_connection", connection.id, "Called wipe on Vault", null]]
      )
      // The step shows the outside-effect class; the Changes list has it, and it can't be undone.
      const steps = yield* api.GetRolloutSteps({ versionId: versionId as VersionId })
      const step = steps.find((s) => s.kind === "tool" && s.id === "w1")
      assert.isTrue(step?.kind === "tool" && step.effect === "external" && step.effectClass === "mcp")
      assert.isTrue(step?.kind === "tool" && step.label === "wipe (Vault)")
      // The inspector groups the tool under its server and has the call's ledger line.
      const inspected = yield* api.GetRunTranscript({ versionId: versionId as VersionId })
      const offered = inspected.tools.find((t) => t.name === "mcp_vault_wipe")!
      assert.strictEqual(offered.mcp?.connectionName, "Vault")
      assert.strictEqual(offered.mcp?.connection, connection.id)
      assert.match(offered.mcp?.host ?? "", /^127\.0\.0\.1:\d+$/)
      assert.isNumber(offered.mcp?.listedAt)
      assert.isUndefined(inspected.tools.find((t) => t.name === "list_library")?.mcp)
      assert.deepStrictEqual(
        (inspected.mcpCalls ?? []).map((c) => [c.toolCallId, c.attempt, c.status]),
        [["w1", 1, "complete"]]
      )
      assert.isAbove(inspected.mcpCalls![0]!.receivedBytes ?? 0, 0)
      const undone = yield* Effect.flip(
        api.UndoRolloutEffect({ rolloutId: effects[0]!.rolloutId, toolCallId: "w1", seq: 0 })
      )
      assert.notStrictEqual(undone._tag, undefined)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the server's progress shows in the step's row while it runs, and never reaches the model", () =>
    Effect.gen(function* () {
      const script = scripted([{ name: "mcp_painter_paint", args: { text: "a lighthouse" }, id: "p1" }])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const painter = yield* fakeServer([fakeTool("paint")])
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      painter.state.call = async (_name, _args, _signal, progress) => {
        await progress(2, 5)
        await new Promise((resolve) => setTimeout(resolve, 400))
        await progress(4, 5, "Adding the waves")
        await gate
        return { content: [{ type: "text", text: "painted" }] }
      }
      const connection = yield* addServer(api, painter, "Painter")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* task(api, chat, "paint it")
      const progressOf = () =>
        events.flatMap((e) =>
          e._tag === "Steps" && e.versionId === versionId
            ? e.steps.flatMap((s) => (s.kind === "tool" && s.id === "p1" && s.progress ? [s.progress] : []))
            : []
        )
      yield* eventually(() => progressOf().includes("Working… 40%"))
      yield* eventually(() => progressOf().includes("Adding the waves (80%)"))
      release()
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      // Done, the row has no progress, and nothing of it was stored or sent to the model.
      const last = events.flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? [e.steps] : [])).at(-1)!
      const step = last.find((s) => s.kind === "tool" && s.id === "p1")
      assert.isTrue(step?.kind === "tool" && step.status === "done" && step.progress === undefined)
      const stored = yield* api.GetRolloutSteps({ versionId: versionId as VersionId })
      assert.notInclude(JSON.stringify(stored), "Adding the waves")
      assert.notInclude(JSON.stringify(mock.requests()), "Adding the waves")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a large result is kept whole and the model is shown a page it can read on from", () =>
    Effect.gen(function* () {
      const script = scripted([{ name: "mcp_big_dump", args: {}, id: "b1" }])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const big = yield* fakeServer([fakeTool("dump")])
      const whole = Array.from({ length: 6000 }, (_, i) => `line ${i} of the archive`).join("\n")
      big.state.call = async () => ({ content: [{ type: "text", text: whole }] })
      const connection = yield* addServer(api, big, "Big")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* run(api, chat, events, "dump it")
      const [sent] = toolMessages(mock.requests()).filter((m) => m.tool_call_id === "b1")
      assert.isAtMost(String(sent!.content).length, 16_000)
      assert.include(String(sent!.content), "read_run")
      const transcript = yield* api.GetRunTranscript({ versionId: versionId as VersionId })
      const stored = JSON.stringify(transcript)
      assert.include(stored, "line 5999 of the archive")
      // The inspector has what the model was sent of it beside the whole result.
      const entry = transcript.entries.find((e) => e.role === "toolResult" && e.toolCallId === "b1")
      assert.isTrue(entry?.role === "toolResult" && entry.text.includes("line 5999 of the archive"))
      assert.isTrue(entry?.role === "toolResult" && entry.sent !== undefined && !entry.sent.includes("line 5999"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a shortened read_run page keeps its original-step cursor on the provider wire", () =>
    Effect.gen(function* () {
      const script = scripted([
        { name: "mcp_big_dump", args: {}, id: "original" },
        { name: "read_run", args: { message: 0, call: "original", max_tokens: 4000 }, id: "first-page" }
      ])
      // The mock model's window, measured with this toolset: small enough that the quota shortens
      // the page, large enough that the run doesn't compact before the page is sent (26k to 28k pass).
      // Re-measured when the read_card/read_lorebook/read_preset definitions grew (07d7c202a): 24k compacted.
      const { api, chat, events, mock } = yield* workshop(script.handler, 27_000)
      for (const capability of ["plugins.write", "plugins.apply", "network", "subagents"] as const)
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability, mode: "off" })
      const big = yield* fakeServer([fakeTool("dump")])
      const body = Array.from({ length: 6000 }, (_, i) => `${i}: XQYZ & <tag> "entry"`).join("\n")
      big.state.call = async () => ({ content: [{ type: "text", text: body }] })
      const connection = yield* addServer(api, big, "Big")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })

      const versionId = yield* run(api, chat, events, "read the archive")
      const transcript = yield* api.GetRunTranscript({ versionId: versionId as VersionId })
      const first = transcript.entries.find((e) => e.role === "toolResult" && e.toolCallId === "first-page")
      assert.isDefined(first, `steps sent to the provider: ${toolMessages(mock.requests()).map((m) => m.tool_call_id)}`)
      const sent = first?.role === "toolResult" ? first.sent : undefined
      assert.isString(
        sent,
        `the quota shortened the page: ${first?.role === "toolResult" ? first.text.slice(0, 250) : ""}`
      )
      assert.match(
        sent!,
        /<\/tool_data>\n\[Result continues: read_run with message 0 and call "page:v2:1:[1-9]\d*:[a-f0-9]{24}"/
      )
      const wire = toolMessages(mock.requests()).find((m) => m.tool_call_id === "first-page")
      assert.strictEqual(wire?.content, sent)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Stop cancels the call at the server; Resume asks with what the ledger knows, and Don't run it holds", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_slow_send", args: { text: "hello" }, id: "s1" }])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const slow = yield* fakeServer([fakeTool("send")])
      let cancelled = 0
      slow.state.call = (_name, _args, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            cancelled++
            reject(new Error("cancelled"))
          })
        )
      const connection = yield* addServer(api, slow, "Slow")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* task(api, chat, "send it")
      yield* eventually(() => calls(slow).length === 1)
      yield* api.StopGeneration({ versionId: versionId as VersionId })
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      yield* eventually(() => slow.methods().includes("notifications/cancelled"))
      yield* eventually(() => cancelled === 1)
      const [ledger] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT status FROM mcp_calls WHERE method = 'tools/call'" }],
        { readOnly: true }
      )
      assert.deepStrictEqual(ledger, [{ status: "cancelled" }])

      const me = yield* api.Whoami()
      const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
      const resumed = yield* api.ResumeVersion({
        versionId: versionId as VersionId,
        expectedRowVersion: slot.entry.rowVersion
      })
      const prompt = yield* awaitApproval(events, resumed.version.id, "s1")
      assert.isTrue(prompt.uncertain)
      assert.strictEqual(prompt.rerun?.connection, "Slow")
      assert.strictEqual(prompt.rerun?.connectionId, connection.id)
      assert.strictEqual(prompt.rerun?.status, "cancelled")
      assert.isNumber(prompt.rerun?.sentAt)
      assert.isUndefined(prompt.grantTarget)
      // "Allow in this workshop" isn't an answer here.
      const refused = yield* Effect.flip(
        api.AnswerToolApproval({
          rolloutId: prompt.rolloutId,
          toolCallId: "s1",
          digest: prompt.digest,
          answer: "allow_chat"
        })
      )
      assert.strictEqual(refused._tag, "ApprovalRefused")
      yield* answer(api, prompt, "deny")
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.lengthOf(calls(slow), 1)
      const last = toolMessages(mock.requests())
        .filter((m) => m.tool_call_id === "s1")
        .at(-1)!
      assert.include(
        String(last.content),
        "This was interrupted and may already have happened; it wasn&apos;t run again."
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Run it again sends the call once more, as its second attempt", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_slow_send", args: { text: "again" }, id: "r1" }])
      const { api, chat, events } = yield* workshop(script.handler)
      const slow = yield* fakeServer([fakeTool("send")])
      let hang = true
      slow.state.call = (name, args, signal) =>
        hang
          ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))
          : Promise.resolve({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)} done` }] })
      const connection = yield* addServer(api, slow, "Slow")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* task(api, chat, "send it")
      yield* eventually(() => calls(slow).length === 1)
      yield* api.StopGeneration({ versionId: versionId as VersionId })
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      hang = false
      const me = yield* api.Whoami()
      const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
      const resumed = yield* api.ResumeVersion({
        versionId: versionId as VersionId,
        expectedRowVersion: slot.entry.rowVersion
      })
      const prompt = yield* awaitApproval(events, resumed.version.id, "r1")
      yield* answer(api, prompt, "allow")
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.lengthOf(calls(slow), 2)
      const [ledger] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT status, attempt FROM mcp_calls WHERE method = 'tools/call' ORDER BY started_at, id" }],
        { readOnly: true }
      )
      assert.deepStrictEqual(ledger, [
        { status: "cancelled", attempt: 1 },
        { status: "complete", attempt: 2 }
      ])
      // The resumed run's inspector lists both attempts, the stopped run's included.
      const inspected = yield* api.GetRunTranscript({ versionId: resumed.version.id })
      assert.deepStrictEqual(
        (inspected.mcpCalls ?? []).map((c) => [c.toolCallId, c.attempt, c.status]),
        [
          ["r1", 1, "cancelled"],
          ["r1", 2, "complete"]
        ]
      )
      // The change the resumed version kept is the call that went through.
      const effects = yield* api.ListVersionEffects({ versionId: resumed.version.id })
      assert.deepStrictEqual(
        effects.map((e) => e.kind),
        ["mcp.call"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a call the app never sent runs on Resume without asking", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_slow_send", args: { text: "unsent" }, id: "u1" }])
      const { api, chat, events } = yield* workshop(script.handler)
      const slow = yield* fakeServer([fakeTool("send")])
      let hang = true
      slow.state.call = (_name, _args, signal) =>
        hang
          ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))
          : Promise.resolve({ content: [{ type: "text", text: "sent now" }] })
      const connection = yield* addServer(api, slow, "Slow")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* task(api, chat, "send it")
      yield* eventually(() => calls(slow).length === 1)
      yield* api.StopGeneration({ versionId: versionId as VersionId })
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      hang = false
      // As if the app had stopped before sending it: no ledger row for the call.
      yield* fixtureSql(config.dataDir, [{ sql: "DELETE FROM mcp_calls WHERE method = 'tools/call'" }])
      const me = yield* api.Whoami()
      const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
      const resumed = yield* api.ResumeVersion({
        versionId: versionId as VersionId,
        expectedRowVersion: slot.entry.rowVersion
      })
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.isUndefined(waitingFor(events, resumed.version.id, "u1"))
      assert.lengthOf(calls(slow), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a timeout cancels the call at the server and tells the model it may have happened", () =>
    Effect.gen(function* () {
      const script = scripted([{ name: "mcp_late_wait", args: {}, id: "t1" }])
      const { api, chat, events, mock } = yield* workshop(script.handler)
      const late = yield* fakeServer([fakeTool("wait")])
      late.state.call = (_name, _args, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))
      const connection = yield* addServer(api, late, "Late", "", 5)
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      yield* run(api, chat, events, "wait for it")
      assert.include(late.methods(), "notifications/cancelled")
      const [sent] = toolMessages(mock.requests()).filter((m) => m.tool_call_id === "t1")
      assert.include(String(sent!.content), "didn&apos;t answer within 5 s. It may still have happened.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("turned Off here, a call already offered is refused and sends nothing", () =>
    Effect.gen(function* () {
      const script = scripted([{ name: "mcp_vault_wipe", args: {}, id: "o1" }])
      let release: (() => void) | null = null
      let held = false
      // The request that makes the call waits until the server is turned off here.
      const { api, chat, events, mock } = yield* workshop((request, res) => {
        const messages = (request.body as unknown as Body).messages
        if (!held && JSON.stringify(messages).includes(TRIGGER)) {
          held = true
          release = () => script.handler(request, res)
          return
        }
        script.handler(request, res)
      })
      const vault = yield* fakeServer([fakeTool("wipe")])
      const connection = yield* addServer(api, vault, "Vault")
      yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
      const versionId = yield* task(api, chat, "wipe")
      yield* eventually(() => release !== null)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "mcp", target: connection.id, mode: "off" })
      release!()
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.isEmpty(vault.requests())
      const sent = toolMessages(mock.requests())
        .filter((m) => m.tool_call_id === "o1")
        .at(-1)
      assert.include(String(sent?.content), "is turned off in this workshop")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  for (const how of ["turned Off here", "its Workshops switch turned off", "deleted"] as const)
    it.live(`a server ${how} after the run began isn't called on Resume, and the model is told`, () =>
      Effect.gen(function* () {
        const script = scripted([{ name: "mcp_slow_send", args: { text: "hello" }, id: "h1" }])
        const { api, chat, events, mock } = yield* workshop(script.handler)
        const slow = yield* fakeServer([fakeTool("send")])
        slow.state.call = (_name, _args, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))
        const connection = yield* addServer(api, slow, "Slow")
        yield* api.SetMcpUse({ connectionId: connection.id, workshops: true })
        const versionId = yield* task(api, chat, "send it")
        yield* eventually(() => calls(slow).length === 1)
        yield* api.StopGeneration({ versionId: versionId as VersionId })
        yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
        if (how === "turned Off here")
          yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "mcp", target: connection.id, mode: "off" })
        else if (how === "deleted") yield* api.DeleteMcpConnection({ connectionId: connection.id })
        else yield* api.SetMcpUse({ connectionId: connection.id, workshops: false })
        const me = yield* api.Whoami()
        const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
        const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
        const resumed = yield* api.ResumeVersion({
          versionId: versionId as VersionId,
          expectedRowVersion: slot.entry.rowVersion
        })
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.isUndefined(waitingFor(events, resumed.version.id, "h1"))
        assert.lengthOf(calls(slow), 1)
        const last = toolMessages(mock.requests())
          .filter((m) => m.tool_call_id === "h1")
          .at(-1)!
        assert.include(
          String(last.content),
          how === "deleted" ? "isn&apos;t available here now" : "is turned off in this workshop"
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )
})
