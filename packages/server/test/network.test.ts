// The network module against real local proxies (spec/PROVIDERS.md §6.2).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Database from "../src/db/Database.ts"
import { describeRoute, parseBypass } from "../src/net/route.ts"
import * as Network from "../src/net/Network.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { startHttpProxy, startSocks5Proxy, startTarget } from "./support/proxies.ts"
import { tempDir } from "./support/tempDir.ts"

const layer = (dataDir: string) =>
  Network.layer.pipe(
    Layer.provideMerge(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" })),
    Layer.provide(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )

const resource = <A extends { close: () => Promise<void> }>(start: () => Promise<A>) =>
  Effect.acquireRelease(Effect.promise(start), (r) => Effect.promise(() => r.close()))

describe("network", () => {
  it.live("goes direct to local targets by default, and through the proxy otherwise", () =>
    Effect.gen(function* () {
      const target = yield* resource(() => startTarget(() => ({ json: { ok: true } })))
      const proxy = yield* resource(startHttpProxy)
      const network = yield* Network.Network
      const routes: Array<string> = []
      const fetch = network.fetchFor({ mode: "inherit" }, (route, url) => routes.push(describeRoute(route, url)))

      yield* network.setInstance({ proxyUrl: proxy.url, bypass: ["localhost", "127.0.0.0/8"], forceProxy: false })
      yield* Effect.promise(() => fetch(`${target.url}/a`).then((r) => r.json()))
      assert.deepStrictEqual(proxy.tunnels(), [])
      assert.strictEqual(routes.at(-1), "direct: 127.0.0.1 is in the bypass list")

      // With an empty bypass list, the same target goes through the proxy.
      yield* network.setInstance({ proxyUrl: undefined, bypass: [], forceProxy: false })
      const body = yield* Effect.promise(() => fetch(`${target.url}/b`).then((r) => r.json()))
      assert.deepStrictEqual(body, { ok: true })
      assert.strictEqual(proxy.tunnels().length, 1)
      assert.match(routes.at(-1)!, /^via proxy http:\/\/127\.0\.0\.1:\d+$/)
      assert.strictEqual(target.requests(), 2)
    }).pipe(Effect.scoped, Effect.provide(layer(tempDir("net"))))
  )

  it.live("a prepared request keeps the transport whose secrets it registered", () =>
    Effect.gen(function* () {
      const target = yield* resource(() => startTarget(() => ({ json: { ok: true } })))
      const first = yield* resource(startHttpProxy)
      const second = yield* resource(startHttpProxy)
      const network = yield* Network.Network
      yield* network.setInstance({ proxyUrl: first.url, bypass: [], forceProxy: false })
      const secrets: string[] = []
      const prepared = network.prepare({ mode: "inherit" }, (value) => secrets.push(value))
      yield* network.setInstance({ proxyUrl: second.url, bypass: [], forceProxy: false })
      assert.deepStrictEqual(secrets, [first.url])
      const route = yield* prepared.route(new URL(target.url))
      assert.deepStrictEqual(route, { via: "proxy", proxy: first.url, source: "instance" })
      yield* Effect.promise(() =>
        prepared
          .fetchFor()(target.url)
          .then((r) => r.text())
      )
      assert.strictEqual(first.tunnels().length, 1)
      assert.strictEqual(second.tunnels().length, 0)
    }).pipe(Effect.scoped, Effect.provide(layer(tempDir("net"))))
  )

  it.live("a host bypassed by name goes direct whatever its addresses", () =>
    Effect.gen(function* () {
      const target = yield* resource(() => startTarget(() => ({ json: { ok: true } })))
      const proxy = yield* resource(startHttpProxy)
      const network = yield* Network.Network
      // Only the name is listed; pinning to listed addresses would refuse it.
      yield* network.setInstance({ proxyUrl: proxy.url, bypass: ["localhost"], forceProxy: false })
      const fetch = network.fetchFor({ mode: "inherit" })
      const body = yield* Effect.promise(() =>
        fetch(target.url.replace("127.0.0.1", "localhost") + "/named").then((r) => r.json())
      )
      assert.deepStrictEqual(body, { ok: true })
      assert.deepStrictEqual(proxy.tunnels(), [])
    }).pipe(Effect.scoped, Effect.provide(layer(tempDir("net"))))
  )

  it.live("honors a connection's own SOCKS5 proxy with credentials, and its direct override", () =>
    Effect.gen(function* () {
      const target = yield* resource(() => startTarget(() => ({ json: { ok: true } })))
      const instance = yield* resource(startHttpProxy)
      const socks = yield* resource(() => startSocks5Proxy({ username: "u", password: "p w" }))
      const network = yield* Network.Network
      yield* network.setInstance({ proxyUrl: instance.url, bypass: [], forceProxy: false })

      const viaSocks = network.fetchFor({ mode: "custom", url: socks.url.replace("p w", "p%20w") })
      yield* Effect.promise(() => viaSocks(`${target.url}/socks`).then((r) => r.text()))
      assert.strictEqual(socks.tunnels().length, 1)
      assert.deepStrictEqual(instance.tunnels(), [])

      const direct = network.fetchFor({ mode: "direct" })
      yield* Effect.promise(() => direct(`${target.url}/direct`).then((r) => r.text()))
      assert.deepStrictEqual(instance.tunnels(), [])
      assert.strictEqual(socks.tunnels().length, 1)
      assert.strictEqual(target.requests(), 2)
    }).pipe(Effect.scoped, Effect.provide(layer(tempDir("net"))))
  )

  it.live("keeps the proxy across restarts, encrypted, and never shows its credentials", () =>
    Effect.gen(function* () {
      const dataDir = tempDir("net")
      const set = Effect.gen(function* () {
        const network = yield* Network.Network
        return yield* network.setInstance({
          proxyUrl: "socks5://user:secret@vpn.example:1080",
          bypass: ["10.0.0.0/8"],
          forceProxy: false
        })
      }).pipe(Effect.provide(layer(dataDir)))
      const shown = yield* set
      assert.deepStrictEqual(shown, { forceProxy: false, proxy: "socks5://vpn.example:1080", bypass: ["10.0.0.0/8"] })

      const reloaded = yield* Effect.gen(function* () {
        const network = yield* Network.Network
        const stored = yield* (yield* Database.Reader).GetAppSetting({ key: "network" })
        assert.notInclude(JSON.stringify(stored), "secret")
        const route = yield* network.route(new URL("https://openrouter.ai"), { mode: "inherit" })
        return { view: yield* network.view, route }
      }).pipe(Effect.provide(layer(dataDir)))
      assert.deepStrictEqual(reloaded.view, shown)
      assert.deepStrictEqual(reloaded.route, {
        via: "proxy",
        proxy: "socks5://user:secret@vpn.example:1080",
        source: "instance"
      })
    })
  )

  it.live("refuses settings it can't use", () =>
    Effect.gen(function* () {
      const network = yield* Network.Network
      const result = yield* network
        .setInstance({ proxyUrl: "socks4://old:1080", bypass: ["10.0.0.0/33"], forceProxy: false })
        .pipe(Effect.flip)
      assert.strictEqual(result._tag, "InvalidNetworkSettings")
      if (result._tag === "InvalidNetworkSettings") assert.strictEqual(result.problems.length, 2)
    }).pipe(Effect.provide(layer(tempDir("net"))))
  )
})

describe("bypass routes are pinned to bypassed addresses", () => {
  const lookupWith = (entries: ReadonlyArray<string>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) =>
      Network.bypassOnlyLookup(() => parseBypass(entries).list)("localhost", { all }, (error, address) =>
        resolve({ error, address })
      )
    )

  it("connects only to the answers on the bypass list", async () => {
    // localhost answers 127.0.0.1 and usually ::1; only the IPv4 range is listed.
    const pinned = await lookupWith(["127.0.0.0/8"], true)
    assert.isNull(pinned.error)
    assert.deepStrictEqual(
      (pinned.address as ReadonlyArray<{ address: string }>).map((answer) => answer.address),
      ["127.0.0.1"]
    )
    const single = await lookupWith(["127.0.0.0/8"], false)
    assert.strictEqual(single.address, "127.0.0.1")
    // A name whose answers left the list is refused, not connected anyway.
    assert.isNotNull((await lookupWith(["10.0.0.0/8"], true)).error)
  })
})
