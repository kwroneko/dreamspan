// Exposure safety (spec/DESIGN.md §11): the policy, and the gate on real sockets.
import { request } from "node:http"
import { connect } from "node:net"
import { networkInterfaces } from "node:os"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { AppConfig } from "../src/config.ts"
import { crossSiteProblem, type ExposureConfig, exposurePolicy, parsePublicOrigins } from "../src/net/exposure.ts"
import { ServerLive } from "../src/server.ts"
import { serverPort, testConfig, withServer } from "./support/config.ts"

const policy = (overrides: Partial<ExposureConfig>, passwords = false) => {
  const result = exposurePolicy(
    {
      host: "127.0.0.1",
      authMode: "single",
      allowedIps: [],
      trustedProxies: [],
      allowInsecureExposure: false,
      ...overrides
    },
    () => passwords
  )
  if (typeof result === "string") throw new Error(result)
  return result
}

const refusal = (overrides: Partial<ExposureConfig>) => {
  const result = exposurePolicy(
    {
      host: "0.0.0.0",
      authMode: "single",
      allowedIps: [],
      trustedProxies: [],
      allowInsecureExposure: false,
      ...overrides
    },
    () => false
  )
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
    assert.include(refusal({ allowedIps: ["proxy.lan"] }), "proxy.lan")
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
    const result = exposurePolicy(
      { host: "0.0.0.0", authMode: "single", allowedIps: [], trustedProxies: [], allowInsecureExposure: false },
      () => passwords
    )
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

/** GET /healthz from `from` to `to`, resolving to the status code. */
const healthz = (from: string, to: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<number, Error>((resume) => {
      const req = request({ host: to, port, path: "/healthz", localAddress: from, headers }, (res) => {
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
      const socket = connect({ host: from, port, localAddress: from, allowHalfOpen: true }, () => {
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
    const collector = Logger.make((options) => {
      if (String(options.message).includes("Sent HTTP response")) handled.push(options.message)
    })
    return Effect.gen(function* () {
      const received = yield* pipelined(lanIp!)
      assert.match(received, /^HTTP\/1\.1 403/)
      yield* Effect.sleep("200 millis")
      assert.deepStrictEqual(handled, [])
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1"), 200)
      assert.lengthOf(handled, 1) // the collector does see handled requests
    }).pipe(withServer(config), Effect.provide(Logger.layer([collector])))
  })

  it.live("single mode turns away an address not on the list, before any route", () => {
    const config = testConfig({ host: "0.0.0.0", allowedIps: ["192.0.2.1"] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1"), 200)
      assert.strictEqual(yield* healthz(lanIp!, lanIp!), 403)
    }).pipe(withServer(config))
  })

  it.live("proxy mode serves the named proxy and turns away loopback", () => {
    const config = testConfig({ host: "0.0.0.0", authMode: "proxy", trustedProxies: [lanIp!] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* healthz(lanIp!, lanIp!), 200)
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1"), 403)
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
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1", { Host: rebound, Origin: `http://${rebound}` }), 403)
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
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1", { Host: rebound, Origin: `http://${rebound}` }), 403)
      assert.strictEqual(yield* healthz("127.0.0.1", "127.0.0.1", { Host: `localhost:${port}` }), 200)
    }).pipe(withServer(config))
  })
})

describe("exposure at startup", () => {
  it.live("the server doesn't start beyond loopback without protection", () => {
    const config = testConfig({ host: "0.0.0.0" })
    return Effect.gen(function* () {
      const error = yield* Layer.build(ServerLive.pipe(Layer.provide(Layer.succeed(AppConfig)(config)))).pipe(
        Effect.scoped,
        Effect.flip
      )
      assert.strictEqual(error._tag, "UnsafeExposure")
    })
  })
})
