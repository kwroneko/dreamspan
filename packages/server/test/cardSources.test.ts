// Card sources (spec/CARD-SOURCES.md, phase 1): the registry, the network consent rule (nothing
// reaches a source until the user asks for something from it, §5.1), the guards that keep the
// proxy from being an open one (§6.2), the self rate limit and coalescing (§5.5), the cache's
// lifetimes, pinning, cap and per-user namespace (§4.1), against the fake archive's synthetic
// cards. No real archive is contacted.
import { afterAll, assert, describe, it, layer } from "@effect/vitest"
import { emptySourceQuery, SourceFailed } from "@rp/shared/cardSources.ts"
import { Effect, Exit, Fiber, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CardSourceAdapter } from "../src/sources/adapter.ts"
import { makeSourceCache } from "../src/sources/cache.ts"
import * as CardSources from "../src/sources/CardSources.ts"
import { isPrivateAddress, makeSourceHttp } from "../src/sources/guard.ts"
import { makeCoalescer, makeLimiter } from "../src/sources/limiter.ts"
import { client, outcome, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { fakeArchiveAdapter, startFakeArchive } from "./support/fakeArchive.ts"

const archive = await startFakeArchive({ cards: 120 })
afterAll(() => archive.close())

const alice = { "Remote-User": "src-alice" }
const bob = { "Remote-User": "src-bob" }
const config = testConfig({ authMode: "proxy" })
const sources = CardSources.layerWith({ adapters: [fakeArchiveAdapter({ origin: archive.origin })] })
const testServer = serverLayer(config, undefined, undefined, sources)
const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)

