// Signing in with an MCP server (spec/MCP.md §2.4, M5): discovery, dynamic registration and
// authorization code with PKCE against a fake authorization server; the tokens kept encrypted
// on the user's own use, bound to the server's origin; refresh before a call, once; sign-out.
// Never a third-party server.
import { assert, describe, it } from "@effect/vitest"
import type { McpConnectionSettings } from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import { McpConnections } from "../src/mcp/McpConnections.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { approveSignIn, startFakeAuthServer } from "./support/fakeAuthServer.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"

const APP = "http://localhost:5173"

const settings = (url: string): McpConnectionSettings => ({
  name: "Signed",
  about: "",
  transport: "streamable-http",
  url,
  timeoutS: 5
})

const setup = (accessTtlS = 3600) =>
  Effect.gen(function* () {
    const auth = yield* Effect.acquireRelease(
      Effect.promise(() => startFakeAuthServer({ accessTtlS })),
      (server) => Effect.promise(() => server.close())
    )
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => startFakeMcpServer({ tools: [fakeTool("echo")], auth })),
      (s) => Effect.promise(() => s.close())
    )
    const api = yield* client()
    const me = yield* api.GetSession()
    const created = yield* api.CreateMcpConnection({ settings: settings(server.streamableUrl) })
    const mcp = yield* McpConnections
    const call = (text: string) =>
      mcp.call({
        userId: me.user.id,
        connectionId: created.connection.id,
        tool: "echo",
        args: { text },
        attribution: { purpose: "workshop", chatId: null, rolloutId: null, toolCallId: null, attempt: 1 }
      })
    const signIn = Effect.gen(function* () {
      const started = yield* api.StartMcpSignIn({ connectionId: created.connection.id, appOrigin: APP })
      const back = yield* Effect.promise(() => approveSignIn(started.authorizationUrl))
      assert.strictEqual(back.redirect.origin + back.redirect.pathname, `${APP}/mcp/oauth/callback`)
      return yield* api.FinishMcpSignIn({ state: back.state!, code: back.code, error: null })
    })
    return { api, auth, server, created, call, signIn, connectionId: created.connection.id }
  })

