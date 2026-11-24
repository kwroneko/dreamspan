// MCP servers, M1 (spec/MCP.md §2, §4.1, §4.2, §10, §12): connections through the app's own
// network to a local fake server over both transports, keys and headers bound to their
// origins, Check and the stored catalog, the model-facing names, the allow list, the bin, and
// the ledger of every request. Never a third-party server.
import { assert, describe, it } from "@effect/vitest"
import {
  mcpKeyFor,
  mcpToolAllowed,
  mcpToolIsNew,
  type McpConnection,
  type McpConnectionSettings,
  type McpTool
} from "@dreamspan/shared/mcp.ts"
import { Cause, Effect, Logger } from "effect"
import { Writer } from "../src/db/Database.ts"
import { buildCatalog, exposedNames, hashedToolName, plainToolName } from "../src/mcp/catalog.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

const KEY = "sk-mcp-synthetic-key-0123456789"

const fake = (initial: Parameters<typeof startFakeMcpServer>[0] = {}) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeMcpServer(initial)),
    (server) => Effect.promise(() => server.close())
  )

const settings = (url: string, overrides: Partial<McpConnectionSettings> = {}): McpConnectionSettings => ({
  name: "Fake tools",
  about: "Synthetic tools for tests.",
  transport: "streamable-http",
  url,
  timeoutS: 5,
  ...overrides
})

/** Everything the server sent the browser, as text: no secret may be in it. */
const shown = (value: unknown) => JSON.stringify(value)

describe("names the model sees", () => {
  it("are mcp_<key>_<tool>, fitted to 64 characters and stable", () => {
    assert.strictEqual(plainToolName("github", "search.issues"), "mcp_github_search_issues")
    const long = "a".repeat(80)
    const fitted = exposedNames("github", [long], new Map()).get(long)!
    assert.lengthOf(fitted, 64)
    assert.strictEqual(fitted, hashedToolName("github", long))
    assert.match(fitted, /^mcp_github_a+_[0-9a-f]{6}$/)
    // Two tools mapping to one name both get the hash suffix, each its own.
    const both = exposedNames("k", ["a.b", "a_b"], new Map())
    assert.notStrictEqual(both.get("a.b"), both.get("a_b"))
    assert.match(both.get("a.b")!, /^mcp_k_a_b_[0-9a-f]{6}$/)
    assert.match(both.get("a_b")!, /^mcp_k_a_b_[0-9a-f]{6}$/)
    // A name already given stays, and a newcomer that would take it gets the suffix instead.
    const later = exposedNames("k", ["a_b", "a.b"], new Map([["a_b", "mcp_k_a_b"]]))
    assert.strictEqual(later.get("a_b"), "mcp_k_a_b")
    assert.match(later.get("a.b")!, /^mcp_k_a_b_[0-9a-f]{6}$/)
  })

  it("come from a key fixed from the connection's name", () => {
    assert.strictEqual(mcpKeyFor("GitHub", new Set()), "github")
    assert.strictEqual(mcpKeyFor("GitHub", new Set(["github"])), "github2")
    assert.strictEqual(mcpKeyFor("2 Ünïcode-Tools!", new Set()), "unicodetools")
    assert.strictEqual(mcpKeyFor("日本", new Set()), "mcp")
    assert.lengthOf(mcpKeyFor("x".repeat(40), new Set(["x".repeat(24)])), 24)
  })

  it("mark unusable tools, keep first revisions, and turn later tools off until reviewed", () => {
    const first = buildCatalog("k", [fakeTool("read"), { name: "bad", inputSchema: { type: "string" } }], [], 1)
    assert.deepStrictEqual(
      first.map((tool) => [tool.exposed, tool.problem, tool.firstRevision]),
      [
        ["mcp_k_bad", "Its parameters aren't valid.", 1],
        ["mcp_k_read", null, 1]
      ]
    )
    const second = buildCatalog("k", [fakeTool("read"), fakeTool("write")], first, 2)
    const write = second.find((tool) => tool.name === "write")!
    const read = second.find((tool) => tool.name === "read")!
    assert.strictEqual(read.firstRevision, 1)
    assert.strictEqual(write.firstRevision, 2)
    const use = { stories: false, workshops: false, tools: {}, reviewedRevision: 1, offeredKey: "k", signIn: null }
    assert.isTrue(mcpToolAllowed(read, use))
    assert.isFalse(mcpToolAllowed(write, use))
    assert.isTrue(mcpToolIsNew(write, use))
    assert.isTrue(mcpToolAllowed(write, { ...use, tools: { write: { on: true } } }))
    assert.isFalse(mcpToolAllowed(first[0] as McpTool, { ...use, tools: { bad: { on: true } } }))
  })
})

