// Exposure safety (spec/DESIGN.md §11): the policy, and the gate on real sockets.
import { mkdirSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { connect } from "node:net"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig } from "../src/config.ts"
import { AddressResolver, makeAddressSet, type Resolve } from "../src/net/addressSet.ts"
import { crossSiteProblem, type ExposureConfig, exposurePolicy, parsePublicOrigins } from "../src/net/exposure.ts"
import { ServerLive } from "../src/server.ts"
import { testBundles } from "./support/bundles.ts"
import { serverPort, testConfig, withServer } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

interface PolicyConfig extends ExposureConfig {
  readonly allowedIps: ReadonlyArray<string>
  readonly trustedProxies: ReadonlyArray<string>
}

const policyConfig = (overrides: Partial<PolicyConfig>): PolicyConfig => ({
  host: "127.0.0.1",
  authMode: "single",
  allowedIps: [],
  trustedProxies: [],
  allowInsecureExposure: false,
  ...overrides
})

/** Both lists as live sets; the scope may end at once, since literals need no fiber. */
const lists = (config: PolicyConfig) =>
  Effect.all({
    allowedIps: makeAddressSet("ALLOWED_IPS", config.allowedIps),
    trustedProxies: makeAddressSet("TRUSTED_PROXIES", config.trustedProxies)
  })

const policy = (overrides: Partial<PolicyConfig>, passwords = false) => {
  const config = policyConfig(overrides)
  const result = exposurePolicy(config, Effect.runSync(Effect.scoped(lists(config))), () => passwords)
  if (typeof result === "string") throw new Error(result)
  return result
}

const refusal = (overrides: Partial<PolicyConfig>) => {
  const config = policyConfig({ host: "0.0.0.0", ...overrides })
  const result = exposurePolicy(config, Effect.runSync(Effect.scoped(lists(config))), () => false)
  assert.isString(result)
  return result as string
}

describe("exposure policy", () => {
  it("single mode on loopback serves loopback only", () => {
    const { allows } = policy({})
    assert.isTrue(allows("127.0.0.1"))
    assert.isTrue(allows("::1"))
    assert.isTrue(allows("::ffff:127.0.0.1"))
    assert.isFalse(allows("192.168.1.20"))
    assert.isFalse(allows(undefined))
  })

  it("refuses to listen beyond loopback without protection", () => {
    assert.include(refusal({}), "Refusing to listen on 0.0.0.0")
    assert.include(refusal({ host: "::" }), "Refusing")
    assert.include(refusal({ host: "192.168.1.5" }), "Refusing")
    assert.include(refusal({ authMode: "proxy" }), "Refusing")
    assert.include(refusal({ allowedIps: [" ", ""] }), "Refusing")
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) policy({ host })
  })

  it("single mode adds ALLOWED_IPS to loopback, in both families", () => {
    const { allows } = policy({ host: "0.0.0.0", allowedIps: ["192.168.1.0/24", "fd00::/8"] })
    assert.isTrue(allows("192.168.1.20"))
    assert.isTrue(allows("::ffff:192.168.1.20"))
    assert.isTrue(allows("fd00::5"))
    assert.isTrue(allows("127.0.0.1"))
    assert.isFalse(allows("192.168.2.20"))
  })

  it("proxy mode serves the trusted proxies only, and loopback only when none is named", () => {
    const named = policy({ host: "0.0.0.0", authMode: "proxy", trustedProxies: ["172.18.0.5"] })
    assert.isTrue(named.allows("172.18.0.5"))
    assert.isFalse(named.allows("127.0.0.1"))
    assert.isFalse(named.allows("172.18.0.6"))
    const unnamed = policy({ authMode: "proxy" })
    assert.isTrue(unnamed.allows("127.0.0.1"))
  })

  it("rejects ALLOWED_IPS in proxy mode and entries that aren't addresses", () => {
    assert.include(refusal({ authMode: "proxy", allowedIps: ["10.0.0.1"], trustedProxies: ["10.0.0.2"] }), "proxy mode")
    assert.include(refusal({ allowedIps: ["300.1.1.1"] }), "300.1.1.1")
    assert.include(refusal({ allowedIps: ["proxy lan"] }), "proxy lan")
    assert.include(refusal({ allowedIps: ["10.0.0.0/33"] }), "10.0.0.0/33")
    assert.include(refusal({ authMode: "proxy", trustedProxies: ["*.lan"] }), "TRUSTED_PROXIES")
    // Number("") is 0, so a sloppy parser would read these as /0 and allow everyone.
    for (const entry of ["10.0.0.0/", "10.0.0.0/0x8", "10.0.0.0/8.0", "10.0.0.0/ 8", "10.0.0.0/8/x"]) {
      assert.include(refusal({ allowedIps: [entry] }), entry)
    }
  })

  it("refuses the insecure override together with lists it would silently undo", () => {
    assert.include(refusal({ allowInsecureExposure: true, allowedIps: ["10.0.0.1"] }), "can't be combined")
    assert.include(
      refusal({ allowInsecureExposure: true, authMode: "proxy", trustedProxies: ["10.0.0.1"] }),
      "can't be combined"
    )
  })

  it("single mode serves everyone beyond loopback while an account has a password, and only then", () => {
    let passwords = true
    const config = policyConfig({ host: "0.0.0.0" })
    const result = exposurePolicy(config, Effect.runSync(Effect.scoped(lists(config))), () => passwords)
    if (typeof result === "string") throw new Error(result)
    assert.isTrue(result.allows("203.0.113.9"))
    passwords = false // the last password went: back to loopback
    assert.isFalse(result.allows("203.0.113.9"))
    assert.isTrue(result.allows("127.0.0.1"))
    // An allowlist stays a restriction; proxy mode never lets passwords widen it.
    assert.isFalse(policy({ host: "0.0.0.0", allowedIps: ["10.0.0.0/8"] }, true).allows("203.0.113.9"))
    assert.isFalse(policy({ authMode: "proxy" }, true).allows("203.0.113.9"))
  })

  it("ALLOW_INSECURE_EXPOSURE serves everyone", () => {
    assert.isTrue(policy({ host: "0.0.0.0", allowInsecureExposure: true }).allows("203.0.113.9"))
  })
})

