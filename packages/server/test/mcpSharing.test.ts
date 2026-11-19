// An admin's MCP server shared with others (spec/MCP.md §3, M5): who sees it, what they see of it
// (never its address's path, key, headers or route), each user's own use, sign-in, session and
// calls, the admin's counts of others' calls, the offered key when two collide, and stopping.
// Never a third-party server.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { MCP_TOOL_NAME_LIMIT, type McpConnectionSettings, mcpOfferedToolName } from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import { McpConnections } from "../src/mcp/McpConnections.ts"
import { client, login, serverLayer, testConfig } from "./support/config.ts"
import { approveSignIn, startFakeAuthServer } from "./support/fakeAuthServer.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"

const KEY = "sk-shared-admin-key-9876"

const settings = (url: string, name = "Team"): McpConnectionSettings => ({
  name,
  about: "Team notes",
  transport: "streamable-http",
  url,
  timeoutS: 5
})

const fake = (initial: Parameters<typeof startFakeMcpServer>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeMcpServer(initial)),
    (server) => Effect.promise(() => server.close())
  )

/** The admin (the instance's first user) and two others, each with a client of their own. */
const people = Effect.gen(function* () {
  const local = yield* client()
  const admin = yield* local.Whoami()
  yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "admin-password" })
  const adminApi = yield* client({ cookie: (yield* login(admin.handle, "admin-password")).cookie })
  const user = (handle: string) =>
    Effect.gen(function* () {
      const account = yield* adminApi.CreateUser({
        handle,
        displayName: handle,
        role: "user",
        password: `${handle}-password`
      })
      const api = yield* client({ cookie: (yield* login(handle, `${handle}-password`)).cookie })
      return { id: account.id as UserId, api }
    })
  return { admin: { id: admin.id as UserId, api: adminApi }, bob: yield* user("bob"), carol: yield* user("carol") }
})

const callAs = (userId: UserId, connectionId: string, text: string) =>
  Effect.flatMap(McpConnections, (mcp) =>
    mcp.call({
      userId,
      connectionId: connectionId as never,
      tool: "echo",
      args: { text },
      attribution: { purpose: "workshop", chatId: null, rolloutId: null, toolCallId: null, attempt: 1 }
    })
  )

describe("offered tool names", () => {
  it("swap the key's prefix, and a name too long ends in a stable hash within the limit", () => {
    assert.strictEqual(mcpOfferedToolName("mcp_team_search", "team", "team"), "mcp_team_search")
    assert.strictEqual(mcpOfferedToolName("mcp_team_search", "team", "team2"), "mcp_team2_search")
    const long = `mcp_team_${"x".repeat(MCP_TOOL_NAME_LIMIT - 9)}`
    const offered = mcpOfferedToolName(long, "team", "team22")
    assert.isAtMost(offered.length, MCP_TOOL_NAME_LIMIT)
    assert.match(offered, /^mcp_team22_x+_[0-9a-f]{6}$/)
    assert.strictEqual(offered, mcpOfferedToolName(long, "team", "team22"))
  })
})

