// MCP clients kept per (connection, user) and the reconnect rule (spec/MCP.md §7.1, §7.2): a
// second call reuses the first's client, an edit or a delete closes it, an idle one closes on
// its own, and a session the server lost reconnects once, sending the call again only when the
// server's answer proves it refused the call unprocessed. Never a third-party server.
import { assert, describe, it } from "@effect/vitest"
import { eventually } from "./support/generation.ts"
import type { McpConnectionSettings } from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import { McpConnections, mcpClientTiming } from "../src/mcp/McpConnections.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"

const fake = (initial: Parameters<typeof startFakeMcpServer>[0] = {}) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeMcpServer(initial)),
    (server) => Effect.promise(() => server.close())
  )

const settings = (url: string, overrides: Partial<McpConnectionSettings> = {}): McpConnectionSettings => ({
  name: "Kept",
  about: "",
  transport: "streamable-http",
  url,
  timeoutS: 5,
  ...overrides
})

const attribution = (attempt = 1) =>
  ({ purpose: "workshop", chatId: null, rolloutId: null, toolCallId: null, attempt }) as const

/** Sets up a connection and returns a caller of its `echo` tool through the service. */
const setup = (initial: Parameters<typeof startFakeMcpServer>[0] = {}) =>
  Effect.gen(function* () {
    const api = yield* client()
    const me = yield* api.GetSession()
    const server = yield* fake({ tools: [fakeTool("echo")], ...initial })
    const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
    assert.isTrue(created.check.ok, created.check.detail)
    const mcp = yield* McpConnections
    const call = (text: string, attempt = 1) =>
      mcp.call({
        userId: me.user.id,
        connectionId: created.connection.id,
        tool: "echo",
        args: { text },
        attribution: attribution(attempt)
      })
    const ledger = () =>
      api
        .ListMcpCalls({ connectionId: created.connection.id, before: null })
        .pipe(Effect.map((rows) => rows.filter((row) => row.purpose !== "check").reverse()))
    server.reset()
    return { api, server, mcp, call, ledger, connection: created.connection }
  })

const sentMethods = (methods: ReadonlyArray<string>) =>
  methods.filter((m) => m !== "notifications/initialized" && m !== "tools/list")

