// The cardex adapter (spec/CARD-SOURCES.md §11 phase 4): how cardex's API v1 maps to card
// sources, checked as pure mappings and against the fake archive, which serves v1's shapes.
// No request ever goes to cardex.zip: the adapter is pointed at the fake's origin, and the
// pure checks make none.
import { afterAll, assert, describe, it } from "@effect/vitest"
import { emptySourceQuery, SourceFailed, type SourceSuggestions } from "@rp/shared/cardSources.ts"
import { Effect } from "effect"
import type { SourceHttp } from "../src/sources/adapter.ts"
import {
  batchUrl,
  capabilitiesOf,
  CARDEX_ORIGIN,
  cardexAdapter,
  cardSourceSetup,
  cursorRefused,
  downloadModeOf,
  detailMetadata,
  searchParams,
  summaryOf
} from "../src/sources/cardex.ts"
import { fakeCardexAdapter, startFakeArchive } from "./support/fakeArchive.ts"

const archive = await startFakeArchive({ cards: 120 })
afterAll(() => archive.close())

/** A refusal's `{"error": "<code>"}`, as the guard reads it. */
const errorCode = (bytes: Uint8Array) => {
  try {
    const { error } = JSON.parse(Buffer.from(bytes).toString("utf8")) as { error?: unknown }
    return typeof error === "string" ? error : undefined
  } catch {
    return undefined
  }
}

/** Requests straight to the fake, failing on a status as the guard does (guard.ts). */
const direct = (seen: Array<string> = []): SourceHttp => ({
  apiKey: null,
  get: (url) =>
    Effect.gen(function* () {
      seen.push(`${url.pathname}${url.search}`)
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }))
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const reason =
        response.status === 404
          ? "not_found"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "unreachable"
              : response.status < 200 || response.status > 299
                ? "bad_response"
                : null
      const code = reason === "bad_response" ? errorCode(bytes) : undefined
      if (reason)
        return yield* new SourceFailed({
          sourceId: "cardex",
          reason,
          message: String(response.status),
          ...(typeof code === "string" ? { code } : {})
        })
      return {
        status: response.status,
        headers: response.headers,
        bytes,
        json: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
      }
    })
})

describe("which card sources main.ts registers", () => {
  it("only an unset FAKE_CARD_SOURCE reaches cardex; any value keeps the fake (or none) in its place", () => {
    assert.strictEqual(cardSourceSetup(undefined), "cardex")
    assert.strictEqual(cardSourceSetup("off"), "none")
    for (const value of ["0", "18900", "", "on", "false"]) assert.strictEqual(cardSourceSetup(value), "fake", value)
  })

  it("the real adapter is on cardex.zip over https; pointed at the fake, only the fake's host", () => {
    const real = cardexAdapter()
    assert.deepStrictEqual(real.hosts, ["cardex.zip"])
    assert.strictEqual(real.scheme, "https")
    assert.isUndefined(real.local)
    assert.strictEqual(real.key, "none")
    assert.deepStrictEqual(real.rate, { perSecond: 10, burst: 60 })
    const fake = fakeCardexAdapter(archive)
    assert.deepStrictEqual(fake.hosts, [archive.host])
    assert.strictEqual(fake.scheme, "http")
    assert.isTrue(fake.local)
  })
})