/** A resolver answering from `table`, which a test may change; "fail" is a resolver that can't answer. */
const fakeDns = (table: Record<string, ReadonlyArray<string> | "fail">) => {
  const calls: Array<string> = []
  const resolve: Resolve = async (name) => {
    calls.push(name)
    const answer = table[name]
    if (answer === "fail") throw new Error("SERVFAIL")
    return answer ?? []
  }
  return { table, calls, resolve }
}

/** Lets the fake resolver's promises settle after the clock moves. */
const settle = Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
const advance = (duration: Parameters<typeof TestClock.adjust>[0]) =>
  Effect.andThen(TestClock.adjust(duration), Effect.andThen(settle, settle))

const proxyPolicy = (trustedProxies: ReadonlyArray<string>, dns: ReturnType<typeof fakeDns>) =>
  Effect.gen(function* () {
    const config = policyConfig({ host: "0.0.0.0", authMode: "proxy", trustedProxies })
    const result = exposurePolicy(config, yield* lists(config), () => false)
    if (typeof result === "string") throw new Error(result)
    return result
  }).pipe(Effect.provideService(AddressResolver, dns.resolve))

describe("trusted host names", () => {
  it.effect("a name trusts every address it resolves to, in both families", () => {
    const dns = fakeDns({ traefik: ["172.31.7.9", "fd00::9"] })
    return Effect.gen(function* () {
      const { allows, summary } = yield* proxyPolicy(["traefik", "127.0.0.1"], dns)
      for (const ip of ["172.31.7.9", "::ffff:172.31.7.9", "fd00::9", "127.0.0.1"]) assert.isTrue(allows(ip), ip)
      assert.isFalse(allows("172.20.0.10"))
      assert.include(summary(), "traefik (172.31.7.9, fd00::9), 127.0.0.1")
    }).pipe(Effect.scoped)
  })

  it.effect("a proxy that moved is accepted seconds after it first connects, and its old address refused", () => {
    const dns = fakeDns({ traefik: ["172.31.7.19"] })
    return Effect.gen(function* () {
      const { allows, refused } = yield* proxyPolicy(["traefik"], dns)
      assert.isTrue(allows("172.31.7.19"))
      dns.table.traefik = ["172.31.7.9"]
      assert.isFalse(allows("172.31.7.9"))
      refused("172.31.7.9") // asks for a resolution, at most once every 5 s
      refused("172.31.7.9")
      yield* advance("4 seconds")
      assert.isFalse(allows("172.31.7.9"))
      assert.deepStrictEqual(dns.calls, ["traefik"])
      yield* advance("1 second")
      assert.isTrue(allows("172.31.7.9"))
      assert.isFalse(allows("172.31.7.19"))
      assert.lengthOf(dns.calls, 2)
      // Without a refused connection, the background resolution catches a move within 30 s.
      dns.table.traefik = ["172.20.0.30"]
      yield* advance("30 seconds")
      assert.isTrue(allows("172.20.0.30"))
      assert.isFalse(allows("172.31.7.9"))
    }).pipe(Effect.scoped)
  })

  it.effect("a name that doesn't resolve trusts nothing, and the server still starts", () => {
    const dns = fakeDns({ broken: "fail" })
    return Effect.gen(function* () {
      const { allows, summary } = yield* proxyPolicy(["missing", "broken", "10.0.0.1"], dns)
      assert.isTrue(allows("10.0.0.1"))
      assert.isFalse(allows("127.0.0.1"))
      assert.include(summary(), "missing (unresolved), broken (unresolved), 10.0.0.1")
      // Names alone, none resolving: nothing gets in, loopback included.
      const only = yield* proxyPolicy(["missing"], dns)
      assert.isFalse(only.allows("127.0.0.1"))
    }).pipe(Effect.scoped)
  })

  it.effect("when the resolver can't answer, the last addresses stand for 5 minutes, then nothing", () => {
    const dns = fakeDns({ traefik: ["172.31.7.9"] })
    return Effect.gen(function* () {
      const { allows } = yield* proxyPolicy(["traefik"], dns)
      dns.table.traefik = "fail"
      yield* advance("4 minutes")
      yield* advance("30 seconds")
      assert.isTrue(allows("172.31.7.9"))
      yield* advance("30 seconds")
      assert.isFalse(allows("172.31.7.9"))
      // A name that's gone (no records) is dropped at once, not after 5 minutes.
      dns.table.traefik = ["172.31.7.9"]
      yield* advance("30 seconds")
      assert.isTrue(allows("172.31.7.9"))
      dns.table.traefik = []
      yield* advance("30 seconds")
      assert.isFalse(allows("172.31.7.9"))
    }).pipe(Effect.scoped)
  })

  it.effect("host names are entries; malformed ones aren't", () => {
    const dns = fakeDns({})
    return Effect.gen(function* () {
      const set = yield* makeAddressSet("TRUSTED_PROXIES", [
        "traefik",
        "proxy.lan.",
        "rp_proxy",
        "*.lan",
        "a..b",
        "1.2.3"
      ])
      assert.deepStrictEqual(set.invalid, ["*.lan", "a..b", "1.2.3"])
    }).pipe(Effect.scoped, Effect.provideService(AddressResolver, dns.resolve))
  })

  it.effect("a refused connection is worth a warning once a minute per address, naming the trusted set", () => {
    const dns = fakeDns({ traefik: ["172.31.7.19"] })
    return Effect.gen(function* () {
      const { refused, refusal } = yield* proxyPolicy(["traefik", "127.0.0.1"], dns)
      const warning = refused("172.31.7.9", 0)
      assert.include(warning, "172.31.7.9")
      assert.include(warning, "AUTH_MODE=proxy")
      assert.include(warning, "traefik (172.31.7.19), 127.0.0.1")
      assert.isUndefined(refused("172.31.7.9", 59_000))
      assert.isString(refused("172.20.0.10", 59_000))
      assert.isString(refused("172.31.7.9", 60_000))
      assert.strictEqual(refusal("172.31.7.9"), "172.31.7.9 isn't a trusted proxy of this instance.\n")
    }).pipe(Effect.scoped)
  })

  it.effect("connections from many addresses can't flood the log: 20 warnings a minute in all", () => {
    const dns = fakeDns({ traefik: ["172.31.7.19"] })
    return Effect.gen(function* () {
      const { refused } = yield* proxyPolicy(["traefik"], dns)
      const warnings = Array.from({ length: 1500 }, (_, i) => refused(`2001:db8::${i.toString(16)}`, 1000 + i))
      assert.lengthOf(
        warnings.filter((warning) => warning !== undefined),
        20
      )
      // A suppressed address isn't remembered as warned, and the next warning counts what wasn't logged.
      const next = refused("2001:db8::1f", 61_000)
      assert.include(next, "from 2001:db8::1f")
      assert.include(next, "1480 more refused connections weren't logged")
      assert.notInclude(refused("2001:db8::20", 61_001), "weren't logged")
    }).pipe(Effect.scoped)
  })
})

