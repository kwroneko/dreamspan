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

it("uses absolute DNS questions and accepts IPv6-only, dual and CNAME answers without hosts-file lookup", async () => {
  const dns = createSocket("udp4")
  const questions: string[] = []
  const encodeName = (name: string) =>
    Buffer.concat([
      ...name.split(".").map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
      Buffer.from([0])
    ])
  dns.on("message", (query, peer) => {
    let at = 12
    const parts: string[] = []
    while (query[at]) {
      const length = query[at++]!
      parts.push(query.subarray(at, at + length).toString())
      at += length
    }
    const name = parts.join(".")
    questions.push(name)
    const type = query.readUInt16BE(at + 1)
    const question = query.subarray(12, at + 5)
    const alias = encodeName("alias.media.invalid")
    const record = (kind: number, data: Buffer) => {
      const head = Buffer.alloc(12)
      head.writeUInt16BE(0xc00c, 0)
      head.writeUInt16BE(kind, 2)
      head.writeUInt16BE(1, 4)
      head.writeUInt32BE(30, 6)
      head.writeUInt16BE(data.length, 10)
      return Buffer.concat([head, data])
    }
    const records: Buffer[] = []
    if (name === "cname.media.invalid") records.push(record(5, alias))
    if (type === 1 && name !== "v6.media.invalid") records.push(record(1, Buffer.from([93, 184, 216, 34])))
    if (type === 28) records.push(record(28, Buffer.from("26064700470000000000000000001111", "hex")))
    const header = Buffer.alloc(12)
    query.copy(header, 0, 0, 2)
    header.writeUInt16BE(0x8180, 2)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(records.length, 6)
    dns.send(Buffer.concat([header, question, ...records]), peer.port, peer.address)
  })
  await new Promise<void>((done) => dns.bind(0, "127.0.0.1", done))
  try {
    const seen: ReadonlyArray<string>[] = []
    const transport: Pick<NetworkShape, "fetchFor"> = {
      fetchFor: (_override, _route, check) =>
        (async (input: string | URL) => {
          seen.push((await check?.(new URL(input))) ?? [])
          return new Response(null, { status: 404 })
        }) as typeof fetch
    }
    const get = makeExternalFetcher(transport, { dnsServers: [`127.0.0.1:${dns.address().port}`] })
    // localhost would normally come from /etc/hosts; the explicit resolver must answer it.
    for (const host of ["localhost", "v6.media.invalid", "dual.media.invalid", "cname.media.invalid"])
      await get(`https://${host}/a`, new AbortController().signal).catch(() => {})
    expect(seen[0]).toEqual(["93.184.216.34", "2606:4700:4700::1111"])
    expect(seen[1]).toEqual(["2606:4700:4700::1111"])
    expect(seen[2]).toEqual(seen[0])
    expect(seen[3]).toEqual(seen[0])
    expect(questions).toHaveLength(8)
    expect(
      questions.every((name) =>
        ["localhost", "v6.media.invalid", "dual.media.invalid", "cname.media.invalid"].includes(name)
      )
    ).toBe(true)
    expect(lookups.count).toBe(0)
  } finally {
    await new Promise<void>((done) => dns.close(() => done()))
  }
})

it("cancels the resolver at the deadline and never starts one for an already aborted request", async () => {
  const { Resolver } = await import("node:dns/promises")
  const cancelled = vi.spyOn(Resolver.prototype, "cancel")
  try {
    const get = makeExternalFetcher(network, { dnsServers: [server], timeoutMs: 30 })
    await expect(get("https://deadline.media.invalid/a", new AbortController().signal)).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    const before = queries
    await expect(get("https://cancelled.media.invalid/a", controller.signal)).rejects.toThrow()
    expect(queries).toBe(before)
  } finally {
    cancelled.mockRestore()
  }
})
