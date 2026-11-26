import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { McpConnections } from "../src/mcp/McpConnections.ts"
import { client, login, serverLayer, testConfig } from "./support/config.ts"
import { fakeTool, startFakeMcpServer } from "./support/fakeMcpServer.ts"
import { approveSignIn, startFakeAuthServer } from "./support/fakeAuthServer.ts"
import { startHttpProxy, startTarget, testPublicAddress, withTestHost as at } from "./support/proxies.ts"

const rebound = vi.hoisted(() => ({
  host: ["rebind", "invalid"].join("."),
  answers: [] as Array<ReadonlyArray<string>>,
  lookups: 0
}))
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>()
  return {
    ...actual,
    lookup: (host: string, options: { all: true }) =>
      host === rebound.host
        ? Promise.resolve((rebound.answers[rebound.lookups++] ?? []).map((address) => ({ address, family: 4 })))
        : actual.lookup(host, options)
  }
})

const resource = <A extends { close: () => Promise<void> }>(start: () => Promise<A>) =>
  Effect.acquireRelease(Effect.promise(start), (value) => Effect.promise(value.close))

const providerSettings = (baseUrl: string) => ({
  name: "Model fixture",
  baseUrl,
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})
const mcpSettings = (url: string) =>
  ({ name: "Tool fixture", about: "", transport: "streamable-http", url, timeoutS: 5 }) as const

const accounts = Effect.gen(function* () {
  const single = yield* client()
  const admin = yield* single.Whoami()
  assert.strictEqual(admin.role, "admin")
  yield* single.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "admin-password" })
  const owner = yield* client({ cookie: (yield* login(admin.handle, "admin-password")).cookie })
  const account = yield* owner.CreateUser({
    handle: "tester",
    displayName: "Tester",
    role: "user",
    password: "tester-password"
  })
  const member = yield* client({ cookie: (yield* login(account.handle, "tester-password")).cookie })
  return { owner, member, memberId: account.id }
})

const draft = (
  api: Pick<Effect.Success<ReturnType<typeof client>>, "TestConnectionDraft">,
  baseUrl: string,
  model?: string
) =>
  api.TestConnectionDraft({
    kind: "openai-chat",
    settings: providerSettings(baseUrl),
    apiKey: "synthetic-key",
    ...(model === undefined ? {} : { model })
  })

const localName = ["local", "host"].join("")
const blocked = /private or local address/i