describe("cross-site requests", () => {
  const publicOf = (entries: ReadonlyArray<string>) => parsePublicOrigins(entries).publicOrigins
  const ok = (
    host: string | undefined,
    origin: string | undefined,
    publicOrigins: ReadonlyArray<string> = [],
    mode: "single" | "proxy" = "single"
  ) => crossSiteProblem({ host, origin }, publicOf(publicOrigins), mode === "single") === undefined

  it("serves pages from the address the request was sent to", () => {
    assert.isTrue(ok("127.0.0.1:8080", "http://127.0.0.1:8080"))
    assert.isTrue(ok("localhost:5173", "http://localhost:5173"))
    assert.isTrue(ok("[::1]:8080", "http://[::1]:8080"))
    assert.isTrue(ok("192.168.1.5:8080", "http://192.168.1.5:8080"))
    assert.isTrue(ok("127.0.0.1:8080", undefined))
    assert.isTrue(ok(undefined, undefined))
  })

  it("refuses other sites' pages", () => {
    assert.isFalse(ok("127.0.0.1:8080", "https://evil.example"))
    assert.isFalse(ok("127.0.0.1:8080", "http://127.0.0.1:9999"))
    assert.isFalse(ok("127.0.0.1:8080", "null"))
    assert.isFalse(ok(undefined, "http://127.0.0.1:8080"))
  })

  it("refuses names that aren't this instance's, so DNS rebinding finds nothing", () => {
    assert.isFalse(ok("evil.example:8080", "http://evil.example:8080"))
    assert.isFalse(ok("evil.example:8080", undefined))
    assert.isFalse(ok("bad host", undefined))
  })

  it("serves the public origins, whatever Host a proxy forwards", () => {
    const origins = ["https://rp.example.com"]
    assert.isTrue(ok("rp.example.com", "https://rp.example.com", origins))
    assert.isTrue(ok("127.0.0.1:8080", "https://rp.example.com", origins))
    // nginx's default forwards its upstream's name; only proxy mode can accept that Host.
    assert.isTrue(ok("rp:8080", "https://rp.example.com", origins, "proxy"))
    assert.isFalse(ok("rp:8080", "https://rp.example.com", origins, "single"))
    assert.isFalse(ok("rp.example.com", "https://evil.example", origins, "proxy"))
    // A public host is reachable only through its listed scheme.
    assert.isFalse(ok("rp.example.com", "http://rp.example.com", origins, "proxy"))
  })

  it("takes PUBLIC_ORIGINS entries only when they're exactly origins", () => {
    const { publicOrigins, invalid } = parsePublicOrigins(["https://RP.example.com/", " ", "http://rp:8080"])
    assert.deepStrictEqual(publicOrigins.origins, ["https://rp.example.com", "http://rp:8080"])
    const bad = [
      "rp.example.com",
      "file:///x",
      "https://*.example.com",
      "https://rp.example.com/app",
      "https://u:p@rp.example.com"
    ]
    assert.deepStrictEqual(parsePublicOrigins(bad).invalid, bad)
    assert.deepStrictEqual(invalid, [])
  })
})