describe("v1 as card sources", () => {
  it.effect("capabilities: the filters a character browser offers, labelled, with v1's defaults", () =>
    Effect.gen(function* () {
      const caps = yield* fakeCardexAdapter(archive).capabilities(direct())
      assert.deepStrictEqual(
        caps.filters.map((f) => [f.id, f.label]),
        [
          ["nsfw", "Rating"],
          ["mode", "Match"],
          ["tokens", "Tokens"],
          ["exclude_forks", "Leave out forks"],
          ["source", "Site"],
          ["author", "Creator"],
          ["fields", "Search in"],
          ["kind", "Kind"],
          ["not_source", "Exclude sites"],
          ["any_tags", "Any of these tags"],
          ["has_cover", "Cover"],
          ["any_author", "Any of these creators"],
          ["not_author", "Exclude creators"],
          ["picture", "Picture"],
          ["added_after", "Added after"],
          ["added_before", "Added before"],
          ["created_after", "Created after"],
          ["created_before", "Created before"],
          ["deleted_from_source", "Deleted from all sites"],
          ["deleted_from_any_source", "Deleted from a site"],
          ["chub_verified", "Chub verified"],
          ["chub_recommended", "Chub recommended"]
        ]
      )
      const rating = caps.filters.find((f) => f.id === "nsfw")!
      assert.deepStrictEqual(rating.kind === "choice" ? rating.options.map((o) => o.label) : [], [
        "Safe",
        "Everything",
        "Mature only"
      ])
      assert.deepStrictEqual(caps.ratings, { filterId: "nsfw", default: "include" })
      assert.deepStrictEqual(
        caps.sorts.map((s) => [s.id, s.reversible]),
        [
          ["popular", false],
          ["newest", true],
          ["created", true],
          ["name", true],
          ["tokens", true],
          ["relevance", false]
        ]
      )
      const sites = caps.filters.find((f) => f.id === "source")!
      assert.isTrue(sites.kind === "choice" && sites.multi && sites.options.some((o) => o.label === "Chub"))
    })
  )

  it("a filter or sort v1 no longer lists is left out, and a body without filters is refused", () => {
    const caps = capabilitiesOf({
      filters: [{ name: "nsfw", type: "enum", allowed_values: ["include", "exclude"], default: "exclude" }],
      sorts: ["newest", "popular"],
      modes: [{ name: "fts" }]
    })
    assert.deepStrictEqual(
      caps.filters.map((f) => f.id),
      ["nsfw"]
    )
    assert.deepStrictEqual(
      caps.sorts.map((s) => s.id),
      ["popular"]
    )
    assert.deepStrictEqual(caps.tags, { include: false, exclude: false, suggest: true })
    assert.throws(() => capabilitiesOf({ sorts: [] }))
  })

  it("search parameters: only what was chosen, v1's names, the sort by direction", () => {
    const query = {
      ...emptySourceQuery,
      text: "  lantern ",
      tags: ["magic", "magic", ...Array.from({ length: 25 }, (_, n) => `t${n}`)],
      filters: { nsfw: "exclude", source: ["risuai", "chub", "chub"], tokens: { min: 100.4 }, exclude_forks: true },
      sort: "newest",
      reverse: true
    }
    const params = searchParams(query, "c:abc")
    assert.strictEqual(params.get("q"), "lantern")
    assert.lengthOf(params.get("tags")!.split(","), 20)
    assert.strictEqual(params.get("kind"), "character")
    assert.strictEqual(params.get("source"), "chub,risuai")
    assert.strictEqual(params.get("min_tokens"), "100")
    assert.isFalse(params.has("max_tokens"))
    assert.strictEqual(params.get("exclude_forks"), "true")
    assert.strictEqual(params.get("sort"), "oldest")
    assert.strictEqual(params.get("limit"), "48")
    assert.strictEqual(params.get("cursor"), "abc")
    assert.isFalse(params.has("page"))
    // Semantic mode takes no sort and no cursor, only a page number.
    const semantic = searchParams({ ...query, filters: { mode: "semantic" } }, "p:3")
    assert.isFalse(semantic.has("sort"))
    assert.isFalse(semantic.has("cursor"))
    assert.strictEqual(semantic.get("page"), "3")
    assert.isFalse(searchParams({ ...query, filters: { mode: "semantic" } }, "c:abc").has("cursor"))
    // Best match without words is popularity; tokens by direction.
    assert.strictEqual(searchParams({ ...emptySourceQuery, sort: "relevance" }, null).get("sort"), "popular")
    assert.strictEqual(
      searchParams({ ...emptySourceQuery, text: "x", sort: "relevance" }, null).get("sort"),
      "relevance"
    )
    assert.strictEqual(searchParams({ ...emptySourceQuery, sort: "tokens" }, null).get("sort"), "tokens_desc")
    assert.isFalse(searchParams(emptySourceQuery, null).has("sort"))
    assert.isFalse(searchParams(emptySourceQuery, null).has("nsfw"))
  })

  it.effect("every live card criterion is available and reaches the fake with v1 names and encodings", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      const caps = yield* adapter.capabilities(direct())
      assert.include(caps.filters.find((f) => f.id === "tokens")?.about ?? "", "300")
      const fields = caps.filters.find((f) => f.id === "fields")!
      assert.isTrue(fields.kind === "choice" && fields.multi)
      const kind = caps.filters.find((f) => f.id === "kind")!
      assert.deepStrictEqual(kind.kind === "choice" ? kind.options.map((o) => o.value) : [], [
        "character",
        "character_lorebook"
      ])
      const c = archive.cards[0]!
      const identity = `${c.site}/${c.creator}`
      const cases: ReadonlyArray<
        readonly [Record<string, import("@rp/shared/cardSources.ts").SourceFilterValue>, (slug: string) => boolean]
      > = [
        [{ fields: ["name"] }, () => true],
        [{ kind: "character_lorebook" }, (slug) => archive.cards.find((x) => x.slug === slug)!.hasLorebook],
        [{ not_source: [c.site] }, (slug) => archive.cards.find((x) => x.slug === slug)!.site !== c.site],
        [
          { any_tags: `${c.tags[0]}|${c.tags[1]}` },
          (slug) => archive.cards.find((x) => x.slug === slug)!.tags.some((t) => c.tags.slice(0, 2).includes(t))
        ],
        [{ any_author: identity }, (slug) => archive.cards.find((x) => x.slug === slug)!.creator === c.creator],
        [{ not_author: identity }, (slug) => slug !== c.slug],
        [{ picture: c.sha256 }, (slug) => slug === c.slug],
        [
          { added_after: "2026-01-02", added_before: "2026-01-04" },
          (slug) => {
            const at = archive.cards.find((x) => x.slug === slug)!.addedAt
            return at >= Date.parse("2026-01-02") && at < Date.parse("2026-01-04")
          }
        ],
        [
          { created_after: "2025-01-02", created_before: "2025-04-01" },
          (slug) => {
            const at = archive.cards.find((x) => x.slug === slug)!.createdAt
            return at >= Date.parse("2025-01-02") && at < Date.parse("2025-04-01")
          }
        ],
        [{ deleted_from_source: true }, (slug) => archive.cards.find((x) => x.slug === slug)!.deleted],
        [{ deleted_from_any_source: true }, (slug) => archive.cards.find((x) => x.slug === slug)!.deleted],
        [{ source: ["chub"], chub_verified: true }, (slug) => archive.cards.find((x) => x.slug === slug)!.verified],
        [
          { source: ["chub"], chub_recommended: true },
          (slug) => archive.cards.find((x) => x.slug === slug)!.recommended
        ],
        [{ has_cover: "false" }, () => true]
      ]
      for (const [filters, matches] of cases) {
        const seen: Array<string> = []
        const page = yield* adapter.search(direct(seen), { ...emptySourceQuery, filters }, null)
        assert.isAbove(page.items.length, 0, JSON.stringify(filters))
        assert.isTrue(
          page.items.every((x) => matches(x.remoteId)),
          JSON.stringify(filters)
        )
        const params = new URL(`http://fake${seen[0]}`).searchParams
        for (const id of Object.keys(filters)) assert.isTrue(params.has(id), id)
      }
      for (const sort of caps.sorts)
        for (const reverse of sort.reversible ? [false, true] : [false]) {
          const page = yield* adapter.search(
            direct(),
            { ...emptySourceQuery, text: "lantern", sort: sort.id, reverse },
            null
          )
          assert.isAbove(page.items.length, 0)
        }
      const badFlags = yield* Effect.flip(
        adapter.search(direct(), { ...emptySourceQuery, filters: { chub_verified: true } }, null)
      )
      assert.strictEqual(badFlags.code, "bad_request")
    })
  )

  it.effect("a nullable search total is filled by the exact count endpoint; paging still follows next_cursor", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeArchive({ cards: 120, unknownTotal: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const first = yield* adapter.search(direct(), emptySourceQuery, null)
      assert.strictEqual(first.total, 120)
      assert.isFalse(first.totalCapped)
      assert.isString(first.next)
      const second = yield* adapter.search(direct(), emptySourceQuery, first.next)
      assert.lengthOf(second.items, 48)
      assert.notStrictEqual(first.items[0]!.remoteId, second.items[0]!.remoteId)
    }).pipe(Effect.scoped)
  )

  it.effect("Cover: Any includes characters hidden by the archive's default cover filter", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeArchive({ cards: 60, coverless: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const covered = yield* adapter.search(direct(), emptySourceQuery, null)
      assert.strictEqual(covered.total, 40)
      assert.isTrue(covered.items.every((c) => typeof c.thumb === "string"))
      const all = yield* adapter.search(direct(), { ...emptySourceQuery, filters: { has_cover: "false" } }, null)
      assert.strictEqual(all.total, 60)
      assert.isTrue(all.items.some((c) => c.thumb === undefined && c.image === undefined))
    }).pipe(Effect.scoped)
  )

  it.effect("name search falls back to best matches, explains why, and keeps paging that order", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const query = { ...emptySourceQuery, text: "synthetic", sort: "name" }
      const first = yield* fakeCardexAdapter(archive).search(direct(seen), query, null)
      assert.include(first.notice!, "Showing best matches")
      assert.isAbove(first.items.length, 0)
      const next = yield* fakeCardexAdapter(archive).search(direct(seen), query, first.next)
      assert.isFalse(next.reset === true)
      assert.isFalse(next.items.some((item) => first.items.some((old) => old.remoteId === item.remoteId)))
      assert.isTrue(
        seen
          .filter((path) => path.startsWith("/api/v1/search?"))
          .every((path) => new URL(`http://fake${path}`).searchParams.get("sort") === "relevance")
      )
      const reversed = yield* fakeCardexAdapter(archive).search(direct(), { ...query, reverse: true }, null)
      assert.isUndefined(reversed.notice)
    })
  )

  it.effect("counts share the search filters and distinguish a capped lower bound", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeArchive({ cards: 120, unknownTotal: true, countCap: 50 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const all = yield* adapter.search(direct(), emptySourceQuery, null)
      assert.strictEqual(all.total, 50)
      assert.isTrue(all.totalCapped)
      const filtered = yield* adapter.search(
        direct(),
        { ...emptySourceQuery, text: "Amber", filters: { nsfw: "exclude" } },
        null
      )
      assert.strictEqual(filtered.total, filtered.items.length)
      assert.isFalse(filtered.totalCapped)
      assert.isTrue(
        fake
          .paths()
          .some(
            (path) =>
              path.startsWith("/api/v1/search/count?") && path.includes("q=Amber") && path.includes("nsfw=exclude")
          )
      )
    }).pipe(Effect.scoped)
  )

  it.effect("tag and creator suggestions traverse keyset pages and replace an expired cursor", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      for (const kind of ["tags", "creators"] as const) {
        const seen = new Set<string>()
        let page: string | null = null
        let pages = 0
        do {
          const result: SourceSuggestions = yield* adapter.suggestions!(direct(), kind, "", page)
          assert.isFalse(result.reset === true)
          for (const item of result.items) {
            assert.isFalse(seen.has(item.value))
            seen.add(item.value)
            assert.isNumber(item.count)
          }
          pages++
          page = result.next
        } while (page !== null)
        assert.isAbove(pages, 1)
        assert.strictEqual(
          seen.size,
          kind === "tags"
            ? new Set(archive.cards.flatMap((card) => card.tags)).size
            : new Set(archive.cards.map((card) => `${card.site}/${card.creator}`)).size
        )
        const expired = yield* adapter.suggestions!(direct(), kind, "", "expired")
        const first = yield* adapter.suggestions!(direct(), kind, "", null)
        assert.isTrue(expired.reset)
        assert.deepStrictEqual(expired.items, first.items)
      }
    })
  )

  it.effect("opened cards retain the archive's per-field counts, labelled by its tokenizer", () =>
    Effect.gen(function* () {
      const card = yield* fakeCardexAdapter(archive).card(direct(), archive.cards[0]!.slug)
      assert.strictEqual(card.summary.tokenCounts?.model, "o200k_base")
      assert.deepStrictEqual(card.summary.tokenCounts?.fields, {
        description: 40,
        personality: 9,
        scenario: 12,
        creator_notes: 7,
        mes_example: 0
      })
      assert.deepStrictEqual(card.summary.tokenCounts?.greetings, [18, 15])
      assert.deepStrictEqual(
        detailMetadata({
          card: {
            token_counts: {
              model: "o200k_base",
              fields: { name: -1, description: "text", scenario: 12 },
              greetings: [0, -1, "text"]
            }
          }
        }).tokenCounts?.fields,
        { scenario: 12 }
      )
    })
  )

  it("a batch URL is in v1's canonical form: sorted, without duplicates, joined by %2C", () => {
    assert.strictEqual(batchUrl(["b-2", "a-1", "b-2"]).href, `${CARDEX_ORIGIN}/api/v1/cards/batch?ids=a-1%2Cb-2`)
  })

  it("a summary's paths resolve against the archive; a URL elsewhere is dropped", () => {
    const sha = "a".repeat(64)
    const summary = summaryOf({
      slug: "amber-lantern-1",
      name: "Amber Lantern",
      creator: { name: "Someone", source: "chub", handle: "someone" },
      tags: ["fantasy", 3 as never],
      nsfw: true,
      token_count: 1200,
      thumbnail_url: `/t/${sha}.512.webp?v=1`,
      image_url: `https://elsewhere.example/i/${sha}.png`,
      version: sha,
      updated_at: "2026-01-02T03:04:05Z",
      superseded_by: "amber-lantern-2"
    })!
    assert.strictEqual(summary.thumb, `${CARDEX_ORIGIN}/t/${sha}.512.webp?v=1`)
    assert.isUndefined(summary.image)
    assert.strictEqual(summary.url, `${CARDEX_ORIGIN}/c/amber-lantern-1`)
    assert.strictEqual(summary.creator, "Someone")
    assert.strictEqual(summary.creatorQuery, "chub/someone")
    assert.strictEqual(summary.rating, "Mature")
    assert.deepStrictEqual(summary.tags, ["fantasy"])
    assert.deepStrictEqual(summary.version, {
      id: sha,
      updatedAt: Date.parse("2026-01-02T03:04:05Z"),
      supersededBy: "amber-lantern-2"
    })
    assert.isNull(summaryOf({ slug: "" }))
  })
})