describe("kept MCP clients", () => {
  it.live("a second call reuses the first's client; an edit closes it and the next call opens another", () =>
    Effect.gen(function* () {
      const { api, server, mcp, call, ledger, connection } = yield* setup()
      const one = yield* call("one")
      const two = yield* call("two")
      assert.strictEqual(one._tag, "Result")
      assert.strictEqual(two._tag, "Result")
      assert.deepStrictEqual(sentMethods(server.methods()), ["initialize", "tools/call", "tools/call"])
      assert.strictEqual(mcp.kept(), 1)
      assert.deepStrictEqual(
        (yield* ledger()).map((row) => [row.method, row.status]),
        [
          ["initialize", "complete"],
          ["tools/call", "complete"],
          ["tools/call", "complete"]
        ]
      )

      // An edit of how calls are sent (the timeout) closes the kept client at once.
      yield* api.UpdateMcpConnection({
        connectionId: connection.id,
        settings: settings(connection.url!, { timeoutS: 6 }),
        expectedRowVersion: connection.rowVersion
      })
      assert.strictEqual(mcp.kept(), 0)
      server.reset()
      yield* call("three")
      assert.deepStrictEqual(sentMethods(server.methods()), ["initialize", "tools/call"])

      // Deleting it closes it too, and a later call sends nothing.
      yield* api.DeleteMcpConnection({ connectionId: connection.id })
      assert.strictEqual(mcp.kept(), 0)
      server.reset()
      const gone = yield* call("four")
      assert.strictEqual(gone._tag, "Failed")
      assert.lengthOf(server.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an idle client closes on its own", () =>
    Effect.gen(function* () {
      const before = mcpClientTiming.idleMs
      mcpClientTiming.idleMs = 200
      yield* Effect.addFinalizer(() => Effect.sync(() => (mcpClientTiming.idleMs = before)))
      const { server, mcp, call } = yield* setup()
      yield* call("one")
      assert.strictEqual(mcp.kept(), 1)
      yield* Effect.sleep("600 millis")
      assert.strictEqual(mcp.kept(), 0)
      server.reset()
      yield* call("two")
      assert.deepStrictEqual(sentMethods(server.methods()), ["initialize", "tools/call"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a lost session reconnects once and the call goes again, as its own ledger row", () =>
    Effect.gen(function* () {
      let ran = 0
      const { server, call, ledger } = yield* setup({
        call: async (name, args) => {
          ran += 1
          return { content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }
        }
      })
      yield* call("one")
      server.dropSessions()
      const again = yield* call("two")
      assert.strictEqual(again._tag, "Result")
      // The 404 was refused unprocessed: the tool ran once for each call, never twice.
      assert.strictEqual(ran, 2)
      const rows = (yield* ledger()).map((row) => [row.method, row.status, row.attempt])
      assert.deepStrictEqual(rows, [
        ["initialize", "complete", 1],
        ["tools/call", "complete", 1],
        ["tools/call", "failed", 1],
        ["initialize", "complete", 1],
        ["tools/call", "complete", 2]
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("concurrent callers on a lost session share one reconnect", () =>
    Effect.gen(function* () {
      const { server, call } = yield* setup()
      yield* call("one")
      server.dropSessions()
      server.reset()
      const both = yield* Effect.all([call("a"), call("b")], { concurrency: 2 })
      assert.isTrue(both.every((outcome) => outcome._tag === "Result"))
      assert.strictEqual(sentMethods(server.methods()).filter((m) => m === "initialize").length, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a failure that doesn't prove the call unprocessed is never retried", () =>
    Effect.gen(function* () {
      const { server, call, ledger } = yield* setup()
      yield* call("one")
      // The server fails the call with a status that says nothing about the session.
      server.state.failStatus = 502
      const failed = yield* call("two")
      assert.strictEqual(failed._tag, "Failed")
      if (failed._tag === "Failed") {
        assert.isTrue(failed.sent)
        assert.strictEqual(failed.status, "failed")
      }
      const calls = (yield* ledger()).filter((row) => row.method === "tools/call")
      assert.deepStrictEqual(
        calls.map((row) => [row.status, row.attempt]),
        [
          ["complete", 1],
          ["failed", 1]
        ]
      )
      // The session is in doubt: the next call opens a fresh client.
      server.state.failStatus = null
      server.reset()
      yield* call("three")
      assert.deepStrictEqual(sentMethods(server.methods()), ["initialize", "tools/call"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

/** Waits until a check through the API holds. */
const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (yield* check) return
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.die(new Error("timed out waiting"))
  })

describe("listing a server's tools again", () => {
  it.live("the first connect of a process lists again after the call, and a changed-tools notice lists at once", () =>
    Effect.gen(function* () {
      const { api, server, call, connection } = yield* setup()
      const listings = () => server.methods().filter((m) => m === "tools/list").length
      yield* call("one")
      // The first connect of this process lists once, after the call, with the check's purpose.
      yield* eventually(() => listings() === 1)
      const listed = (yield* api.ListMcpCalls({ connectionId: connection.id, before: null })).filter(
        (row) => row.method === "tools/list"
      )
      assert.isTrue(listed.every((row) => row.purpose === "check" && row.chatId === null))
      // Unchanged: the catalog keeps its revision.
      assert.strictEqual((yield* api.GetMcpConnection({ connectionId: connection.id })).catalogRevision, 1)
      yield* call("two")
      assert.strictEqual(listings(), 1)

      // The server adds a tool and says so: listed at once, stored as a new revision, the new
      // tool off and marked new until the user chooses.
      server.state.tools = [fakeTool("echo"), fakeTool("paint")]
      yield* Effect.promise(() => server.toolsChanged())
      yield* eventually(() => listings() === 2)
      yield* until(Effect.map(api.GetMcpConnection({ connectionId: connection.id }), (c) => c.catalogRevision === 2))
      const after = yield* api.GetMcpConnection({ connectionId: connection.id })
      assert.deepStrictEqual(
        after.tools.map((t) => [t.name, t.firstRevision]),
        [
          ["echo", 1],
          ["paint", 2]
        ]
      )
      assert.strictEqual(after.use.reviewedRevision, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a notice from a server with no kept client, or after an edit, changes nothing", () =>
    Effect.gen(function* () {
      const { api, server, mcp, call, connection } = yield* setup()
      yield* call("one")
      yield* eventually(() => server.methods().includes("tools/list"))
      // An edit closes the kept client: the old session's notice isn't heard.
      yield* api.UpdateMcpConnection({
        connectionId: connection.id,
        settings: settings(connection.url!, { timeoutS: 7 }),
        expectedRowVersion: connection.rowVersion
      })
      assert.strictEqual(mcp.kept(), 0)
      server.reset()
      server.state.tools = [fakeTool("echo"), fakeTool("later")]
      yield* Effect.promise(() => server.toolsChanged())
      yield* Effect.sleep("300 millis")
      assert.lengthOf(server.requests(), 0)
      assert.strictEqual((yield* api.GetMcpConnection({ connectionId: connection.id })).catalogRevision, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
