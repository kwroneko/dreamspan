// Signing in with an MCP server (spec/MCP.md §2.4, M5): discovery, dynamic registration and
// authorization code with PKCE against a fake authorization server; the tokens kept encrypted
// on the user's own use, bound to the server's origin; refresh before a call, once; sign-out.
// Never a third-party server.
import { assert, describe, it } from "@effect/vitest"
import type { McpConnectionSettings } from "@dreamspan/shared/mcp.ts"
import { Effect, Layer } from "effect"
import { McpConnections } from "../src/mcp/McpConnections.ts"
import { createServer } from "node:http"
import { isIPv6, type AddressInfo } from "node:net"
import { briefSignInError, SIGN_IN_PENDING_PER_USER, signInTargets, typedAsLocal } from "../src/mcp/oauth.ts"
import * as Database from "../src/db/Database.ts"
import * as NetworkModule from "../src/net/Network.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"
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

const setup = (accessTtlS = 3600, address?: Parameters<typeof startFakeAuthServer>[1]) =>
  Effect.gen(function* () {
    const auth = yield* Effect.acquireRelease(
      Effect.promise(() => startFakeAuthServer({ accessTtlS }, address)),
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

  it.live("registers and exchanges a token when the localhost auth server listens only on IPv6", () =>
    Effect.gen(function* () {
      const origin = new URL(APP)
      const addresses = yield* Effect.promise(() => signInTargets(origin)(origin))
      const bind = addresses?.find(isIPv6)
      assert.isDefined(bind)
      const { auth, signIn } = yield* setup(3600, { bind: bind!, advertise: origin.hostname })
      yield* signIn
      assert.strictEqual(auth.requests().filter((path) => path === "/register").length, 1)
      assert.strictEqual(auth.requests().filter((path) => path === "token:authorization_code").length, 1)
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

  it.live("a sign-in is bound to the server's address: another address forgets it; signing out forgets it", () =>
    Effect.gen(function* () {
      const { api, server, call, signIn, connectionId } = yield* setup()
      yield* signIn
      const out = yield* api.SignOutOfMcp({ connectionId })
      assert.isNull(out.use.signIn)
      yield* signIn
      const connection = yield* api.GetMcpConnection({ connectionId })
      assert.isNotNull(connection.use.signIn)
      // The same server under another origin: the sign-in is gone, and no token is sent there.
      const updated = yield* api.UpdateMcpConnection({
        connectionId,
        settings: settings(server.streamableUrl.replace("127.0.0.1", "localhost")),
        expectedRowVersion: connection.rowVersion
      })
      assert.isNull(updated.connection.use.signIn)
      server.reset()
      const moved = yield* call("one")
      assert.strictEqual(moved._tag, "Failed")
      if (moved._tag === "Failed") assert.include(moved.message, "asks you to sign in")
      assert.isTrue(server.requests().every((r) => r.headers.authorization === undefined))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("after the address changes, signing in discovers the new server's sign-in service, never the old one's", () =>
    Effect.gen(function* () {
      const { api, auth, signIn, connectionId } = yield* setup()
      yield* signIn
      // Another server with its own sign-in service; the admin moves the connection there.
      const other = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeAuthServer()),
        (s) => Effect.promise(() => s.close())
      )
      const moved = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeMcpServer({ tools: [fakeTool("echo")], auth: other })),
        (s) => Effect.promise(() => s.close())
      )
      const before = yield* api.GetMcpConnection({ connectionId })
      yield* api.UpdateMcpConnection({
        connectionId,
        settings: settings(moved.streamableUrl),
        expectedRowVersion: before.rowVersion
      })
      const started = yield* api.StartMcpSignIn({ connectionId, appOrigin: APP })
      assert.strictEqual(new URL(started.authorizationUrl).origin, other.url)
      assert.strictEqual(new URL(started.authorizationUrl).searchParams.get("resource"), moved.streamableUrl)
      const authorizeBefore = auth.requests().filter((r) => r === "/authorize").length
      const back = yield* Effect.promise(() => approveSignIn(started.authorizationUrl))
      yield* api.FinishMcpSignIn({ state: back.state!, code: back.code, error: null })
      assert.strictEqual(auth.requests().filter((r) => r === "/authorize").length, authorizeBefore)
      // The new server gets the new service's tokens only.
      const tokens = moved
        .requests()
        .map((r) => /^Bearer (.+)$/.exec(String(r.headers.authorization))?.[1])
        .filter((token): token is string => token !== undefined)
      assert.isNotEmpty(tokens)
      assert.isTrue(tokens.every((token) => other.valid(token) && !auth.valid(token)))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a sign-in service's own answer is never shown back, and registrations are reused", () =>
    Effect.gen(function* () {
      const { api, auth, connectionId } = yield* setup()
      auth.state.registerBody = "<html>INTERNAL-ADMIN-PAGE secret-config=42</html>"
      const failed = yield* api.StartMcpSignIn({ connectionId, appOrigin: APP }).pipe(Effect.flip)
      assert.strictEqual(failed._tag, "McpRefused")
      assert.notInclude(JSON.stringify(failed), "INTERNAL-ADMIN-PAGE")
      const ledger = yield* api.ListMcpCalls({ connectionId, before: null })
      assert.notInclude(JSON.stringify(ledger), "INTERNAL-ADMIN-PAGE")

      // Starting again and again registers the app once, and keeps a few waiting at most.
      auth.state.registerBody = null
      for (let i = 0; i < SIGN_IN_PENDING_PER_USER + 3; i++) yield* api.StartMcpSignIn({ connectionId, appOrigin: APP })
      assert.strictEqual(auth.clients().size, 1)
      const retained = (yield* McpConnections).retained()
      assert.strictEqual(retained.pendingSignIns, SIGN_IN_PENDING_PER_USER)
      assert.strictEqual(retained.locks, 0)
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

describe("where a sign-in's requests may go", () => {
  const PUBLIC = "93.184.216.34"
  const dns: Record<string, ReadonlyArray<string>> = {
    "mcp.example": [PUBLIC],
    "auth.example": ["93.184.216.35"],
    "lan.example": ["10.0.0.5"],
    "mixed.example": ["93.184.216.36", "192.168.1.2"],
    "metadata.example": ["169.254.169.254"]
  }
  const resolve = async (host: string) => dns[host] ?? []
  const mayReach = (ip: string) => ip.startsWith("93.")
  const targets = (server: string, bypassed?: (host: string) => boolean) =>
    signInTargets(new URL(server), { resolve, mayReach, ...(bypassed ? { bypassed } : {}) })
  const refusedBy = async (check: ReturnType<typeof targets>, url: string) =>
    check(new URL(url)).then(
      () => assert.fail(`${url} was allowed`),
      (error: Error) => assert.strictEqual(error.name, "SignInTargetRefused", url)
    )

  it.effect("a public server's metadata may name public services only, checked after DNS", () =>
    Effect.promise(async () => {
      const check = targets("https://mcp.example/mcp?team=x")
      // Its own origin is the user's choice: it goes where its calls go, pinned to what DNS said.
      assert.deepStrictEqual(await check(new URL("https://mcp.example/.well-known/oauth-protected-resource")), [PUBLIC])
      assert.deepStrictEqual(await check(new URL("https://auth.example/token")), ["93.184.216.35"])
      for (const refused of [
        "http://127.0.0.1:8080/register",
        "http://localhost/register",
        "http://[::1]/token",
        "http://10.0.0.5/admin",
        "https://lan.example/token",
        "https://mixed.example/token",
        "http://169.254.169.254/latest/meta-data/",
        "https://metadata.example/",
        "https://user:pass@auth.example/token",
        "file:///etc/passwd"
      ])
        await refusedBy(check, refused)
    })
  )

  it.effect("a server typed as local may name a local sign-in service", () =>
    Effect.promise(async () => {
      assert.deepStrictEqual(await targets("http://127.0.0.1:3000/mcp")(new URL("http://10.0.0.5/token")), ["10.0.0.5"])
      assert.deepStrictEqual(await targets("http://tools.localhost:3000/mcp")(new URL("https://lan.example/t")), [
        "10.0.0.5"
      ])
      // A name the admin put on the proxy bypass list counts as typed local.
      const onList = targets("http://gpu.lan/mcp", (host) => host === "gpu.lan")
      assert.deepStrictEqual(await onList(new URL("http://10.0.0.5/token")), ["10.0.0.5"])
      assert.isTrue(typedAsLocal(new URL("http://[::1]:8000/"), mayReach))
      assert.isFalse(typedAsLocal(new URL("https://mixed.example/"), mayReach))
    })
  )

  it.effect("DNS answers never make a server local: mixed or private answers still count as public", () =>
    Effect.promise(async () => {
      // A public name that also answers with a LAN address, and one that answers only privately.
      for (const server of ["https://mixed.example/mcp", "https://lan.example/mcp", "https://gpu.lan/mcp"]) {
        const check = targets(server)
        await refusedBy(check, "http://10.0.0.5/token")
        await refusedBy(check, "http://169.254.169.254/latest/meta-data/")
        await refusedBy(check, "http://127.0.0.1:8080/register")
      }
      // Its own origin still goes where it points: the user chose it.
      assert.deepStrictEqual(
        await targets("https://mixed.example/mcp")(new URL("https://mixed.example/.well-known/x")),
        ["93.184.216.36", "192.168.1.2"]
      )
    })
  )

  it.effect("each name is looked up once: a rebinding answer is never used, redirects included", () =>
    Effect.promise(async () => {
      const lookups: Array<string> = []
      // Public on the first lookup, loopback on every later one.
      const rebinding = async (host: string) => {
        lookups.push(host)
        return lookups.filter((h) => h === host).length === 1 ? [PUBLIC] : ["127.0.0.1"]
      }
      const check = signInTargets(new URL("https://rebind.example/mcp"), { resolve: rebinding, mayReach })
      for (const url of [
        "https://rebind.example/.well-known/oauth-protected-resource",
        "https://rebind.example/.well-known/oauth-authorization-server",
        "https://rebind.example/register",
        "https://rebind.example/token?redirected=1"
      ])
        assert.deepStrictEqual(await check(new URL(url)), [PUBLIC], url)
      const service = signInTargets(new URL("https://mcp.example/mcp"), { resolve: rebinding, mayReach })
      assert.deepStrictEqual(await service(new URL("https://meta.example/.well-known/x")), [PUBLIC])
      assert.deepStrictEqual(await service(new URL("https://meta.example/token")), [PUBLIC])
      assert.deepStrictEqual(lookups, ["rebind.example", "meta.example"])
    })
  )

  it.live("a rebinding name's requests reach only the checked address, across a redirect", () =>
    Effect.gen(function* () {
      // Two servers on one port: 127.0.0.2 stands in for the public answer, 127.0.0.1 for the
      // rebinding one.
      const hits: Array<string> = []
      const listen = (host: string, port: number) =>
        Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<ReturnType<typeof createServer>>((done) => {
                const server = createServer((request, response) => {
                  hits.push(`${host} ${request.method} ${request.url} ${request.headers.host}`)
                  if (request.url === "/start") response.writeHead(302, { location: "/next" }).end()
                  else if (request.url === "/lost-response") request.socket.destroy()
                  else response.writeHead(200).end("ok")
                })
                server.listen(port, host, () => done(server))
              })
          ),
          (server) => Effect.promise(() => new Promise<void>((done) => server.close(() => done())))
        )
      const checked = yield* listen("127.0.0.2", 0)
      const port = (checked.address() as AddressInfo).port
      yield* listen("127.0.0.1", port)
      let lookups = 0
      const check = signInTargets(new URL(`http://rebind.example:${port}/mcp`), {
        resolve: async () => (++lookups === 1 ? ["127.0.0.2"] : ["127.0.0.1"]),
        mayReach: (ip) => ip === "127.0.0.2"
      })
      const network = (yield* NetworkModule.Network).prepare({ mode: "inherit" }, () => {})
      const fetch = network.fetchFor(undefined, check)
      const base = `http://rebind.example:${port}`
      for (const path of ["/start", "/register"]) {
        const response = yield* Effect.promise(() => fetch(`${base}${path}`, { method: "POST", body: "{}" }))
        assert.strictEqual(response.status, 200)
      }
      // Even with another checked address, a lost response after a POST must not replay it.
      const withFallback = network.fetchFor(undefined, async () => ["127.0.0.2", "127.0.0.1"])
      yield* Effect.tryPromise(() => withFallback(`${base}/lost-response`, { method: "POST", body: "{}" })).pipe(
        Effect.flip
      )
      assert.strictEqual(lookups, 1)
      assert.deepStrictEqual(hits, [
        `127.0.0.2 POST /start rebind.example:${port}`,
        `127.0.0.2 GET /next rebind.example:${port}`,
        `127.0.0.2 POST /register rebind.example:${port}`,
        `127.0.0.2 POST /lost-response rebind.example:${port}`
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        NetworkModule.layer.pipe(
          Layer.provideMerge(
            Database.layer({ dataDir: tempDir("mcp-rebind"), readers: 1, allowNetworkFs: false, ...testWorkers })
          ),
          Layer.provide(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
        )
      )
    )
  )

  it("a service's answer isn't repeated in the error", () => {
    const text = briefSignInError(
      "HTTP 400: Invalid OAuth error response: SyntaxError: Unexpected token. Raw body: <html>secret</html>"
    )
    assert.notInclude(text, "secret")
    assert.isAtMost(briefSignInError("x".repeat(1000)).length, 200)
  })
})