describe("the adapter against the fake archive", () => {
  const adapter = fakeCardexAdapter(archive)

  it.effect("text search pages by cursor to the end; semantic by number, to 240 at most", () =>
    Effect.gen(function* () {
      const http = direct()
      for (const mode of ["fts", "semantic"]) {
        const query = { ...emptySourceQuery, text: mode === "semantic" ? "a quiet scholar" : "", filters: { mode } }
        const seen = new Set<string>()
        let token: string | null = null
        do {
          const page: { items: ReadonlyArray<{ remoteId: string }>; next: string | null } = yield* adapter.search(
            http,
            query,
            token
          )
          for (const item of page.items) seen.add(item.remoteId)
          if (page.next !== null) assert.match(page.next, mode === "fts" ? /^c:/ : /^p:\d+$/)
          token = page.next
        } while (token !== null)
        assert.strictEqual(seen.size, archive.cards.length, mode)
      }
    })
  )

  it.effect("a cursor refused restarts the search from the top", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const page = yield* adapter.search(direct(seen), emptySourceQuery, "c:not-a-cursor")
      assert.lengthOf(page.items, 48)
      assert.isTrue(page.reset)
      assert.lengthOf(seen, 3)
      assert.include(seen[0]!, "cursor=not-a-cursor")
      assert.notInclude(seen[1]!, "cursor=")
      assert.notInclude(seen[1]!, "page=")
    })
  )

  it("only invalid_cursor counts as a refused cursor; other misuse is bad_request", () => {
    const refused = (code?: string) =>
      cursorRefused(
        new SourceFailed({ sourceId: "cardex", reason: "bad_response", message: "400", ...(code ? { code } : {}) })
      )
    assert.isTrue(refused("invalid_cursor"))
    assert.isFalse(refused("bad_request"))
    assert.isFalse(refused())
    assert.isFalse(cursorRefused(new SourceFailed({ sourceId: "cardex", reason: "unreachable", message: "503" })))
  })

  it("a card's download mode comes from its download_modes when they're listed", () => {
    assert.isUndefined(downloadModeOf(undefined))
    assert.isUndefined(downloadModeOf(null))
    assert.strictEqual(downloadModeOf(["self-contained", "mirrored", "json", "original"]), "mirrored")
    assert.strictEqual(downloadModeOf(["json", "original"]), "json")
    assert.isNull(downloadModeOf(["original"]))
    // An empty list: cardex refuses downloads of the card.
    assert.strictEqual(downloadModeOf([]), "refused")
  })

  it.effect("a creator's cards by site/handle; tags from the envelope", () =>
    Effect.gen(function* () {
      const http = direct()
      const first = (yield* adapter.search(http, emptySourceQuery, null)).items[0]!
      const theirs = yield* adapter.search(
        http,
        { ...emptySourceQuery, filters: { author: first.creatorQuery! } },
        null
      )
      assert.isAbove(theirs.items.length, 0)
      assert.isTrue(theirs.items.every((c) => c.creatorQuery === first.creatorQuery))
      const tags = yield* adapter.tags!(http, "s")
      assert.isAtMost(tags.length, 10)
      assert.isTrue(tags.every((t) => t.tag.startsWith("s") && typeof t.count === "number"))
    })
  )

  it.effect("without download_modes (a cached answer), a card is the mirrored PNG, or its JSON when that 404s", () =>
    Effect.gen(function* () {
      const cached = yield* Effect.promise(() => startFakeArchive({ cards: 60, omitDownloadModes: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => cached.close()))
      const old = fakeCardexAdapter(cached)
      const http = direct()
      const plain = cached.cards.find((c) => !c.originalOnly)!
      const file = yield* old.card(http, plain.slug)
      assert.strictEqual(file.fileName, `${plain.slug}.png`)
      assert.deepStrictEqual([...file.bytes.subarray(1, 4)], [0x50, 0x4e, 0x47])
      assert.strictEqual(file.summary.version.id, plain.sha256)
      const seen: Array<string> = []
      const charx = cached.cards.find((c) => c.originalOnly)!
      const json = yield* old.card(direct(seen), charx.slug)
      assert.strictEqual(json.fileName, `${charx.slug}.json`)
      assert.deepStrictEqual(
        seen.map((p) => new URLSearchParams(p.split("?")[1]).get("mode")),
        [null, "mirrored", "json", null]
      )
      const missing = yield* Effect.flip(old.card(http, "no-such-card"))
      assert.strictEqual(missing.reason, "not_found")
    }).pipe(Effect.scoped)
  )

  it.effect("download_modes picks the mode with no 404 first; an empty list is a plain refusal, not tried", () =>
    Effect.gen(function* () {
      const listing = yield* Effect.promise(() => startFakeArchive({ cards: 60 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => listing.close()))
      const listed = fakeCardexAdapter(listing)
      const modes = (seen: ReadonlyArray<string>) =>
        seen
          .filter((p) => p.startsWith("/api/v1/download/"))
          .map((p) => new URLSearchParams(p.split("?")[1]).get("mode"))
      const seen: Array<string> = []
      const plain = listing.cards.find((c) => !c.originalOnly)!
      const png = yield* listed.card(direct(seen), plain.slug)
      assert.strictEqual(png.fileName, `${plain.slug}.png`)
      assert.deepStrictEqual(modes(seen), ["mirrored"])
      seen.length = 0
      const charx = listing.cards.find((c) => c.originalOnly)!
      const json = yield* listed.card(direct(seen), charx.slug)
      assert.strictEqual(json.fileName, `${charx.slug}.json`)
      assert.deepStrictEqual(modes(seen), ["json"])
      seen.length = 0
      const kept = listing.cards.find((c) => !c.originalOnly && c.slug !== plain.slug)!
      listing.refuseDownloads(kept.slug)
      const refused = yield* Effect.flip(listed.card(direct(seen), kept.slug))
      assert.strictEqual(refused.reason, "refused")
      assert.strictEqual(refused.message, "cardex doesn't allow downloading this card.")
      assert.deepStrictEqual(modes(seen), [])
    }).pipe(Effect.scoped)
  )

  it.effect("the recorded shapes: download_modes on summaries and detail files, in cardex's order", () =>
    Effect.gen(function* () {
      const get = (path: string) =>
        Effect.promise(async () => (await (await fetch(`${archive.origin}${path}`)).json()) as Record<string, unknown>)
      const plain = archive.cards.find((c) => !c.originalOnly)!
      const charx = archive.cards.find((c) => c.originalOnly)!
      const batch = (yield* get(`/api/v1/cards/batch?ids=${[plain.slug, charx.slug].sort().join("%2C")}`)) as {
        items: ReadonlyArray<{ slug: string; download_modes: ReadonlyArray<string> }>
      }
      const modes = new Map(batch.items.map((item) => [item.slug, item.download_modes]))
      assert.deepStrictEqual(modes.get(plain.slug), ["mirrored", "self-contained", "json", "original"])
      assert.deepStrictEqual(modes.get(charx.slug), ["json", "original"])
      const search = (yield* get("/api/v1/search?limit=5")) as {
        items: ReadonlyArray<{ download_modes?: ReadonlyArray<string> }>
      }
      assert.isTrue(search.items.every((item) => Array.isArray(item.download_modes)))
      const detail = (yield* get(`/api/v1/cards/${charx.slug}`)) as {
        files: ReadonlyArray<{ download_modes: ReadonlyArray<string> }>
      }
      assert.deepStrictEqual(detail.files[0]!.download_modes, ["json", "original"])
      const misuse = yield* Effect.promise(async () =>
        (await fetch(`${archive.origin}/api/v1/search?limit=500`)).json()
      )
      assert.strictEqual((misuse as { error: string }).error, "bad_request")
    })
  )

  it.effect("pictures only from the archive's own origin", () =>
    Effect.gen(function* () {
      const http = direct()
      const thumb = (yield* adapter.search(http, emptySourceQuery, null)).items[0]!.thumb!
      assert.isAbove((yield* adapter.image!(http, thumb)).length, 0)
      const refused = yield* Effect.flip(adapter.image!(http, "https://elsewhere.example/t/x.webp"))
      assert.strictEqual(refused.reason, "bad_response")
    })
  )

  it.effect("versions go in sorted batches of 100, so none is redirected", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const ids = [...archive.cards.map((c) => c.slug)].reverse()
      const versions = yield* adapter.versions!(direct(seen), [...ids, ids[0]!])
      assert.lengthOf(versions, archive.cards.length)
      assert.lengthOf(seen, 2)
      for (const path of seen) {
        const listed = new URLSearchParams(path.split("?")[1]).get("ids")!.split(",")
        assert.deepStrictEqual(listed, [...listed].sort())
        assert.notInclude(path, ",")
      }
    })
  )
})