describe("shared MCP servers", () => {
  it.live(
    "a chosen user sees it without its secrets, keeps their own use and session, and loses it when unshared",
    () =>
      Effect.gen(function* () {
        const { admin, bob, carol } = yield* people
        const server = yield* fake({ key: KEY, tools: [fakeTool("echo")] })
        const created = yield* admin.api.CreateMcpConnection({
          settings: settings(`${server.streamableUrl}?team=private-path-part`),
          apiKey: KEY
        })
        assert.isTrue(created.check.ok, created.check.detail)
        const id = created.connection.id
        yield* admin.api.SetMcpHeaders({
          connectionId: id,
          headers: { "X-Team-Secret": "header-value-secret" },
          expectedRowVersion: (yield* admin.api.GetMcpConnection({ connectionId: id })).rowVersion
        })
        // Private: nobody else knows it.
        assert.notInclude(
          (yield* bob.api.ListMcpConnections()).map((c) => c.id),
          id
        )
        assert.strictEqual((yield* bob.api.GetMcpConnection({ connectionId: id }).pipe(Effect.flip))._tag, "NotFound")
        // Only an admin shares, and only their own.
        const own = yield* bob.api.CreateMcpConnection({ settings: settings(server.streamableUrl, "Bob's") })
        assert.strictEqual(
          (yield* bob.api.SetMcpShare({ connectionId: own.connection.id, scope: "all", userIds: [] }).pipe(Effect.flip))
            ._tag,
          "McpRefused"
        )

        const shared = yield* admin.api.SetMcpShare({ connectionId: id, scope: "chosen", userIds: [bob.id] })
        assert.deepStrictEqual(shared.share, { scope: "chosen", userIds: [bob.id] })
        assert.notInclude(
          (yield* carol.api.ListMcpConnections()).map((c) => c.id),
          id
        )

        // Bob sees its name, purpose, tools and host; never the path, key, headers or route.
        const seen = yield* bob.api.GetMcpConnection({ connectionId: id })
        assert.isFalse(seen.owned)
        assert.strictEqual(seen.ownerName, (yield* admin.api.Whoami()).displayName)
        assert.strictEqual(seen.url, new URL(server.url).origin)
        assert.isFalse(seen.hasKey)
        assert.deepStrictEqual(seen.headerNames, [])
        assert.deepStrictEqual(seen.share, { scope: "private", userIds: [] })
        assert.strictEqual(seen.toolCount, 1)
        const everything = JSON.stringify([seen, yield* bob.api.ListMcpConnections()])
        for (const secret of [KEY, KEY.slice(-4), "private-path-part", "X-Team-Secret", "header-value-secret"])
          assert.notInclude(everything, secret)
        // Nor can he change it, check it or delete it.
        assert.strictEqual(
          (yield* bob.api
            .UpdateMcpConnection({
              connectionId: id,
              settings: settings("http://evil.example/mcp"),
              expectedRowVersion: 1
            })
            .pipe(Effect.flip))._tag,
          "NotFound"
        )
        assert.strictEqual((yield* bob.api.CheckMcpConnection({ connectionId: id }).pipe(Effect.flip))._tag, "NotFound")
        assert.strictEqual(
          (yield* bob.api.DeleteMcpConnection({ connectionId: id }).pipe(Effect.flip))._tag,
          "NotFound"
        )
        assert.strictEqual(
          (yield* bob.api.SetMcpLoading({ connectionId: id, loading: "deferred" }).pipe(Effect.flip))._tag,
          "NotFound"
        )

        // His own switches; the admin's stay.
        yield* bob.api.SetMcpUse({ connectionId: id, workshops: true })
        assert.isTrue((yield* bob.api.GetMcpConnection({ connectionId: id })).use.workshops)
        assert.isFalse((yield* admin.api.GetMcpConnection({ connectionId: id })).use.workshops)

        // Each user's own session, with the admin's key; calls recorded under the caller.
        server.reset()
        assert.strictEqual((yield* callAs(admin.id, id, "a"))._tag, "Result")
        assert.strictEqual((yield* callAs(bob.id, id, "b"))._tag, "Result")
        const sessions = new Set(
          server
            .requests()
            .filter((r) => r.methods.includes("tools/call"))
            .map((r) => r.headers["mcp-session-id"])
        )
        assert.strictEqual(sessions.size, 2)
        assert.isTrue(server.requests().every((r) => r.headers.authorization === `Bearer ${KEY}`))
        assert.isTrue(server.requests().every((r) => r.path.includes("team=private-path-part")))
        const bobsCalls = yield* bob.api.ListMcpCalls({ connectionId: id, before: null })
        assert.isNotEmpty(bobsCalls.filter((c) => c.method === "tools/call"))
        const adminsCalls = yield* admin.api.ListMcpCalls({ connectionId: id, before: null })
        assert.notInclude(
          adminsCalls.map((c) => c.id),
          bobsCalls[0]!.id
        )
        // The admin sees how many requests others sent, never their chats.
        assert.isAtLeast((yield* admin.api.GetMcpConnection({ connectionId: id })).othersCalls, 2)

        // Stopping: gone from Bob's list, and his next call sends nothing.
        yield* admin.api.SetMcpShare({ connectionId: id, scope: "private", userIds: [] })
        assert.notInclude(
          (yield* bob.api.ListMcpConnections()).map((c) => c.id),
          id
        )
        server.reset()
        const after = yield* callAs(bob.id, id, "c")
        assert.strictEqual(after._tag, "Failed")
        if (after._tag === "Failed") assert.isFalse(after.sent)
        assert.lengthOf(server.requests(), 0)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live(
    "shared with everyone: users made later see it, a colliding key gets a number, and each signs in for themselves",
    () =>
      Effect.gen(function* () {
        const { admin, bob } = yield* people
        const auth = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeAuthServer()),
          (s) => Effect.promise(() => s.close())
        )
        const server = yield* fake({ auth, tools: [fakeTool("echo")] })
        // Bob's own "Team" first: his key is team.
        const bobs = yield* bob.api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
        assert.strictEqual(bobs.connection.use.offeredKey, "team")
        const created = yield* admin.api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
        const id = created.connection.id
        yield* admin.api.SetMcpShare({ connectionId: id, scope: "all", userIds: [] })
        const seen = (yield* bob.api.ListMcpConnections()).find((c) => c.id === id)!
        assert.strictEqual(seen.use.offeredKey, "team2")
        // A user created after sharing sees it too.
        yield* admin.api.CreateUser({
          handle: "dave",
          displayName: "dave",
          role: "user",
          password: "dave-password"
        })
        const daveApi = yield* client({ cookie: (yield* login("dave", "dave-password")).cookie })
        const davesView = (yield* daveApi.ListMcpConnections()).find((c) => c.id === id)
        assert.strictEqual(davesView?.use.offeredKey, "team")
        assert.isFalse(davesView?.owned)

        // The admin's sign-in is never used for Bob: he signs in himself.
        const sign = (api: typeof bob.api) =>
          Effect.gen(function* () {
            const started = yield* api.StartMcpSignIn({ connectionId: id, appOrigin: "http://localhost:5173" })
            const back = yield* Effect.promise(() => approveSignIn(started.authorizationUrl))
            return { state: back.state!, code: back.code }
          })
        const adminSignIn = yield* sign(admin.api)
        // Bob can't finish the admin's sign-in.
        assert.strictEqual(
          (yield* bob.api.FinishMcpSignIn({ ...adminSignIn, error: null }).pipe(Effect.flip))._tag,
          "McpRefused"
        )
        yield* admin.api.FinishMcpSignIn({ ...adminSignIn, error: null })
        server.reset()
        const refused = yield* callAs(bob.id, id, "x")
        assert.strictEqual(refused._tag, "Failed")
        const bobSignIn = yield* sign(bob.api)
        yield* bob.api.FinishMcpSignIn({ ...bobSignIn, error: null })
        assert.isNotNull((yield* bob.api.GetMcpConnection({ connectionId: id })).use.signIn)
        server.reset()
        assert.strictEqual((yield* callAs(bob.id, id, "y"))._tag, "Result")
        assert.strictEqual((yield* callAs(admin.id, id, "z"))._tag, "Result")
        const tokens = new Set(server.requests().map((r) => r.headers.authorization))
        assert.strictEqual(tokens.size, 2)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
