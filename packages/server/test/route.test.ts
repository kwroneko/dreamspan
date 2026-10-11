import { describe, expect, it } from "vitest"
import {
  DEFAULT_BYPASS,
  bypasses,
  decideRoute,
  describeRoute,
  displayProxy,
  parseBypass,
  proxyUrlProblem
} from "../src/net/route.ts"

const { list: defaults } = parseBypass(DEFAULT_BYPASS)

describe("bypass list", () => {
  it("matches local addresses by default, in both families", () => {
    for (const host of ["localhost", "127.0.0.1", "10.2.3.4", "172.20.0.5", "192.168.1.20", "[::1]", "[fd12::5]"]) {
      expect(bypasses(defaults, host), host).toBe(true)
    }
    for (const host of ["api.openai.com", "8.8.8.8", "172.32.0.1", "[2001:db8::1]"]) {
      expect(bypasses(defaults, host), host).toBe(false)
    }
  })

  it("treats IPv4 written as IPv6 as the IPv4 address", () => {
    expect(bypasses(defaults, "gpu.example", ["::ffff:192.168.1.20"])).toBe(true)
  })

  it("matches hostnames exactly or by suffix, and names that resolve into a range", () => {
    const { list, invalid } = parseBypass(["gateway", "*.lan", ".internal", "10.8.0.0/16", "bad host", "1.2.3.4/40"])
    expect(invalid).toEqual(["bad host", "1.2.3.4/40"])
    expect(bypasses(list, "GATEWAY")).toBe(true)
    expect(bypasses(list, "gpu.lan")).toBe(true)
    expect(bypasses(list, "a.b.internal")).toBe(true)
    expect(bypasses(list, "lan")).toBe(false)
    expect(bypasses(list, "llm.example.com", ["10.8.4.4"])).toBe(true)
    expect(bypasses(list, "llm.example.com", ["10.9.4.4"])).toBe(false)
    // Every answer must be on the list, or the connection could land on the public one.
    expect(bypasses(list, "llm.example.com", ["10.8.4.4", "203.0.113.7"])).toBe(false)
    expect(bypasses(list, "llm.example.com", [])).toBe(false)
  })
})

describe("route", () => {
  const resolveTo = (ips: ReadonlyArray<string>) => async () => ips
  const target = (url: string) => new URL(url)
  const base = { instanceProxy: "socks5://user:pw@vpn:1080", bypass: defaults, resolve: resolveTo([]) }

  it("lets the connection's override win", async () => {
    expect(
      await decideRoute({ ...base, target: target("https://api.openai.com"), override: { mode: "direct" } })
    ).toEqual({ via: "direct", reason: "override" })
    // A connection's own proxy applies even to local addresses: it was chosen explicitly.
    expect(
      await decideRoute({
        ...base,
        target: target("http://127.0.0.1:8081"),
        override: { mode: "custom", url: "http://corp:3128" }
      })
    ).toEqual({ via: "proxy", proxy: "http://corp:3128", source: "connection" })
  })

  it("sends local targets direct and the rest through the instance proxy", async () => {
    const inherit = { mode: "inherit" } as const
    expect(await decideRoute({ ...base, target: target("http://192.168.1.20:8081/v1"), override: inherit })).toEqual({
      via: "direct",
      reason: "bypass"
    })
    expect(await decideRoute({ ...base, target: target("https://openrouter.ai/api/v1"), override: inherit })).toEqual({
      via: "proxy",
      proxy: base.instanceProxy,
      source: "instance"
    })
    // A name that resolves to a local address goes direct too.
    expect(
      await decideRoute({
        ...base,
        resolve: resolveTo(["192.168.1.30"]),
        target: target("https://gateway.home.example"),
        override: inherit
      })
    ).toEqual({ via: "direct", reason: "bypass" })
    // A failed lookup leaves it to the proxy.
    expect(
      await decideRoute({
        ...base,
        resolve: () => Promise.reject(new Error("ENOTFOUND")),
        target: target("https://unknown.example"),
        override: inherit
      })
    ).toMatchObject({ via: "proxy" })
  })

  it("goes direct when there's no proxy at all, without resolving anything", async () => {
    const route = await decideRoute({
      ...base,
      instanceProxy: null,
      resolve: () => Promise.reject(new Error("should not resolve")),
      target: target("https://api.anthropic.com"),
      override: { mode: "inherit" }
    })
    expect(route).toEqual({ via: "direct", reason: "no_proxy" })
  })

  it("is described without ever showing proxy credentials", () => {
    const route = { via: "proxy", proxy: "socks5://user:secret@vpn:1080", source: "instance" } as const
    expect(describeRoute(route, new URL("https://openrouter.ai"))).toBe("via proxy socks5://vpn:1080")
    expect(describeRoute({ via: "direct", reason: "bypass" }, new URL("http://192.168.1.20:8081"))).toBe(
      "direct: 192.168.1.20 is in the bypass list"
    )
    expect(displayProxy("http://a:b@corp:3128")).toBe("http://corp:3128")
  })

  it("accepts http, https and socks5 proxies only", () => {
    expect(proxyUrlProblem("socks5://vpn:1080")).toBeNull()
    expect(proxyUrlProblem("http://corp:3128")).toBeNull()
    expect(proxyUrlProblem("socks4://vpn:1080")).toMatch(/socks5/)
    expect(proxyUrlProblem("not a url")).toBe("not a URL")
  })
})