describe("MCP connections", () => {
  it.live(
    "Check lists the tools over Streamable HTTP with the key, records every request, and never shows the key",
    () => {
      const logs: Array<string> = []
      const collector = Logger.make((options) => {
        logs.push(String(options.message), Cause.pretty(options.cause))
      })
      return Effect.gen(function* () {
        const api = yield* client()
        const server = yield* fake({ key: KEY, tools: [fakeTool("echo"), fakeTool("dots.name")], pageSize: 1 })
        const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl), apiKey: KEY })
        assert.isTrue(created.check.ok, created.check.detail)
        assert.strictEqual(created.check.toolCount, 2)
        assert.match(created.check.route ?? "", /^direct/)
        const connection = created.connection
        assert.strictEqual(connection.key, "faketools")
        assert.deepStrictEqual(
          connection.tools.map((tool) => tool.exposed),
          ["mcp_faketools_dots_name", "mcp_faketools_echo"]
        )
        assert.strictEqual(connection.server?.name, "fake-mcp")
        assert.strictEqual(connection.catalogRevision, 1)
        assert.strictEqual(connection.use.reviewedRevision, 1)
        assert.isTrue(connection.hasKey)
        assert.strictEqual(connection.keyHint, "6789")
        // The key went as a bearer token, and nothing but the handshake and the listing was sent.
        assert.isTrue(server.requests().every((request) => request.headers.authorization === `Bearer ${KEY}`))
        assert.deepStrictEqual(
          server.methods().filter((method) => method !== "notifications/initialized"),
          ["initialize", "tools/list", "tools/list"]
        )
        // The ledger: one row per request, closed, with bytes both ways.
        const calls = yield* api.ListMcpCalls({ connectionId: connection.id, before: null })
        assert.deepStrictEqual(calls.map((call) => [call.method, call.purpose, call.status]).reverse(), [
          ["initialize", "check", "complete"],
          ["tools/list", "check", "complete"],
          ["tools/list", "check", "complete"]
        ])
        assert.isTrue(calls.every((call) => (call.sentBytes ?? 0) > 0 && (call.receivedBytes ?? 0) > 0))
        // The key is in no response, list or page.
        const list = yield* api.ListMcpConnections()
        const page = yield* api.GetMcpConnection({ connectionId: connection.id })
        for (const value of [created, list, page, calls]) assert.notInclude(shown(value), KEY)
        assert.notInclude(logs.join("\n"), KEY)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())), Effect.provide(Logger.layer([collector])))
    }
  )

  it.live("SSE works, and Check names the other transport when the chosen one doesn't answer", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake({ tools: [fakeTool("echo")] })
      const sse = yield* api.CreateMcpConnection({
        settings: settings(server.sseUrl, { transport: "sse", name: "Old" })
      })
      assert.isTrue(sse.check.ok, sse.check.detail)
      assert.strictEqual(sse.connection.toolCount, 1)

      server.state.streamable = false
      const wrong = yield* api.CreateMcpConnection({
        settings: settings(server.sseUrl, { transport: "streamable-http", name: "Wrong" })
      })
      assert.isFalse(wrong.check.ok)
      assert.strictEqual(wrong.check.alternative, "sse")
      assert.include(wrong.check.detail, "older SSE")
      assert.isNotNull(wrong.connection.checkError)
      // Switching is the user's edit, and it checks again.
      const switched = yield* api.UpdateMcpConnection({
        connectionId: wrong.connection.id,
        settings: settings(server.sseUrl, { transport: "sse", name: "Wrong" }),
        expectedRowVersion: wrong.connection.rowVersion
      })
      assert.isTrue(switched.check?.ok)
      assert.isNull(switched.connection.checkError)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live(
    "a key goes only to its origin: a moved address, a redirect elsewhere and an echo are refused or scrubbed",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const home = yield* fake({ key: KEY, tools: [fakeTool("echo")] })
        const elsewhere = yield* fake({ tools: [fakeTool("echo")] })
        const created = yield* api.CreateMcpConnection({ settings: settings(home.streamableUrl), apiKey: KEY })
        assert.isTrue(created.check.ok)

        // Moved to another origin: the key isn't sent there until it's typed again.
        const moved = yield* api.UpdateMcpConnection({
          connectionId: created.connection.id,
          settings: settings(elsewhere.streamableUrl),
          expectedRowVersion: created.connection.rowVersion
        })
        assert.isFalse(moved.check?.ok)
        assert.include(moved.check?.detail ?? "", "isn't allowed for")
        assert.lengthOf(elsewhere.requests(), 0)

        // Back home, the server redirects to the other origin: refused, nothing sent there.
        const back = yield* api.UpdateMcpConnection({
          connectionId: created.connection.id,
          settings: settings(home.streamableUrl),
          expectedRowVersion: moved.connection.rowVersion
        })
        assert.isTrue(back.check?.ok)
        home.state.redirect = elsewhere.streamableUrl
        const redirected = yield* api.CheckMcpConnection({ connectionId: created.connection.id })
        assert.isFalse(redirected.check.ok)
        assert.lengthOf(elsewhere.requests(), 0)

        // A server echoing the key in its error: the stored and shown error has it scrubbed.
        home.state.redirect = null
        home.state.failStatus = 400
        const echoed = yield* api.CheckMcpConnection({ connectionId: created.connection.id })
        assert.isFalse(echoed.check.ok)
        assert.include(echoed.check.detail, "[redacted]")
        const calls = yield* api.ListMcpCalls({ connectionId: created.connection.id, before: null })
        for (const value of [echoed, calls]) assert.notInclude(shown(value), KEY)
        assert.isTrue(calls.some((call) => call.status === "failed" && call.error !== null))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("headers are sent, bound to their origin, and never shown", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const home = yield* fake({ tools: [fakeTool("echo")] })
      const elsewhere = yield* fake({ tools: [fakeTool("echo")] })
      const created = yield* api.CreateMcpConnection({ settings: settings(home.streamableUrl) })
      const withHeaders = yield* api.SetMcpHeaders({
        connectionId: created.connection.id,
        headers: { "X-Gateway-Token": "gateway-secret-value" },
        expectedRowVersion: created.connection.rowVersion
      })
      assert.deepStrictEqual(withHeaders.headerNames, ["X-Gateway-Token"])
      assert.notInclude(shown(withHeaders), "gateway-secret-value")
      home.reset()
      yield* api.CheckMcpConnection({ connectionId: created.connection.id })
      assert.isTrue(home.requests().every((request) => request.headers["x-gateway-token"] === "gateway-secret-value"))
      const moved = yield* api.UpdateMcpConnection({
        connectionId: created.connection.id,
        settings: settings(elsewhere.streamableUrl),
        expectedRowVersion: withHeaders.rowVersion
      })
      assert.isFalse(moved.check?.ok)
      assert.include(moved.check?.detail ?? "", "set them again")
      assert.lengthOf(elsewhere.requests(), 0)
      // A stale form can't bind headers to an address someone changed meanwhile.
      assert.strictEqual(
        yield* outcome(
          api.SetMcpHeaders({
            connectionId: created.connection.id,
            headers: { "X-Gateway-Token": "x" },
            expectedRowVersion: withHeaders.rowVersion
          })
        ),
        "StaleWrite"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("tools listed later start off and say they're new; the allow list is the user's", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake({ tools: [fakeTool("read")] })
      const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
      server.state.tools = [fakeTool("read"), fakeTool("write", { annotations: { destructiveHint: true } })]
      const checked = yield* api.CheckMcpConnection({ connectionId: created.connection.id })
      const connection: McpConnection = checked.connection
      assert.strictEqual(connection.catalogRevision, 2)
      const write = connection.tools.find((tool) => tool.name === "write")!
      assert.isTrue(mcpToolIsNew(write, connection.use))
      assert.isFalse(mcpToolAllowed(write, connection.use))
      // An unchanged listing keeps the revision.
      const again = yield* api.CheckMcpConnection({ connectionId: created.connection.id })
      assert.strictEqual(again.connection.catalogRevision, 2)
      const chosen = yield* api.SetMcpUse({
        connectionId: connection.id,
        tools: { choices: { read: { on: false }, write: { on: true } }, reviewedRevision: 2 }
      })
      assert.isFalse(
        mcpToolAllowed(
          chosen.tools.find((tool) => tool.name === "read")!,
          chosen.use
        )
      )
      assert.isTrue(
        mcpToolAllowed(
          chosen.tools.find((tool) => tool.name === "write")!,
          chosen.use
        )
      )
      assert.isFalse(
        mcpToolIsNew(
          chosen.tools.find((tool) => tool.name === "write")!,
          chosen.use
        )
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an empty first listing still requires review of later tools", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake()
      const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
      assert.isTrue(created.check.ok)
      assert.strictEqual(created.check.toolCount, 0)
      yield* api.SetMcpUse({ connectionId: created.connection.id, workshops: true })

      server.state.tools = [fakeTool("read")]
      const { connection } = yield* api.CheckMcpConnection({ connectionId: created.connection.id })
      assert.strictEqual(connection.catalogRevision, 1)
      assert.isTrue(mcpToolIsNew(connection.tools[0]!, connection.use))
      assert.isFalse(mcpToolAllowed(connection.tools[0]!, connection.use))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a server that doesn't answer times out, and the ledger says so", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake({ tools: [fakeTool("read")], hangList: true })
      const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
      assert.isFalse(created.check.ok)
      assert.include(created.check.detail, "didn't answer within 5 s")
      assert.isNull(created.check.alternative)
      const calls = yield* api.ListMcpCalls({ connectionId: created.connection.id, before: null })
      assert.deepStrictEqual(
        calls.map((call) => [call.method, call.status]),
        [
          ["tools/list", "timeout"],
          ["initialize", "complete"]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("deleting goes to the bin; a purge leaves a tombstone without its address or key, and the ledger stays", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake({ tools: [fakeTool("read")] })
      const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl), apiKey: KEY })
      const keys = yield* api.ListCredentials()
      assert.lengthOf(keys, 1)
      assert.strictEqual(keys[0]!.usedBy, 1)
      const item = yield* api.DeleteMcpConnection({ connectionId: created.connection.id })
      assert.strictEqual(item.kind, "mcp_connection")
      assert.lengthOf(yield* api.ListMcpConnections(), 0)
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.lengthOf(yield* api.ListMcpConnections(), 1)
      const again = yield* api.DeleteMcpConnection({ connectionId: created.connection.id })
      yield* api.PurgeBinItem({ itemId: again.id, expectedForkIds: [] })
      assert.lengthOf(yield* api.ListCredentials(), 0)
      assert.strictEqual(yield* outcome(api.GetMcpConnection({ connectionId: created.connection.id })), "NotFound")
      // A new connection may take the purged one's key again.
      const next = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
      assert.strictEqual(next.connection.key, "faketools")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("startup marks requests left running as interrupted", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const server = yield* fake({ tools: [fakeTool("read")] })
      const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
      const writer = yield* Writer
      const user = yield* api.Whoami()
      yield* writer.OpenMcpCall({
        userId: user.id,
        call: {
          id: "left-running",
          connectionId: created.connection.id,
          connectionRevision: 0,
          method: "tools/list",
          tool: null,
          purpose: "check",
          chatId: null,
          rolloutId: null,
          toolCallId: null,
          attempt: 1,
          startedAt: Date.now()
        }
      })
      assert.deepStrictEqual(yield* writer.InterruptRunningMcpCalls(), { interrupted: 1 })
      const calls = yield* api.ListMcpCalls({ connectionId: created.connection.id, before: null })
      assert.strictEqual(calls.find((call) => call.id === "left-running")?.status, "interrupted")
      // A closed call is a record.
      assert.isFalse(
        yield* writer.CloseMcpCall({
          userId: user.id,
          callId: "left-running",
          status: "complete",
          endedAt: Date.now(),
          sentBytes: 1,
          receivedBytes: 1,
          error: null
        })
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("settings are checked before anything is stored or sent", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refusedWith = (overrides: Partial<McpConnectionSettings>) =>
        outcome(api.CreateMcpConnection({ settings: settings("http://127.0.0.1:9/mcp", overrides) }))
      assert.strictEqual(yield* refusedWith({ url: "ftp://example.com/mcp" }), "McpRefused")
      assert.strictEqual(yield* refusedWith({ url: "not a url" }), "McpRefused")
      assert.strictEqual(yield* refusedWith({ name: " " }), "McpRefused")
      assert.strictEqual(yield* refusedWith({ timeoutS: 1 }), "McpRefused")
      assert.lengthOf(yield* api.ListMcpConnections(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