layer(testServer, { timeout: 60_000 })("through the server", (it) => {
  it.effect("nothing reaches the source until the user asks it for something (§5.1)", () =>
    Effect.gen(function* () {
      archive.reset()
      const api = yield* client(alice)
      // Visiting home, opening the sidebar, settings: lists, switches and the recent row are local.
      yield* api.Whoami()
      yield* api.ListCardUsage()
      yield* api.ListLibrary({ kind: "card" })
      const listed = yield* api.ListCardSources()
      assert.deepStrictEqual(
        listed.sources.map((s) => [s.id, s.name, s.enabled]),
        [["cardex", "cardex", true]]
      )
      yield* api.ListRecentRemote({ sourceId: "cardex" })
      yield* api.SetCardSourceRating({ sourceId: "cardex", rating: "all" })
      assert.strictEqual(archive.hits(), 0)
      // Turned off, a search is refused here and sends nothing.
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      const off = yield* outcome(api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null }))
      assert.strictEqual(off, "SourceFailed:disabled")
      assert.strictEqual(archive.hits(), 0)
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
      // Opening the option: the first requests.
      const caps = yield* api.SourceCapabilities({ sourceId: "cardex" })
      assert.isTrue(caps.filters.some((f) => f.id === "nsfw"))
      const page = yield* api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null })
      assert.lengthOf(page.items, 50)
      assert.isAbove(archive.hits(), 0)
      // The same page again comes from the cache.
      const before = archive.hits()
      yield* api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null })
      assert.strictEqual(archive.hits(), before)
    })
  )

  it.effect("results carry image keys, not URLs, and a key works only for whom it was issued", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const page = yield* api.SourceSearch({
        sourceId: "cardex",
        query: { ...emptySourceQuery, text: "Amber" },
        page: null
      })
      const item = page.items[0]!
      assert.isDefined(item.thumb)
      assert.notInclude(item.thumb!, "http")
      // Only the card's own page on the source is a link; no picture is.
      assert.notInclude(JSON.stringify(page.items.map(({ url: _url, ...rest }) => rest)), archive.origin)
      const url = yield* base
      const own = yield* Effect.promise(() =>
        fetch(`${url}/sources/cardex/image?k=${item.thumb}&w=96`, { headers: alice })
      )
      assert.strictEqual(own.status, 200, own.status === 200 ? "" : yield* Effect.promise(() => own.text()))
      assert.strictEqual(own.headers.get("content-type"), "image/webp")
      assert.strictEqual(own.headers.get("cache-control"), "private, max-age=86400")
      const theirs = yield* Effect.promise(() =>
        fetch(`${url}/sources/cardex/image?k=${item.thumb}&w=96`, { headers: bob })
      )
      assert.strictEqual(theirs.status, 404)
      // A key made up by the client names no URL the server will fetch.
      const forged = Buffer.from(`${archive.origin}/i/x.png`).toString("base64url")
      const made = yield* Effect.promise(() => fetch(`${url}/sources/cardex/image?k=${forged}.abc`, { headers: alice }))
      assert.strictEqual(made.status, 404)
      const anonymous = yield* Effect.promise(() => fetch(`${url}/sources/cardex/image?k=${item.thumb}`))
      assert.strictEqual(anonymous.status, 401)
    })
  )

  it.effect("pages follow cardex v1: a cursor in fts mode, page numbers in semantic mode", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const all = { ...emptySourceQuery, filters: { nsfw: "all" } }
      for (const query of [all, { ...all, filters: { ...all.filters, mode: "semantic" } }]) {
        const seen = new Set<string>()
        let page: string | null = null
        let total = 0
        do {
          const result: { items: ReadonlyArray<{ remoteId: string }>; next: string | null; total?: number } =
            yield* api.SourceSearch({ sourceId: "cardex", query, page })
          for (const item of result.items) seen.add(item.remoteId)
          total = result.total ?? 0
          page = result.next
        } while (page !== null)
        assert.strictEqual(total, archive.cards.length)
        assert.strictEqual(seen.size, archive.cards.length)
      }
      const paths = archive.paths().filter((p) => p.startsWith("/api/v1/search"))
      assert.isTrue(paths.some((p) => p.includes("mode=semantic") && p.includes("page=2") && !p.includes("cursor")))
      assert.isTrue(paths.some((p) => p.includes("cursor=") && !p.includes("page=")))
    })
  )
  it.effect("each user's switches, recent list and cache are their own", () =>
    Effect.gen(function* () {
      const a = yield* client(alice)
      const b = yield* client(bob)
      const remoteId = archive.cards[3]!.slug
      const opened = yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.isNotNull(opened.docJson)
      assert.strictEqual((JSON.parse(opened.docJson!) as { name: string }).name, archive.cards[3]!.name)
      assert.deepStrictEqual(
        (yield* a.ListRecentRemote({ sourceId: "cardex" })).map((r) => r.remoteId),
        [remoteId]
      )
      assert.lengthOf(yield* b.ListRecentRemote({ sourceId: "cardex" }), 0)
      yield* b.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      assert.isTrue((yield* a.ListCardSources()).sources[0]!.enabled)
      yield* b.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
      // Opened again, the card comes from the cache: no new request.
      const before = archive.hits()
      yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.strictEqual(archive.hits(), before)
      // Clearing the cache empties the recent list and makes the next open ask again.
      yield* a.ClearSourceCache({ sourceId: "cardex" })
      assert.lengthOf(yield* a.ListRecentRemote({ sourceId: "cardex" }), 0)
      yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.isAbove(archive.hits(), before)
    })
  )

  it.effect("the key is write-only, and only admins see or set the cap", () =>
    Effect.gen(function* () {
      const b = yield* client(bob)
      const list = yield* b.SetCardSourceKey({ sourceId: "cardex", key: "sk-cardex-test" })
      assert.isTrue(list.sources[0]!.hasKey)
      assert.notInclude(JSON.stringify(list), "sk-cardex-test")
      assert.isFalse((yield* (yield* client(alice)).ListCardSources()).sources[0]!.hasKey)
      assert.isFalse((yield* b.SetCardSourceKey({ sourceId: "cardex", key: null })).sources[0]!.hasKey)
      assert.isUndefined(list.cache)
      assert.strictEqual(yield* outcome(b.SetSourceCacheCap({ bytes: 64 * 1024 * 1024 })), "Forbidden")
      assert.strictEqual(yield* outcome(b.SourceCard({ sourceId: "nowhere", remoteId: "x" })), "NotFound")
    })
  )

  it.effect("archive errors are worded by kind", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      archive.failNext(404)
      assert.strictEqual(
        yield* outcome(api.SourceCard({ sourceId: "cardex", remoteId: "gone-card" })),
        "SourceFailed:not_found"
      )
      archive.failNext(500)
      const query = { ...emptySourceQuery, text: "server-error" }
      assert.strictEqual(
        yield* outcome(api.SourceSearch({ sourceId: "cardex", query, page: null })),
        "SourceFailed:unreachable"
      )
    })
  )
})

