// MCP servers in story chats (spec/MCP.md M3): a branch's own On or Off (`agent.mcp`) over the
// account's Stories switch, every allowed tool offered and run without asking whatever its server
// says of it, receipts without workshop changes, results as quoted data paged by `read_result`
// (this run's own results only), and Resume asking before an interrupted call is sent again.
// Branches are independent. A scripted loopback provider and a local fake MCP server only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import type { Chat, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { McpConnectionId } from "@rp/shared/mcp.ts"
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
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

const TRIGGER = "Story task:"
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

/** After the last task, calls these tools in turn, one a request, then writes the reply. */
const scripted = (steps: ReadonlyArray<{ readonly name: string; readonly args: unknown; readonly id: string }>) => {
  let current = steps
  const handler = (request: Recorded, res: ServerResponse) => {
    const messages = (request.body as unknown as Body).messages
    const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
    if (lastTask < 0 || !(request.body as unknown as Body).tools) return sse(res, completionChunks(["Mira nods."], {}))
    const done = messages.slice(lastTask).filter((m) => m.role === "tool").length
    const step = current[done]
    sse(res, step ? callChunks(step.name, step.args, step.id) : completionChunks(["Mira writes it down."], {}))
  }
  return { handler, set: (next: typeof steps) => void (current = next) }
}

const chatRequests = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
const toolNames = (body: Body) => (body.tools ?? []).map((t) => t.function.name)
const toolMessages = (requests: ReadonlyArray<Recorded>) =>
  chatRequests(requests).flatMap((b) => b.messages.filter((m) => m.role === "tool"))
/** The MCP tools (and read_result) the last task's first request offered. */
const lastOffer = (requests: ReadonlyArray<Recorded>) => {
  const body = chatRequests(requests)
    .filter((b) => JSON.stringify(b.messages).includes(TRIGGER))
    .at(-1)!
  return toolNames(body).filter((n) => n.startsWith("mcp_") || n === "read_result")
}

const fakeServer = (tools: Array<Record<string, unknown>>) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeMcpServer({ tools })),
    (server) => Effect.promise(() => server.close())
  )
const addServer = (api: Api, server: FakeMcpServer, name: string) =>
  Effect.gen(function* () {
    const created = yield* api.CreateMcpConnection({
      settings: { name, about: "", transport: "streamable-http", url: server.streamableUrl, timeoutS: 30 }
    })
    assert.isTrue(created.check.ok, created.check.detail)
    server.reset()
    return created.connection
  })
const calls = (server: FakeMcpServer) => server.methods().filter((m) => m === "tools/call")

/** A story chat with tools on (and no built-in tools), its first reply written, and its events. */
const story = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { chat, version, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      state: [
        { key: "agent.enabled", value: { on: true } },
        { key: "agent.tools", value: { tools: [] } }
      ]
    })
    yield* eventually(() => finished(events, version.id) !== undefined)
    const main = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
    return { mock, api, chat, events, main, leaf: version.slotId }
  })

/** The user's task on a branch and the reply to it; the reply's slot is the branch's new leaf. */
const say = (api: Api, chat: Chat, forkId: ForkId, parent: SlotId, content: string) =>
  Effect.gen(function* () {
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        forkId,
        parentSlotId: parent,
        branch: false,
        content: `${TRIGGER} ${content}`
      })
    )
    const generated = yield* posted(
      api.Generate({ chatId: chat.id, forkId, parentSlotId: sent.entry.slotId, branch: false })
    )
    return { versionId: generated.entry.version.id, slotId: generated.entry.slotId }
  })
const turn = (
  api: Api,
  chat: Chat,
  events: ReadonlyArray<ChatEvent>,
  forkId: ForkId,
  parent: SlotId,
  content: string
) =>
  Effect.gen(function* () {
    const reply = yield* say(api, chat, forkId, parent, content)
    yield* eventually(() => finished(events, reply.versionId as VersionId) !== undefined)
    return reply
  })
