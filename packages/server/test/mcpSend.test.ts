// What reaches an MCP server (spec/MCP.md §6, the twin of providerSend.test.ts): nothing is
// sent to one except the user's Check (which adding a server, or moving it to another address
// or transport, runs), or a call the model makes in a workshop where the server is on. Editing
// it, setting its key, headers, route and switches, reading it, deleting and restoring it, a
// story reply (stories use servers from M3), a workshop turn that doesn't call it, a workshop
// where it's off (by default or by the workshop's own Off) and a call there send it nothing.
// A local fake server only.
import { assert, describe, it } from "@effect/vitest"
import type { Chat } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const REPLY = completionChunks(["Noted."], { prompt_tokens: 10, completion_tokens: 2 })
const CALL = "Call the search tool."
const callChunks = (name: string, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }]
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
interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
}
/** The model calls `mcp_search_search` once after a message asking it to, then answers. */
const scriptedProvider = (request: { readonly body: unknown }, res: import("node:http").ServerResponse) => {
  const messages = (request.body as Body).messages ?? []
  const asked = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(CALL))
  const answered = asked >= 0 && messages.slice(asked).some((m) => m.role === "tool")
  return sse(res, asked >= 0 && !answered ? callChunks("mcp_search_search", `c${asked}`) : REPLY)
}

describe("what reaches an MCP server", () => {
  it.live("only a Check sends anything, and only the handshake and the tool listing", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mcp = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeMcpServer({ tools: [fakeTool("search")] })),
        (server) => Effect.promise(() => server.close())
      )
      const provider = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scriptedProvider as never)),
        (server) => Effect.promise(() => server.close())
      )
      const settings = {
        name: "Search",
        about: "",
        transport: "streamable-http" as const,
        url: mcp.streamableUrl,
        timeoutS: 5
      }
      const created = yield* api.CreateMcpConnection({ settings, apiKey: "sk-mcp-consent-key-0000" })
      assert.isTrue(created.check.ok, created.check.detail)
      const checkMethods = mcp.methods().filter((method) => method !== "notifications/initialized")
      assert.deepStrictEqual(checkMethods, ["initialize", "tools/list"])
      mcp.reset()

      // Everything else the user does to it.
      const id = created.connection.id
      let connection = (yield* api.UpdateMcpConnection({
        connectionId: id,
        settings: { ...settings, name: "Search tools", about: "Finds things.", timeoutS: 30 },
        expectedRowVersion: created.connection.rowVersion
      })).connection
      connection = yield* api.SetMcpHeaders({
        connectionId: id,
        headers: { "X-Team": "synthetic" },
        expectedRowVersion: connection.rowVersion
      })
      connection = yield* api.SetMcpKey({
        connectionId: id,
        apiKey: "sk-mcp-consent-key-1111",
        expectedRowVersion: connection.rowVersion
      })
      yield* api.SetMcpProxy({ connectionId: id, mode: "direct", url: null })
      yield* api.SetMcpUse({ connectionId: id, stories: true, workshops: true })
      yield* api.SetMcpUse({
        connectionId: id,
        tools: { choices: { search: { on: false } }, reviewedRevision: connection.catalogRevision }
      })
      yield* api.ListMcpConnections()
      yield* api.GetMcpConnection({ connectionId: id })
      yield* api.ListMcpCalls({ connectionId: id, before: null })
      const item = yield* api.DeleteMcpConnection({ connectionId: id })
      yield* api.RestoreBinItem({ itemId: item.id })
      yield* api.SetMcpUse({
        connectionId: id,
        tools: { choices: { search: { on: true } }, reviewedRevision: connection.catalogRevision }
      })

      // A story reply and a workshop turn, with the server on for both: no call, nothing sent.
      yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${provider.url}/v1` }, model: {} })
      const turnIn = (workshopId: Chat["id"], content: string) =>
        Effect.gen(function* () {
          const events: Array<ChatEvent> = []
          yield* api.SubscribeChat({ chatId: workshopId }).pipe(
            Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
            Effect.forkScoped
          )
          yield* eventually(() => events.length > 0)
          const current = yield* api.GetChat({ chatId: workshopId })
          const sent = yield* posted(
            api.SendMessage({ chatId: workshopId, parentSlotId: current.activeLeafSlotId, branch: false, content })
          )
          const turn = yield* posted(
            api.Generate({ chatId: workshopId, parentSlotId: sent.entry.slotId, branch: false })
          )
          yield* eventually(() => finished(events, turn.entry.version.id) !== undefined)
        })
      const workshop = yield* api.CreateWorkshop({})
      yield* turnIn(workshop.id, "Find the ledger.")
      // Background work has had its chance.
      yield* Effect.sleep("1500 millis")
      assert.isAbove(provider.requests().length, 1)
      assert.lengthOf(mcp.requests(), 0, JSON.stringify(mcp.requests().map((request) => request.path)))
      // Story requests never name the server's tools (stories use them from M3).
      const storyBodies = provider.requests().filter((r) => !JSON.stringify(r.body).includes("Find the ledger."))
      assert.notInclude(JSON.stringify(storyBodies.map((request) => request.body)), "mcp_search")

      // Off by default for workshops: not offered, and a call to it anyway sends nothing.
      yield* api.SetMcpUse({ connectionId: id, workshops: false })
      const before = provider.requests().length
      const off = yield* api.CreateWorkshop({})
      yield* turnIn(off.id, CALL)
      assert.notInclude(
        JSON.stringify(
          provider
            .requests()
            .slice(before)
            .map((r) => (r.body as { tools?: unknown } | null)?.tools)
        ),
        "mcp_search"
      )
      assert.lengthOf(mcp.requests(), 0)
      // On for the account but Off in this workshop: the same.
      yield* api.SetMcpUse({ connectionId: id, workshops: true })
      yield* api.SetWorkshopGrant({ chatId: off.id, capability: "mcp", target: id, mode: "off" })
      yield* turnIn(off.id, CALL)
      assert.lengthOf(mcp.requests(), 0)
      // On in a workshop with the account switch off: the call, and only the call, reaches it.
      yield* api.SetMcpUse({ connectionId: id, workshops: false })
      yield* api.SetWorkshopGrant({ chatId: off.id, capability: "mcp", target: id, mode: "allow" })
      yield* turnIn(off.id, CALL)
      assert.deepStrictEqual(
        mcp.methods().filter((method) => method !== "notifications/initialized"),
        ["initialize", "tools/call"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