describe("signing in with an MCP server", () => {
  it.live("a server that wants sign-in says so; signing in lists its tools and calls carry the user's token", () =>
    Effect.gen(function* () {
      const { api, auth, server, created, call, connectionId } = yield* setup()
      assert.isFalse(created.check.ok)
      assert.include(created.check.detail, "asks you to sign in")
      assert.isNull(created.connection.use.signIn)

      const started = yield* api.StartMcpSignIn({ connectionId, appOrigin: APP })
      const page = new URL(started.authorizationUrl)
      assert.strictEqual(page.origin + page.pathname, `${auth.url}/authorize`)
      assert.strictEqual(page.searchParams.get("code_challenge_method"), "S256")
      assert.isNotEmpty(page.searchParams.get("code_challenge"))
      assert.strictEqual(page.searchParams.get("redirect_uri"), `${APP}/mcp/oauth/callback`)
      // The resource indicator names the MCP server (RFC 8707).
      assert.strictEqual(page.searchParams.get("resource"), server.streamableUrl)
      // The app registered itself as a public client with its callback.
      const [registered] = [...auth.clients().values()]
      assert.deepStrictEqual(registered!.redirect_uris, [`${APP}/mcp/oauth/callback`])
      assert.strictEqual(registered!.token_endpoint_auth_method, "none")

      const back = yield* Effect.promise(() => approveSignIn(started.authorizationUrl))
      const finished = yield* api.FinishMcpSignIn({ state: back.state!, code: back.code, error: null })
      assert.strictEqual(finished.connectionId, connectionId)
      // The same state never finishes twice.
      const again = yield* api.FinishMcpSignIn({ state: back.state!, code: back.code, error: null }).pipe(Effect.flip)
      assert.strictEqual(again._tag, "McpRefused")

      const connection = yield* api.GetMcpConnection({ connectionId })
      assert.strictEqual(connection.use.signIn?.origin, new URL(server.url).origin)
      assert.isNumber(connection.use.signIn?.expiresAt)
      const checked = yield* api.CheckMcpConnection({ connectionId })
      assert.isTrue(checked.check.ok, checked.check.detail)
      assert.strictEqual(checked.connection.toolCount, 1)

      server.reset()
      const result = yield* call("hi")
      assert.strictEqual(result._tag, "Result")
      const used = server.requests().map((r) => /^Bearer (.+)$/.exec(String(r.headers.authorization))?.[1])
      assert.isTrue(used.every((token) => token !== undefined && auth.valid(token)))
      assert.strictEqual(auth.resourceOf(used[0]!), server.streamableUrl)

      // The tokens never leave the server: not in any read.
      const seen = JSON.stringify([connection, yield* api.ListMcpConnections(), checked])
      assert.notInclude(seen, used[0]!)
      // Each sign-in step is a ledger row of its own, with nothing of the user's.
      const ledger = yield* api.ListMcpCalls({ connectionId, before: null })
      assert.isAtLeast(ledger.filter((row) => row.method === "oauth" && row.status === "complete").length, 2)
      assert.notInclude(JSON.stringify(ledger), used[0]!)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live(
    "refreshes an expiring token before the call, once; a refused refresh asks to sign in and sends nothing",
    () =>
      Effect.gen(function* () {
        // Tokens living 30 s are within the minute the app refreshes ahead.
        const { auth, server, call, signIn } = yield* setup(30)
        yield* signIn
        const before = auth.requests().filter((r) => r === "token:refresh_token").length
        server.reset()
        const result = yield* call("one")
        assert.strictEqual(result._tag, "Result")
        assert.strictEqual(auth.requests().filter((r) => r === "token:refresh_token").length - before, 1)

        auth.state.refuseRefresh = true
        server.reset()
        const refused = yield* call("two")
        assert.strictEqual(refused._tag, "Failed")
        if (refused._tag === "Failed") {
          assert.isFalse(refused.sent)
          assert.include(refused.message, "Sign in to Signed again")
        }
        assert.notInclude(server.methods(), "tools/call")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a sign-in is bound to the server's origin, and signing out forgets it", () =>
    Effect.gen(function* () {
      const { api, server, call, signIn, connectionId } = yield* setup()
      yield* signIn
      const connection = yield* api.GetMcpConnection({ connectionId })
      // The same server under another origin: the tokens aren't sent there.
      yield* api.UpdateMcpConnection({
        connectionId,
        settings: settings(server.streamableUrl.replace("127.0.0.1", "localhost")),
        expectedRowVersion: connection.rowVersion
      })
      server.reset()
      const moved = yield* call("one")
      assert.strictEqual(moved._tag, "Failed")
      if (moved._tag === "Failed") assert.include(moved.message, "its address changed")
      assert.lengthOf(server.requests(), 0)

      const out = yield* api.SignOutOfMcp({ connectionId })
      assert.isNull(out.use.signIn)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("the app sends the browser back only to its own addresses, and only the starting user finishes", () =>
    Effect.gen(function* () {
      const { api, connectionId } = yield* setup()
      const elsewhere = yield* api.StartMcpSignIn({ connectionId, appOrigin: "https://evil.example" }).pipe(Effect.flip)
      assert.strictEqual(elsewhere._tag, "McpRefused")
      const made = yield* api.FinishMcpSignIn({ state: "not-a-state", code: "x", error: null }).pipe(Effect.flip)
      assert.strictEqual(made._tag, "McpRefused")
      // The server's own refusal is reported, not stored.
      const started = yield* api.StartMcpSignIn({ connectionId, appOrigin: APP })
      const back = yield* Effect.promise(() => approveSignIn(started.authorizationUrl))
      const denied = yield* api
        .FinishMcpSignIn({ state: back.state!, code: null, error: "access_denied" })
        .pipe(Effect.flip)
      assert.strictEqual(denied._tag, "McpRefused")
      assert.isNull((yield* api.GetMcpConnection({ connectionId })).use.signIn)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ publicOrigins: ["https://app.example"] }))))
  )
})