describe("the fake archive keeps cardex v1's rules", () => {
  const get = (path: string) => fetch(`${archive.origin}${path}`, { redirect: "manual" })

  it.effect("limit 1–100, a cursor only for its own query, 308 for an unsorted batch, WebP thumbnails", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.promise(() => get("/api/v1/search?limit=0"))).status, 400)
      assert.strictEqual((yield* Effect.promise(() => get("/api/v1/search?limit=101"))).status, 400)
      assert.strictEqual((yield* Effect.promise(() => get("/api/v1/search?mode=fts&page=2"))).status, 400)
      const first = (yield* Effect.promise(() => get("/api/v1/search?limit=10").then((r) => r.json()))) as {
        next_cursor: string
      }
      const other = yield* Effect.promise(() => get(`/api/v1/search?limit=10&q=amber&cursor=${first.next_cursor}`))
      assert.strictEqual(other.status, 400)
      const [a, b] = [archive.cards[5]!.slug, archive.cards[2]!.slug].sort()
      const redirected = yield* Effect.promise(() => get(`/api/v1/cards/batch?ids=${b},${a},${b}`))
      assert.strictEqual(redirected.status, 308)
      assert.strictEqual(redirected.headers.get("location"), `/api/v1/cards/batch?ids=${a},${b}`)
      const thumb = yield* Effect.promise(() => get(`/t/${archive.cards[0]!.sha256}.512.webp`))
      assert.strictEqual(thumb.headers.get("content-type"), "image/webp")
      const bytes = new Uint8Array(yield* Effect.promise(() => thumb.arrayBuffer()))
      assert.strictEqual(Buffer.from(bytes.subarray(8, 12)).toString("latin1"), "WEBP")
    })
  )

  it.effect("the adapter asks for versions in the canonical order, so nothing is redirected", () =>
    Effect.gen(function* () {
      archive.reset()
      const http = {
        apiKey: null,
        get: (url: URL) =>
          Effect.promise(async () => {
            const response = await fetch(url, { redirect: "manual" })
            const bytes = new Uint8Array(await response.arrayBuffer())
            return {
              status: response.status,
              headers: response.headers,
              bytes,
              json: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
            }
          })
      }
      const adapter = fakeArchiveAdapter({ origin: archive.origin })
      const ids = [archive.cards[9]!.slug, archive.cards[1]!.slug, archive.cards[9]!.slug, "no-such-card"]
      const versions = yield* adapter.versions!(http as never, ids)
      assert.deepStrictEqual(
        versions.map((v) => v.remoteId).sort(),
        [archive.cards[1]!.slug, archive.cards[9]!.slug].sort()
      )
      assert.strictEqual(
        versions.find((v) => v.remoteId === archive.cards[1]!.slug)!.version.id,
        archive.cards[1]!.sha256
      )
      assert.lengthOf(archive.paths(), 1)
    })
  )
})

describe("the registry", () => {
  it.effect("a plugin adds, replaces or disables a source for the length of its scope", () =>
    Effect.gen(function* () {
      const service = yield* CardSources.CardSources
      const replacement: CardSourceAdapter = {
        ...fakeArchiveAdapter({ origin: archive.origin }),
        name: "cardex (plugin)"
      }
      const user = { id: "u", handle: "u", displayName: "u", role: "user" } as never
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.registry.register(replacement)
          yield* service.registry.register(fakeArchiveAdapter({ id: "second", name: "second", origin: archive.origin }))
          const listed = yield* service.list(user)
          assert.deepStrictEqual(
            listed.sources.map((s) => s.name),
            ["cardex (plugin)", "second"]
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* service.registry.disable("cardex")
              assert.deepStrictEqual(
                (yield* service.list(user)).sources.map((s) => s.id),
                ["second"]
              )
            })
          )
        })
      )
      assert.deepStrictEqual(
        (yield* service.list(user)).sources.map((s) => s.name),
        ["cardex"]
      )
    }).pipe(Effect.provide(Layer.fresh(serverLayer(testConfig(), undefined, undefined, sources))))
  )
})