const choose = (
  api: Api,
  chat: Chat,
  forkId: ForkId,
  slotId: SlotId,
  connection: McpConnectionId,
  on: boolean | null
) =>
  api.ChangeCast({
    chatId: chat.id,
    forkId,
    slotId,
    change: { _tag: "McpConnection", connection, on } satisfies CastChange
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

describe("MCP servers in story chats", () => {
  it.live("a branch's own choice wins over the account's either way, and other branches keep theirs", () =>
    Effect.gen(function* () {
      const script = scripted([])
      const { api, chat, events, main, leaf, mock } = yield* story(script.handler)
      const alpha = yield* fakeServer([fakeTool("zeta"), fakeTool("alpha")])
      const a = yield* addServer(api, alpha, "Alpha")
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: leaf })
      for (const change of [
        { _tag: "AgentEnabled", on: true },
        { _tag: "AgentTools", tools: [] }
      ] as const)
        yield* api.ChangeCast({ chatId: chat.id, forkId: fork.id, slotId: leaf, change })

      // Stories off for the account: on in the fork only.
      yield* choose(api, chat, fork.id, leaf, a.id, true)
      assert.isUndefined((yield* api.GetCast({ chatId: chat.id, forkId: main, slotId: leaf })).agentMcp)
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, forkId: fork.id, slotId: leaf })).agentMcp, {
        [a.id]: true
      })
      let mainLeaf = (yield* turn(api, chat, events, main, leaf, "main one")).slotId
      assert.deepStrictEqual(lastOffer(mock.requests()), [])
      let forkLeaf = (yield* turn(api, chat, events, fork.id, leaf, "fork one")).slotId
      assert.deepStrictEqual(lastOffer(mock.requests()), ["mcp_alpha_alpha", "mcp_alpha_zeta", "read_result"])

      // Stories on for the account: off in the fork only.
      yield* api.SetMcpUse({ connectionId: a.id, stories: true })
      yield* choose(api, chat, fork.id, forkLeaf, a.id, false)
      mainLeaf = (yield* turn(api, chat, events, main, mainLeaf, "main two")).slotId
      assert.deepStrictEqual(lastOffer(mock.requests()), ["mcp_alpha_alpha", "mcp_alpha_zeta", "read_result"])
      const off = yield* turn(api, chat, events, fork.id, forkLeaf, "fork two")
      forkLeaf = off.slotId
      assert.deepStrictEqual(lastOffer(mock.requests()), [])

      // Reset follows the account again, from the next reply on; the reply before keeps its choice.
      yield* choose(api, chat, fork.id, forkLeaf, a.id, null)
      assert.isUndefined((yield* api.GetCast({ chatId: chat.id, forkId: fork.id, slotId: forkLeaf })).agentMcp)
      yield* turn(api, chat, events, fork.id, forkLeaf, "fork three")
      assert.deepStrictEqual(lastOffer(mock.requests()), ["mcp_alpha_alpha", "mcp_alpha_zeta", "read_result"])
      const kept = yield* api.GetRunTranscript({ versionId: off.versionId as VersionId })
      assert.notInclude(JSON.stringify(kept.tools), "mcp_alpha")

      // The tools listing the chat shows: the account's switch and the allowed count.
      const listed = yield* api.ListStoryMcpServers()
      assert.deepStrictEqual(
        listed.map((s) => [s.connectionId, s.name, s.allowedTools, s.stories]),
        [[a.id, "Alpha", 2, true]]
      )
      // A server the user doesn't have can't be chosen.
      const refused = yield* Effect.flip(
        choose(api, chat, main, mainLeaf, "019a0000-0000-7000-8000-000000000000" as McpConnectionId, true)
      )
      assert.strictEqual(refused._tag, "NotFound")
      // Planning never reached the server.
      assert.isEmpty(alpha.requests())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a tool its server calls destructive runs without asking: quoted, with a receipt and no changes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_vault_wipe", args: { text: "drawer 3" }, id: "w1" }])
      const { api, chat, events, main, leaf, mock } = yield* story(script.handler)
      const vault = yield* fakeServer([fakeTool("wipe", { annotations: { destructiveHint: true } })])
      const connection = yield* addServer(api, vault, "Vault")
      yield* api.SetMcpUse({ connectionId: connection.id, stories: true })
      const { versionId } = yield* turn(api, chat, events, main, leaf, "wipe it")
      assert.strictEqual(finished(events, versionId as VersionId)!.status, "complete")
      assert.deepStrictEqual(calls(vault), ["tools/call"])
      const [result] = toolMessages(mock.requests()).filter((m) => m.tool_call_id === "w1")
      const text = String(result!.content)
      assert.include(text, TOOL_DATA_NOTICE)
      assert.include(text, "<tool_data>")
      assert.include(text, "wipe {&quot;text&quot;:&quot;drawer 3&quot;}")
      const [ledger, receipts, effects] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT method, status, purpose, tool_call_id FROM mcp_calls WHERE purpose <> 'check' ORDER BY started_at, id"
          },
          { sql: "SELECT is_error FROM rollout_receipts WHERE tool_call_id = 'w1'" },
          { sql: "SELECT count(*) AS n FROM rollout_effects" }
        ],
        { readOnly: true }
      )
      assert.deepStrictEqual(ledger, [
        { method: "initialize", status: "complete", purpose: "story", tool_call_id: null },
        { method: "tools/call", status: "complete", purpose: "story", tool_call_id: "w1" }
      ])
      assert.deepStrictEqual(receipts, [{ is_error: 0 }])
      assert.deepStrictEqual(effects, [{ n: 0 }])
      const steps = yield* api.GetRolloutSteps({ versionId: versionId as VersionId })
      const step = steps.find((s) => s.kind === "tool" && s.id === "w1")
      assert.isTrue(step?.kind === "tool" && step.effectClass === "mcp" && step.label === "wipe (Vault)")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a long result is paged by read_result, which reads only this run's own results", () =>
    Effect.gen(function* () {
      const script = scripted([
        { name: "mcp_big_dump", args: {}, id: "b1" },
        { name: "read_result", args: { call: "b1", offset: 15000 }, id: "p1" },
        { name: "read_result", args: { call: "elsewhere" }, id: "p2" }
      ])
      const { api, chat, events, main, leaf, mock } = yield* story(script.handler)
      const big = yield* fakeServer([fakeTool("dump")])
      const whole = Array.from({ length: 6000 }, (_, i) => `line ${i} of the archive <a&b>`).join("\n")
      big.state.call = async () => ({ content: [{ type: "text", text: whole }] })
      const connection = yield* addServer(api, big, "Big")
      yield* api.SetMcpUse({ connectionId: connection.id, stories: true })
      const { versionId } = yield* turn(api, chat, events, main, leaf, "dump it")
      const sent = toolMessages(mock.requests())
      const first = String(sent.find((m) => m.tool_call_id === "b1")!.content)
      assert.isAtMost(first.length, 16_000)
      assert.include(first, 'read_result with call "b1"')
      assert.notInclude(first, "line 5999 of the archive")
      // Quoted once: the page is of the original, not of the envelope it's stored in.
      assert.include(first, "line 0 of the archive &lt;a&amp;b&gt;")
      assert.notInclude(first, "&amp;lt;")
      assert.notInclude(first.slice(first.indexOf("<tool_data>") + 11), TOOL_DATA_NOTICE)
      const page = String(sent.find((m) => m.tool_call_id === "p1")!.content)
      assert.include(page, TOOL_DATA_NOTICE)
      assert.include(page, "&quot;offset&quot;:15000")
      assert.notInclude(page, "line 0 of the archive")
      assert.notInclude(page, "&amp;lt;")
      // Offsets are the original's: 15000 is where this page starts in it.
      assert.include(
        page,
        `<tool_data>\n${whole.slice(15000, 15020).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`
      )
      const other = String(sent.find((m) => m.tool_call_id === "p2")!.content)
      assert.include(other, "No result of a server")
      const stored = JSON.stringify(yield* api.GetRunTranscript({ versionId: versionId as VersionId }))
      assert.include(stored, "line 5999 of the archive")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Resume asks before sending an interrupted call again; Don't run it holds, Run it again sends it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "mcp_slow_send", args: { text: "hello" }, id: "s1" }])
      const { api, chat, events, main, leaf, mock } = yield* story(script.handler)
      const slow = yield* fakeServer([fakeTool("send")])
      let hang = true
      slow.state.call = (name, args, signal) =>
        hang
          ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))
          : Promise.resolve({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)} done` }] })
      const connection = yield* addServer(api, slow, "Slow")
      // Off for the account, on for this branch: the frozen choice holds on Resume.
      yield* choose(api, chat, main, leaf, connection.id, true)
      const resumeOnce = (versionId: string) =>
        Effect.gen(function* () {
          const me = yield* api.Whoami()
          const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
          const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
          return yield* api.ResumeVersion({
            versionId: versionId as VersionId,
            expectedRowVersion: slot.entry.rowVersion
          })
        })
      const { versionId } = yield* say(api, chat, main, leaf, "send it")
      yield* eventually(() => calls(slow).length === 1)
      yield* api.StopGeneration({ versionId: versionId as VersionId })
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      yield* eventually(() => slow.methods().includes("notifications/cancelled"))

      const resumed = yield* resumeOnce(versionId)
      const prompt = yield* awaitApproval(events, resumed.version.id, "s1")
      assert.isTrue(prompt.uncertain)
      assert.strictEqual(prompt.rerun?.connection, "Slow")
      assert.strictEqual(prompt.rerun?.status, "cancelled")
      yield* answer(api, prompt, "deny")
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.lengthOf(calls(slow), 1)
      const last = toolMessages(mock.requests())
        .filter((m) => m.tool_call_id === "s1")
        .at(-1)!
      assert.include(String(last.content), "it wasn&apos;t run again.")

      // A second interrupted reply, answered Run it again: sent once more, as attempt 2.
      script.set([{ name: "mcp_slow_send", args: { text: "again" }, id: "s2" }])
      const again = yield* say(api, chat, main, (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!, "again")
      yield* eventually(() => calls(slow).length === 2)
      yield* api.StopGeneration({ versionId: again.versionId as VersionId })
      yield* eventually(() => finished(events, again.versionId as VersionId) !== undefined)
      hang = false
      const second = yield* resumeOnce(again.versionId)
      yield* answer(api, yield* awaitApproval(events, second.version.id, "s2"), "allow")
      yield* eventually(() => finished(events, second.version.id) !== undefined)
      assert.lengthOf(calls(slow), 3)
      const [ledger] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT tool_call_id, status, attempt FROM mcp_calls WHERE method = 'tools/call' ORDER BY started_at, id"
          }
        ],
        { readOnly: true }
      )
      assert.deepStrictEqual(ledger, [
        { tool_call_id: "s1", status: "cancelled", attempt: 1 },
        { tool_call_id: "s2", status: "cancelled", attempt: 1 },
        { tool_call_id: "s2", status: "complete", attempt: 2 }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