describe("provider and MCP address boundary", () => {
  it.live("blocks local destinations for signed-in members even with proxy bypass entries", () =>
    Effect.gen(function* () {
      const model = yield* resource(() => startTarget(() => ({ json: { data: [] } })))
      const { owner, member } = yield* accounts
      const proxy = yield* resource(startHttpProxy)
      yield* owner.SetNetworkSettings({ proxyUrl: proxy.url, bypass: [localName], forceProxy: true })
      const loopback = new URL(model.url).hostname
      const hosts = [
        loopback,
        localName,
        [0, 0, 0, 1].join("."),
        [10, 0, 0, 1].join("."),
        [100, 64, 0, 1].join("."),
        [172, 16, 0, 1].join("."),
        [192, 168, 0, 1].join("."),
        `[${["", "", "1"].join(":")}]`,
        `[${["fe80", "", "1"].join(":")}]`,
        `[${["fd00", "", "1"].join(":")}]`,
        `[${["", "", "ffff", loopback].join(":")}]`,
        [169, 254, 169, 254].join(".")
      ]
      for (const host of hosts) {
        const url = at(model.url, host)
        const tested = yield* draft(member, url)
        assert.isFalse(tested.ok)
        assert.match(tested.detail, blocked)
        const mcp = yield* member.CreateMcpConnection({ settings: mcpSettings(url) })
        assert.isFalse(mcp.check.ok)
        assert.match(mcp.check.detail, blocked)
      }
      assert.strictEqual(model.requests(), 0)
      assert.deepStrictEqual(proxy.tunnels(), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("keeps single-user access and isolates a saved admin connection and shared MCP server", () =>
    Effect.gen(function* () {
      const model = yield* resource(() => startTarget(() => ({ json: { data: [] } })))
      const server = yield* resource(() => startFakeMcpServer({ tools: [fakeTool("echo")] }))
      const single = yield* client()
      assert.isTrue((yield* draft(single, model.url)).ok)
      const saved = yield* single.CreateConnection({
        kind: "openai-chat",
        apiKey: "synthetic-key",
        settings: providerSettings(model.url)
      })
      const { owner, member, memberId } = yield* accounts
      assert.isTrue((yield* owner.TestConnection({ connectionId: saved.id })).ok)
      assert.strictEqual(
        (yield* member.RefreshModels({ connectionId: saved.id }).pipe(Effect.flip))._tag,
        "ProviderError"
      )

      const own = yield* member.CreateConnection({
        kind: "openai-chat",
        apiKey: "synthetic-key",
        settings: providerSettings(model.url)
      })
      yield* member.SetConnectionProxy({ connectionId: own.id, mode: "direct", url: null })
      assert.match((yield* member.TestConnection({ connectionId: own.id })).detail, blocked)

      const created = yield* owner.CreateMcpConnection({ settings: mcpSettings(server.streamableUrl) })
      assert.isTrue(created.check.ok, created.check.detail)
      const connectionId = created.connection.id
      yield* owner.SetMcpShare({ connectionId, scope: "chosen", userIds: [memberId] })
      server.reset()
      const mcp = yield* McpConnections
      const call = yield* mcp.call({
        userId: memberId,
        connectionId,
        tool: "echo",
        args: {},
        attribution: { purpose: "workshop", chatId: null, rolloutId: null, toolCallId: null, attempt: 1 }
      })
      assert.strictEqual(call._tag, "Failed")
      if (call._tag === "Failed") assert.match(call.message, blocked)
      const signIn = yield* member
        .StartMcpSignIn({ connectionId, appOrigin: new URL(at(model.url, localName)).origin })
        .pipe(Effect.flip)
      assert.match(signIn.message, blocked)
      assert.deepStrictEqual(server.requests(), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("pins DNS before connecting and rechecks redirects for models, MCP and OAuth", () =>
    Effect.gen(function* () {
      const { owner, member } = yield* accounts
      const privateTarget = yield* resource(() => startTarget(() => ({ json: {} })))
      const loopback = new URL(privateTarget.url).hostname
      let location = "/again"
      let listModels = false
      const upstream = yield* resource(() =>
        startTarget((request) =>
          listModels && request.url === "/models"
            ? { json: { data: [{ id: "synthetic-model" }] } }
            : { status: 307, headers: { location }, json: null }
        )
      )
      const proxy = yield* resource(() => startHttpProxy(() => loopback))
      yield* owner.SetNetworkSettings({ proxyUrl: proxy.url, bypass: [], forceProxy: false })
      const advertised = at(upstream.url, rebound.host)
      const pinned = new URL(at(upstream.url, testPublicAddress)).host
      const resetDns = () => {
        rebound.answers = [[testPublicAddress], [loopback]]
        rebound.lookups = 0
      }

      rebound.answers = [[testPublicAddress, loopback]]
      rebound.lookups = 0
      assert.match((yield* draft(member, advertised)).detail, blocked)
      assert.deepStrictEqual(proxy.tunnels(), [])

      resetDns()
      assert.match((yield* draft(member, advertised)).detail, blocked)
      assert.strictEqual(rebound.lookups, 2)
      assert.deepStrictEqual(proxy.tunnels(), [pinned])

      resetDns()
      const created = yield* member.CreateMcpConnection({ settings: mcpSettings(advertised) })
      assert.match(created.check.detail, blocked)
      assert.strictEqual(upstream.requests(), 2)
      assert.deepStrictEqual([...new Set(proxy.tunnels())], [pinned])

      location = privateTarget.url
      const publicUrl = at(upstream.url, testPublicAddress)
      assert.match((yield* draft(member, publicUrl)).detail, /redirect/i)
      const redirected = yield* member.CreateMcpConnection({ settings: mcpSettings(publicUrl) })
      assert.match(redirected.check.detail, /redirect/i)
      const signIn = yield* member
        .StartMcpSignIn({
          connectionId: redirected.connection.id,
          appOrigin: new URL(at(upstream.url, localName)).origin
        })
        .pipe(Effect.flip)
      assert.match(signIn.message, /redirect/i)
      listModels = true
      const reply = yield* draft(member, publicUrl, "synthetic-model")
      assert.strictEqual(reply.models, 1, reply.detail)
      assert.isFalse(reply.reply?.ok)
      assert.match(reply.reply?.detail ?? "", /redirect/i)
      assert.strictEqual(privateTarget.requests(), 0)
      assert.isTrue(proxy.tunnels().every((target) => target === pinned))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("rejects a local custom proxy and never sends an OAuth code to a private redirect", () =>
    Effect.gen(function* () {
      const { owner, member } = yield* accounts
      const privateTarget = yield* resource(() => startTarget(() => ({ json: {} })))
      const loopback = new URL(privateTarget.url).hostname
      const proxy = yield* resource(() => startHttpProxy((host) => (host === testPublicAddress ? loopback : host)))
      const auth = yield* resource(() =>
        startFakeAuthServer({ tokenRedirect: privateTarget.url }, { bind: loopback, advertise: testPublicAddress })
      )
      const server = yield* resource(() => startFakeMcpServer({ auth }, testPublicAddress))
      yield* owner.SetNetworkSettings({ proxyUrl: proxy.url, bypass: [], forceProxy: false })
      const connection = yield* member.CreateConnection({
        kind: "openai-chat",
        settings: providerSettings(at(privateTarget.url, testPublicAddress))
      })
      yield* member.SetConnectionProxy({ connectionId: connection.id, mode: "custom", url: privateTarget.url })
      assert.match((yield* member.TestConnection({ connectionId: connection.id })).detail, /proxy.*private or local/i)
      const created = yield* member.CreateMcpConnection({ settings: mcpSettings(server.streamableUrl) })
      const connectionId = created.connection.id
      yield* member.SetMcpProxy({ connectionId, mode: "custom", url: privateTarget.url })
      assert.match((yield* member.CheckMcpConnection({ connectionId })).check.detail, /proxy.*private or local/i)
      yield* member.SetMcpProxy({ connectionId, mode: "inherit", url: null })

      const started = yield* member.StartMcpSignIn({
        connectionId,
        appOrigin: new URL(at(privateTarget.url, localName)).origin
      })
      const back = yield* Effect.promise(() => approveSignIn(at(started.authorizationUrl, loopback)))
      const refused = yield* member
        .FinishMcpSignIn({ state: back.state!, code: back.code, error: null })
        .pipe(Effect.flip)
      assert.match(refused.message, /redirect/i)
      assert.include(auth.requests(), "token:authorization_code")
      assert.strictEqual(privateTarget.requests(), 0)
      assert.isNull((yield* member.GetMcpConnection({ connectionId })).use.signIn)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
