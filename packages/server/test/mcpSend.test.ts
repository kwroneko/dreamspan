// What reaches an MCP server (spec/MCP.md §6, the twin of providerSend.test.ts): nothing is
// sent to one except the user's Check (which adding a server, or moving it to another address
// or transport, runs). Editing it, setting its key, headers, route and switches, reading it,
// deleting and restoring it, a story reply and a workshop turn send it nothing. M1 offers no
// MCP tools to a model, so no model call reaches it either. A local fake server only.
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const REPLY = completionChunks(["Noted."], { prompt_tokens: 10, completion_tokens: 2 })

describe("what reaches an MCP server", () => {
  it.live("only a Check sends anything, and only the handshake and the tool listing", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mcp = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeMcpServer({ tools: [fakeTool("search")] })),
        (server) => Effect.promise(() => server.close())
      )
      const provider = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, REPLY))),
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

      // A story reply and a workshop turn, with the server on for both.
      yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${provider.url}/v1` }, model: {} })
      const workshop = yield* api.CreateWorkshop({})
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const current = yield* api.GetChat({ chatId: workshop.id })
      const sent = yield* posted(
        api.SendMessage({
          chatId: workshop.id,
          parentSlotId: current.activeLeafSlotId,
          branch: false,
          content: "Find the ledger."
        })
      )
      const turn = yield* posted(api.Generate({ chatId: workshop.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* eventually(() => finished(events, turn.entry.version.id) !== undefined)
      // Background work has had its chance.
      yield* Effect.sleep("1500 millis")
      assert.isAbove(provider.requests().length, 1)
      assert.lengthOf(mcp.requests(), 0, JSON.stringify(mcp.requests().map((request) => request.path)))
      // Nothing the model was sent names the server's tools yet (M2 offers them).
      assert.notInclude(JSON.stringify(provider.requests().map((request) => request.body)), "mcp_search")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
