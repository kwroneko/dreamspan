// Untrusted media hostnames and the shared libuv pool (net/externalMedia.ts). getaddrinfo
// (dns.lookup) runs on libuv's pool of four threads, which file reads, zlib and scrypt logins
// share, and it can't be cancelled: a few names whose DNS never answers would hold it for the
// resolver's whole timeout while the media deadline has long passed. Synthetic, local only.
import { createSocket } from "node:dgram"
import { pbkdf2 } from "node:crypto"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { NetworkShape } from "../src/net/Network.ts"

const lookups = vi.hoisted(() => ({ count: 0 }))
vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>()
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) => {
      lookups.count++
      return actual.lookup(...args)
    }
  }
})
const { makeExternalFetcher } = await import("../src/net/externalMedia.ts")

// A DNS server that receives every query and never answers.
const silent = createSocket("udp4")
let server = ""
let queries = 0
beforeAll(async () => {
  silent.on("message", () => queries++)
  await new Promise<void>((done) => silent.bind(0, "127.0.0.1", done))
  server = `127.0.0.1:${silent.address().port}`
})
afterAll(() => new Promise<void>((done) => silent.close(() => done())))

const network: Pick<NetworkShape, "fetchFor"> = {
  fetchFor: (_override, _route, check) =>
    (async (input: string | URL) => {
      await check?.(new URL(input))
      return new Response(null, { status: 404 })
    }) as typeof fetch
}

it("resolves media hostnames off libuv's pool and gives up on silent DNS by the deadline", async () => {
  const get = makeExternalFetcher(network, { dnsServers: [server], timeoutMs: 300 })
  const started = Date.now()
  const pending = Array.from({ length: 8 }, (_, i) =>
    get(`https://silent-${i}.media.invalid/a.png`, new AbortController().signal).then(
      () => "loaded",
      () => "refused"
    )
  )
  // The pool stays free for the server's own work while those queries go unanswered.
  const poolWork = Date.now()
  await new Promise((done) => pbkdf2("synthetic", "salt", 1, 32, "sha256", done))
  expect(Date.now() - poolWork).toBeLessThan(250)
  expect(await Promise.all(pending)).toEqual(Array(8).fill("refused"))
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(queries).toBeGreaterThan(0)
  expect(lookups.count).toBe(0)
})

it("never uses getaddrinfo for an untrusted media hostname by default", async () => {
  const get = makeExternalFetcher(network, { timeoutMs: 2_000 })
  await get("https://unresolvable.media.invalid/a.png", new AbortController().signal).catch(() => {})
  expect(lookups.count).toBe(0)
})