// A second address of this machine, so a connection can come from somewhere other than
// loopback. Absent in some sandboxes, where the socket tests are skipped.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address

/**
 * GET /healthz with the chosen source address. Dial loopback even for a LAN
 * source: the peer identity is unchanged, without sending the request through a
 * host's LAN HTTP intermediary (which can replace an early refusal with a 500).
 */
const healthz = (from: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<number, Error>((resume) => {
      const req = request({ host: "127.0.0.1", port, path: "/healthz", localAddress: from, headers }, (res) => {
        res.resume()
        resume(Effect.succeed(res.statusCode ?? 0))
      })
      req.on("error", (error) => resume(Effect.fail(error)))
      req.end()
    })
  )

/**
 * Sends pipelined requests from `from` on one raw socket, resolving to everything the
 * server wrote before ending it.
 */
const pipelined = (from: string) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<string>((resume) => {
      let received = ""
      const socket = connect({ host: "127.0.0.1", port, localAddress: from, allowHalfOpen: true }, () => {
        socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\nGET /index.html HTTP/1.1\r\nHost: x\r\n\r\n")
      })
      socket.on("data", (chunk) => (received += String(chunk)))
      socket.on("error", () => {})
      socket.on("end", () => {
        socket.destroy()
        resume(Effect.succeed(received))
      })
    })
  )

