import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverPort, testConfig, withServer } from "./support/config.ts"

describe("rpc", () => {
  it.live("single-user mode: every connection is the local admin", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      assert.strictEqual(me.handle, "local")
      assert.strictEqual(me.role, "admin")
      const health = yield* api.Health()
      assert.strictEqual(health.readers, 1)
      assert.isAtLeast(health.eventLoopP99Ms, 0)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("proxy mode: the identity header selects the user, and its absence is Unauthorized", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client({ "Remote-User": "alice" })
      assert.strictEqual((yield* alice.Whoami()).handle, "alice")

      const bob = yield* client({ "Remote-User": "bob" })
      const bobUser = yield* bob.Whoami()
      assert.strictEqual(bobUser.handle, "bob")
      assert.strictEqual(bobUser.role, "user") // alice came first and administers the instance

      const anonymous = yield* client()
      const result = yield* anonymous.Whoami().pipe(
        Effect.map(() => "allowed"),
        Effect.catchTag("Unauthorized", (e) => Effect.succeed(`Unauthorized: ${e.message}`))
      )
      assert.strictEqual(result, "Unauthorized: missing remote-user header")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("proxy mode: a client can't name a user in its own message headers", () => {
    // The RPC server appends message headers after the upgrade's, and later entries win.
    const config = testConfig({ authMode: "proxy" })
    const whoami = (connectHeaders: Record<string, string>, messageHeaders: ReadonlyArray<[string, string]>) =>
      Effect.flatMap(serverPort, (port) =>
        Effect.callback<string>((resume) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: connectHeaders
          } as unknown as Array<string>)
          ws.onopen = () =>
            ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "Whoami", payload: null, headers: messageHeaders }))
          ws.onmessage = (event) => {
            ws.close()
            const exit = JSON.parse(String(event.data)).exit
            resume(Effect.succeed(exit._tag === "Success" ? exit.value.handle : exit.cause[0].error._tag))
          }
        })
      )
    return Effect.gen(function* () {
      assert.strictEqual(yield* whoami({ "Remote-User": "alice" }, [["remote-user", "mallory"]]), "alice")
      assert.strictEqual(yield* whoami({}, [["remote-user", "mallory"]]), "Unauthorized")
    }).pipe(withServer(config))
  })

  it.live("connections: a key goes in and never comes out", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client({ "Remote-User": "alice" })
      const created = yield* alice.CreateConnection({
        kind: "openrouter",
        settings: {
          name: "Gateway",
          baseUrl: null,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-or-secret-value-4321"
      })
      assert.isTrue(created.hasKey)
      assert.strictEqual(created.keyHint, "4321")
      const listed = yield* alice.ListConnections()
      assert.notInclude(JSON.stringify(listed), "secret-value")
      yield* alice.SetConnectionHeaders({
        connectionId: created.id,
        headers: { "X-Token": "header-secret" },
        expectedRowVersion: created.rowVersion
      })
      assert.notInclude(JSON.stringify(yield* alice.ListConnections()), "header-secret")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("network settings never show proxy credentials", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client({ "Remote-User": "alice" })
      const set = yield* alice.SetNetworkSettings({
        proxyUrl: "socks5://user:pw@vpn.example:1080",
        bypass: ["localhost", "192.168.0.0/16"],
        forceProxy: false
      })
      assert.strictEqual(set.proxy, "socks5://vpn.example:1080")
      const invalid = yield* alice.SetNetworkSettings({ bypass: ["not a host"], forceProxy: false }).pipe(
        Effect.map(() => "allowed"),
        Effect.catch((error) => Effect.succeed(error._tag))
      )
      assert.strictEqual(invalid, "InvalidNetworkSettings")
    }).pipe(Effect.scoped, withServer(config))
  })
})