describe("the guards (§6.2)", () => {
  const network = (seen: Array<string>) => ({
    fetchFor: () =>
      (async (input: string) => {
        seen.push(input)
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      }) as unknown as typeof fetch
  })
  const remote: CardSourceAdapter = {
    ...fakeArchiveAdapter({ origin: "https://archive.example" }),
    local: false
  }

  it("private and loopback addresses are recognized, IPv4-mapped too", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.7.40",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1"
    ])
      assert.isTrue(isPrivateAddress(ip), ip)
    for (const ip of ["93.184.216.34", "2606:4700::1111"]) assert.isFalse(isPrivateAddress(ip), ip)
  })

  it.effect("only the adapter's own hosts, and never a private address unless the admin named the host", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      let resolved = ["10.0.0.5"]
      let listed: ReadonlyArray<string> = []
      const http = makeSourceHttp(remote, null, {
        network: network(seen),
        limiter: makeLimiter(),
        bypassEntries: () => listed,
        resolve: async () => resolved
      })
      const elsewhere = yield* Effect.exit(http.get(new URL("https://evil.example/x"), "json"))
      assert.isTrue(Exit.isFailure(elsewhere))
      const plain = yield* Effect.exit(http.get(new URL("http://archive.example/x"), "json"))
      assert.isTrue(Exit.isFailure(plain))
      const rebound = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(rebound.reason, "unreachable")
      assert.lengthOf(seen, 0)
      listed = ["archive.example"]
      yield* http.get(new URL("https://archive.example/api"), "json")
      listed = []
      resolved = ["93.184.216.34"]
      yield* http.get(new URL("https://archive.example/api"), "json")
      assert.lengthOf(seen, 2)
    })
  )

  it.effect("responses past their cap are refused", () =>
    Effect.gen(function* () {
      const big = {
        fetchFor: () =>
          (async () => new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 })) as unknown as typeof fetch
      }
      const http = makeSourceHttp(remote, null, {
        network: big,
        limiter: makeLimiter(),
        bypassEntries: () => [],
        resolve: async () => ["93.184.216.34"]
      })
      const json = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(json.reason, "bad_response")
      const image = yield* http.get(new URL("https://archive.example/i/x.png"), "image")
      assert.strictEqual(image.bytes.byteLength, 3 * 1024 * 1024)
    })
  )

  it.effect("a 429 honours Retry-After: requests fail at once until it passes", () =>
    Effect.gen(function* () {
      let now = 1_000_000
      const limiter = makeLimiter(() => now)
      let calls = 0
      const limited = {
        fetchFor: () =>
          (async () => {
            calls++
            return new Response(null, { status: 429, headers: { "retry-after": "20" } })
          }) as unknown as typeof fetch
      }
      const http = makeSourceHttp(remote, null, {
        network: limited,
        limiter,
        bypassEntries: () => [],
        resolve: async () => ["93.184.216.34"]
      })
      const first = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(first.reason, "rate_limited")
      assert.strictEqual(first.retryAfterMs, 20_000)
      const second = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(second.retryAfterMs, 20_000)
      assert.strictEqual(calls, 1)
      now += 21_000
      yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(calls, 2)
    })
  )
})

describe("the rate limit and coalescing (§5.5)", () => {
  it.live("a burst, then requests wait for tokens; a long wait fails as rate limited", () =>
    Effect.gen(function* () {
      let now = 0
      const limiter = makeLimiter(() => now)
      const rate = { perSecond: 2, burst: 8 }
      for (let n = 0; n < 8; n++) yield* limiter.take("s", rate)
      // The next ten each reserve a token and wait for it, half a second apart, up to 5 s.
      const waiting = []
      for (let n = 0; n < 10; n++)
        waiting.push(yield* Effect.forkChild(limiter.take("s", rate), { startImmediately: true }))
      // The eleventh would wait past five seconds: refused at once, saying when to try again.
      const refused = yield* Effect.flip(limiter.take("s", rate))
      assert.strictEqual(refused.reason, "rate_limited")
      assert.isAtLeast(refused.retryAfterMs!, 5000)
      for (const fiber of waiting) yield* Fiber.interrupt(fiber)
      // Time passes and the bucket fills again.
      now += 10_000
      yield* limiter.take("s", rate)
    })
  )

  it.effect("backoff doubles on 429s in a row, to five minutes, and starts over after a success", () =>
    Effect.sync(() => {
      const limiter = makeLimiter(() => 0)
      const delays = Array.from({ length: 12 }, () => limiter.limited("s", undefined))
      assert.deepStrictEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000])
      assert.strictEqual(delays.at(-1), 5 * 60_000)
      limiter.passed("s")
      assert.strictEqual(limiter.limited("s", undefined), 1000)
      assert.strictEqual(limiter.limited("s", 30_000), 30_000)
    })
  )

  it.live("identical concurrent requests share one run; the last to leave cancels it", () =>
    Effect.gen(function* () {
      const coalescer = makeCoalescer()
      let runs = 0
      let interrupted = false
      const slow = Effect.sync(() => runs++).pipe(
        Effect.andThen(Effect.sleep("50 millis")),
        Effect.as("page"),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))
      )
      const [a, b] = yield* Effect.all([coalescer.run("k", slow), coalescer.run("k", slow)], { concurrency: 2 })
      assert.deepStrictEqual([a, b, runs], ["page", "page", 1])
      const one = yield* Effect.forkChild(
        coalescer.run(
          "j",
          Effect.andThen(
            Effect.sync(() => runs++),
            Effect.never
          )
        )
      )
      const two = yield* Effect.forkChild(coalescer.run("j", Effect.never))
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(one)
      assert.isFalse(interrupted)
      assert.strictEqual(coalescer.size(), 1)
      yield* Fiber.interrupt(two)
      yield* Effect.sleep("10 millis")
      assert.strictEqual(coalescer.size(), 0)
      const cancelled = yield* Effect.forkChild(coalescer.run("i", slow))
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(cancelled)
      yield* Effect.sleep("10 millis")
      assert.isTrue(interrupted)
    })
  )
})