describe.skipIf(lanIp === undefined)("exposure gate", () => {
  it.live("a refused peer's requests never reach a handler", () => {
    const config = testConfig({ host: "0.0.0.0", allowedIps: ["192.0.2.1"] })
    const handled: Array<unknown> = []
    const warnings: Array<string> = []
    const collector = Logger.make((options) => {
      if (String(options.message).includes("Sent HTTP response")) handled.push(options.message)
      if (String(options.message).includes("Refused a connection")) warnings.push(String(options.message))
    })
    return Effect.gen(function* () {
      const received = yield* pipelined(lanIp!)
      assert.match(received, /^HTTP\/1\.1 403/)
      assert.include(received, `${lanIp} isn't allowed to connect to this instance.`)
      assert.lengthOf(warnings, 1)
      assert.include(warnings[0], `from ${lanIp}: AUTH_MODE=single accepts loopback, 192.0.2.1 only`)
      yield* Effect.sleep("200 millis")
      assert.deepStrictEqual(handled, [])
      assert.strictEqual(yield* healthz("127.0.0.1"), 200)
      assert.lengthOf(handled, 1) // the collector does see handled requests
    }).pipe(withServer(config), Effect.provide(Logger.layer([collector])))
  })

  it.live("single mode turns away an address not on the list, before any route", () => {
    const config = testConfig({ host: "0.0.0.0", allowedIps: ["192.0.2.1"] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* healthz("127.0.0.1"), 200)
      assert.strictEqual(yield* healthz(lanIp!), 403)
    }).pipe(withServer(config))
  })

  it.live("proxy mode serves the named proxy and turns away loopback", () => {
    const config = testConfig({ host: "0.0.0.0", authMode: "proxy", trustedProxies: [lanIp!] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* healthz(lanIp!), 200)
      assert.strictEqual(yield* healthz("127.0.0.1"), 403)
    }).pipe(withServer(config))
  })
})

/** Opens the RPC socket with an Origin and calls ListConnections, resolving to what happened. */
const rpcFrom = (origin: string) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<string>((resume) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
        headers: { Origin: origin }
      } as unknown as Array<string>)
      ws.onopen = () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "ListConnections", payload: null, headers: [] }))
      ws.onmessage = (event) => {
        ws.close()
        resume(Effect.succeed(JSON.parse(String(event.data)).exit._tag))
      }
      ws.onerror = () => resume(Effect.succeed("refused"))
    })
  )

describe("cross-site guard", () => {
  it.live("another site's page can't use the RPC socket of a local instance", () => {
    const config = testConfig({})
    return Effect.gen(function* () {
      const port = yield* serverPort
      assert.strictEqual(yield* rpcFrom(`http://127.0.0.1:${port}`), "Success")
      assert.strictEqual(yield* rpcFrom("https://evil.example"), "refused")
      // DNS rebinding: the attacker's name, re-resolved to loopback, is same-origin with itself.
      // (WebSocket clients won't send a custom Host, so this one is plain HTTP.)
      const rebound = `evil.example:${port}`
      assert.strictEqual(yield* healthz("127.0.0.1", { Host: rebound, Origin: `http://${rebound}` }), 403)
    }).pipe(withServer(config))
  })
})

/** GET `path` on loopback, resolving to the status and the Content-Security-Policy. */
const cspOf = (path: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<{ status: number; csp: string }, Error>((resume) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        res.resume()
        resume(Effect.succeed({ status: res.statusCode ?? 0, csp: String(res.headers["content-security-policy"]) }))
      })
      req.on("error", (error) => resume(Effect.fail(error)))
      req.end()
    })
  )