describe("the cache (§4.1)", () => {
  const made: Array<string> = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const fresh = (now: () => number, capBytes = () => 1024 ** 3) => {
    const dataDir = mkdtempSync(join(tmpdir(), "rp-source-cache-"))
    made.push(dataDir)
    return { dataDir, cache: makeSourceCache({ dataDir, now, capBytes }) }
  }
  const key = (user: string, kind: "page" | "card" | "image", id: string) => ({ user, source: "cardex", kind, id })

  it.effect("pages last 10 minutes from when fetched; cards 7 days from when last opened", () =>
    Effect.gen(function* () {
      let now = 0
      const { cache } = fresh(() => now)
      yield* cache.scan
      yield* cache.put(key("a", "page", "q"), { value: { items: [] } })
      yield* cache.put(key("a", "card", "c"), { bytes: new Uint8Array([1, 2, 3]) })
      now += 9 * MINUTE
      assert.isNotNull(yield* cache.get(key("a", "page", "q")))
      now += 2 * MINUTE
      assert.isNull(yield* cache.get(key("a", "page", "q")))
      now += 6 * DAY
      assert.isNotNull(yield* cache.get(key("a", "card", "c")))
      now += 6 * DAY
      // Opened a day ago, six days after it was fetched: still kept.
      assert.isNotNull(yield* cache.get(key("a", "card", "c")))
      now += 8 * DAY
      yield* cache.sweep
      assert.isFalse(cache.has(key("a", "card", "c")))
      assert.strictEqual(cache.usedBytes(), 0)
    })
  )

  it.effect("a pinned entry outlives its age; past the cap, unpinned entries go first, least recent first", () =>
    Effect.gen(function* () {
      let now = 0
      const { cache } = fresh(
        () => now,
        () => 2_000
      )
      yield* cache.scan
      const bytes = (fill: number) => new Uint8Array(600).fill(fill)
      yield* cache.put(key("a", "card", "pinned"), { bytes: bytes(1) })
      const release = cache.pin(key("a", "card", "pinned"))
      now += 1
      yield* cache.put(key("a", "card", "old"), { bytes: bytes(2) })
      now += 1
      yield* cache.put(key("a", "card", "new"), { bytes: bytes(3) })
      now += 1
      // A fourth past the cap: the oldest unpinned goes, not the pinned one opened before it.
      yield* cache.put(key("a", "card", "newest"), { bytes: bytes(4) })
      assert.isTrue(cache.has(key("a", "card", "pinned")))
      assert.isFalse(cache.has(key("a", "card", "old")))
      assert.isTrue(cache.has(key("a", "card", "newest")))
      now += 30 * DAY
      yield* cache.sweep
      assert.isTrue(cache.has(key("a", "card", "pinned")))
      assert.isFalse(cache.has(key("a", "card", "new")))
      yield* release
      yield* cache.sweep
      assert.isFalse(cache.has(key("a", "card", "pinned")))
    })
  )

  it.effect("identical bytes are stored once; a user's clearing leaves another's entries", () =>
    Effect.gen(function* () {
      const { cache, dataDir } = fresh(() => 0)
      yield* cache.scan
      const same = new Uint8Array(1000).fill(7)
      yield* cache.put(key("a", "image", "x"), { bytes: same })
      yield* cache.put(key("b", "image", "x"), { bytes: same })
      assert.isBelow(cache.usedBytes(), 1700)
      yield* cache.clearUser("a", null)
      assert.isFalse(cache.has(key("a", "image", "x")))
      const entry = yield* cache.get(key("b", "image", "x"))
      assert.deepStrictEqual([...(yield* cache.readBlob(entry!.blob!)).subarray(0, 3)], [7, 7, 7])
      // A restart rebuilds the index from the files.
      const again = makeSourceCache({ dataDir, now: () => 0 })
      yield* again.scan
      assert.isTrue(again.has(key("b", "image", "x")))
      assert.isFalse(again.has(key("a", "image", "x")))
    })
  )
})

// A failure the UI words by kind keeps its tag through the RPC.
it("SourceFailed carries its reason", () => {
  assert.strictEqual(new SourceFailed({ sourceId: "s", reason: "disabled", message: "off" }).reason, "disabled")
})