describe("content security policy", () => {
  it.live("every response has it: the app, its routes, the health check and a refusal", () => {
    const clientDist = tempDir("client")
    writeFileSync(join(clientDist, "index.html"), "<!doctype html><title>t</title>")
    const config = testConfig({ clientDist })
    return Effect.gen(function* () {
      const port = yield* serverPort
      for (const path of ["/", "/chats/some-chat", "/healthz"]) {
        const { status, csp } = yield* cspOf(path, { Accept: "text/html" })
        assert.strictEqual(status, 200, path)
        const directives = new Map(
          csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")] as const)
        )
        assert.strictEqual(directives.get("default-src"), "'self'")
        assert.strictEqual(directives.get("script-src"), "'self'", "no inline script, none from elsewhere")
        assert.strictEqual(directives.get("img-src"), "'self' blob: data:")
        assert.strictEqual(directives.get("connect-src"), `'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port}`)
        assert.strictEqual(directives.get("frame-ancestors"), "'none'")
      }
      const refused = yield* cspOf("/healthz", { Origin: "https://evil.example" })
      assert.strictEqual(refused.status, 403)
      assert.include(refused.csp, "script-src 'self'")
    }).pipe(withServer(config))
  })

  it.live("the panel frame's page has its own: only the bootstrap runs, and Origin null is refused", () => {
    const config = testConfig({ clientDist: tempDir("client") })
    return Effect.gen(function* () {
      const port = yield* serverPort
      const directivesOf = (csp: string) =>
        new Map(csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")] as const))
      const page = (headers?: Record<string, string>, path = "/frame/panel") =>
        Effect.flatMap(serverPort, (p) =>
          Effect.callback<{ status: number; csp: string; body: string }, Error>((resume) => {
            const req = request({ host: "127.0.0.1", port: p, path, headers }, (res) => {
              let body = ""
              res.setEncoding("utf8")
              res.on("data", (chunk: string) => (body += chunk))
              res.on("end", () =>
                resume(
                  Effect.succeed({
                    status: res.statusCode ?? 0,
                    csp: String(res.headers["content-security-policy"] ?? ""),
                    body
                  })
                )
              )
            })
            req.on("error", (error) => resume(Effect.fail(error)))
            req.end()
          })
        )
      const { status, csp, body } = yield* page()
      assert.strictEqual(status, 200)
      const directives = directivesOf(csp)
      assert.strictEqual(directives.get("default-src"), "'none'")
      // Only the page's own script tag runs: its nonce, fresh on every load.
      const nonce = /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(directives.get("script-src") ?? "")?.[1]
      assert.isDefined(nonce, directives.get("script-src"))
      assert.include(body, `<script nonce="${nonce}" src="/frame/bootstrap.js">`)
      assert.notStrictEqual(directivesOf((yield* page()).csp).get("script-src"), directives.get("script-src"))
      assert.strictEqual(directives.get("connect-src"), "'none'")
      assert.strictEqual(directives.get("form-action"), "'none'")
      assert.strictEqual(directives.get("frame-ancestors"), "'self'")
      assert.notInclude(csp, String(port), "no path of the app's is a script source")
      // An IPv6 Host can't be named in a source, and still runs only the bootstrap.
      for (const host of ["[::1]", `[::1]:${port}`]) {
        const odd = yield* page({ Host: host })
        assert.notInclude(directivesOf(odd.csp).get("script-src"), "'self'", host)
        const oddNonce = /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(directivesOf(odd.csp).get("script-src") ?? "")?.[1]
        assert.include(odd.body, `nonce="${oddNonce}"`, host)
      }
      // A malformed Host can't name the paths: a panel with scripts gets the policy without them.
      const malformed = yield* page({ Host: "evil.example/x" }, "/frame/panel?scripts=1")
      assert.match(directivesOf(malformed.csp).get("script-src") ?? "", /^'(nonce-[A-Za-z0-9+/=]+|none)'$/)
      // The frame's own requests carry Origin: null.
      assert.strictEqual((yield* cspOf("/frame/panel", { Origin: "null" })).status, 403)
      assert.strictEqual((yield* cspOf("/healthz", { Origin: "null" })).status, 403)
    }).pipe(withServer(config))
  })

  it.live(
    "a panel with scripts runs its own and the vendored libraries, and reaches the internet only when allowed",
    () => {
      const clientDist = tempDir("client")
      mkdirSync(join(clientDist, "frame", "lib"), { recursive: true })
      writeFileSync(join(clientDist, "frame", "lib", "jquery.min.js"), "/* jquery */")
      const config = testConfig({ clientDist })
      return Effect.gen(function* () {
        const port = yield* serverPort
        const directivesOf = (csp: string) =>
          new Map(csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")] as const))
        const origin = `127.0.0.1:${port}`
        const lib = `http://${origin}/frame/lib/ https://${origin}/frame/lib/`
        const scripts = directivesOf((yield* cspOf("/frame/panel?scripts=1")).csp)
        assert.strictEqual(
          scripts.get("script-src"),
          `'unsafe-inline' 'unsafe-eval' http://${origin}/frame/bootstrap.js https://${origin}/frame/bootstrap.js ${lib}`
        )
        assert.strictEqual(scripts.get("style-src"), `'unsafe-inline' ${lib}`)
        assert.strictEqual(scripts.get("img-src"), `data: blob: ${lib}`)
        assert.strictEqual(scripts.get("connect-src"), "'none'", "no network without its own permission")
        assert.strictEqual(scripts.get("form-action"), "'none'")
        // The internet only with scripts: `network` alone is the plain page.
        const alone = directivesOf((yield* cspOf("/frame/panel?network=1")).csp)
        assert.notInclude(alone.get("script-src"), "unsafe-inline")
        assert.strictEqual(alone.get("connect-src"), "'none'")
        const network = directivesOf((yield* cspOf("/frame/panel?scripts=1&network=1")).csp)
        assert.strictEqual(network.get("connect-src"), "https:")
        for (const directive of ["script-src", "style-src", "img-src", "font-src"])
          assert.isTrue(network.get(directive)!.endsWith(" https:"), directive)
        assert.strictEqual(network.get("frame-ancestors"), "'self'")
        // On an IPv6 Host the paths can't be named: 'self', for a block that runs what it likes.
        const ipv6 = directivesOf((yield* cspOf("/frame/panel?scripts=1", { Host: "[::1]" })).csp)
        assert.strictEqual(ipv6.get("script-src"), "'unsafe-inline' 'unsafe-eval' 'self'")
        assert.strictEqual(ipv6.get("connect-src"), "'none'")
        // The libraries answer a panel's own reads (fonts come with Origin: null) and nothing else.
        const read = yield* Effect.flatMap(serverPort, (p) =>
          Effect.callback<{ status: number; allow: unknown }, Error>((resume) => {
            const req = request(
              { host: "127.0.0.1", port: p, path: "/frame/lib/jquery.min.js", headers: { Origin: "null" } },
              (res) => {
                res.resume()
                resume(
                  Effect.succeed({ status: res.statusCode ?? 0, allow: res.headers["access-control-allow-origin"] })
                )
              }
            )
            req.on("error", (error) => resume(Effect.fail(error)))
            req.end()
          })
        )
        assert.deepStrictEqual(read, { status: 200, allow: "*" })
        assert.strictEqual((yield* cspOf("/frame/panel?scripts=1", { Origin: "null" })).status, 403)
        assert.strictEqual((yield* cspOf("/rpc", { Origin: "null" })).status, 403)
        assert.strictEqual((yield* cspOf("/library/media?id=x", { Origin: "null" })).status, 403)
      }).pipe(withServer(config))
    }
  )

  it.live("a Host that isn't a host name adds no WebSocket origin", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      // Proxy mode with no PUBLIC_ORIGINS refuses it, and the refusal still has the policy.
      const { csp } = yield* cspOf("/healthz", { Host: "x; script-src *" })
      assert.include(csp, "connect-src 'self'; ")
      assert.notInclude(csp, "script-src *")
    }).pipe(withServer(config))
  })
})

describe("cross-site guard in proxy mode", () => {
  it.live("keeps the Host check while loopback is a trusted proxy", () => {
    // A page rebound to loopback would be same-origin and could send its own identity header.
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const port = yield* serverPort
      const rebound = `evil.example:${port}`
      assert.strictEqual(yield* healthz("127.0.0.1", { Host: rebound, Origin: `http://${rebound}` }), 403)
      assert.strictEqual(yield* healthz("127.0.0.1", { Host: `localhost:${port}` }), 200)
    }).pipe(withServer(config))
  })
})

describe("exposure at startup", () => {
  it.live("the server doesn't start beyond loopback without protection", () => {
    const config = testConfig({ host: "0.0.0.0" })
    return Effect.gen(function* () {
      const error = yield* Layer.build(
        ServerLive.pipe(Layer.provide([Layer.succeed(AppConfig)(config), testBundles]))
      ).pipe(Effect.scoped, Effect.flip)
      assert.strictEqual(error._tag, "UnsafeExposure")
    })
  })
})
