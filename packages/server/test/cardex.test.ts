// The cardex adapter (spec/CARD-SOURCES.md §11 phase 4): how cardex's API v1 maps to card
// sources, checked as pure mappings and against the fake cardex, which serves the shapes
// captured from the live API (test/fixtures/cardex).
// No request ever goes to cardex.zip: the adapter is pointed at the fake's origin, and the
// pure checks make none.
import { afterAll, assert, describe, it } from "@effect/vitest"
import { emptySourceQuery, SourceFailed, type SourceSuggestions } from "@dreamspan/shared/cardSources.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { SourceHttp } from "../src/sources/adapter.ts"
import {
  batchUrl,
  capabilitiesOf,
  CARDEX_ORIGIN,
  cardexAdapter,
  cardSourceSetup,
  creatorOf,
  familyOf,
  cursorRefused,
  downloadModeOf,
  detailMetadata,
  searchParams,
  summaryOf,
  unmappedParameters
} from "../src/sources/cardex.ts"
import { makeSourceHttp } from "../src/sources/guard.ts"
import { makeLimiter } from "../src/sources/limiter.ts"
import { fakeCardexAdapter, SITE_LABELS, startFakeCardex } from "./support/fakeCardex.ts"

const archive = await startFakeCardex({ cards: 120 })
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
        response.status === 451
          ? "region_unavailable"
          : response.status === 404
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
          status: response.status,
          ...(response.headers.has("retry-after")
            ? { retryAfterMs: Number(response.headers.get("retry-after")) * 1000 }
            : {}),
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
      // In the filter bar's order, each with its place: a group's panel, beside the search, the
      // checkboxes, or no control of its own.
      assert.deepStrictEqual(
        caps.filters.map((f) => [f.id, f.label, f.group ?? f.place ?? ""]),
        [
          ["author", "Author", "Authors"],
          ["any_author", "Any of these authors", "Authors"],
          ["not_author", "Not by these authors", "Authors"],
          ["source", "Sources", "Sources"],
          ["not_source", "Exclude sources", "Sources"],
          ["chub_verified", "Chub verified", "Sources"],
          ["chub_recommended", "Chub recommended", "Sources"],
          ["kind", "Kind", "Kind"],
          ["nsfw", "NSFW", "NSFW"],
          ["tokens", "Tokens", "Tokens"],
          ["added_after", "Added after", "Added"],
          ["added_before", "Added before", "Added"],
          ["created_after", "Created after", "Created"],
          ["created_before", "Created before", "Created"],
          ["fields", "Search in", "search"],
          ["mode", "Match", "search"],
          ["exclude_forks", "Hide forks", "switches"],
          ["has_cover", "Only cards with a cover", "switches"],
          ["deleted_from_source", "Deleted from all sources", "switches"],
          ["deleted_from_any_source", "Deleted from a source", "switches"],
          ["any_tags", "Any of these tags", "none"],
          ["picture", "Picture", "none"]
        ]
      )
      // Sites left out are the same list, either mode; alternative tags are the tag field's; the
      // creator lists are one picker; the slider's scale tops out at 100,000 tokens.
      const site = caps.filters.find((f) => f.id === "source")!
      assert.strictEqual(site.kind === "choice" ? site.excludeId : undefined, "not_source")
      const tokens = caps.filters.find((f) => f.id === "tokens")!
      assert.strictEqual(tokens.kind === "range" ? tokens.scaleMax : undefined, 100_000)
      assert.strictEqual(caps.tags.anyFilterId, "any_tags")
      assert.deepStrictEqual(caps.creators, {
        filterId: "author",
        excludeFilterId: "not_author",
        anyFilterId: "any_author",
        profiles: true
      })
      // What v1 leaves out by default, from its own defaults; neither for lorebooks.
      assert.deepStrictEqual(
        caps.hiddenByDefault?.map((d) => [d.label, d.filterId, d.off, d.unless.map((u) => u.filterId), d.toggle]),
        [
          ["Characters under 300 tokens", "tokens", { min: 0 }, ["tokens", "kind"], undefined],
          ["Cards without a cover", "has_cover", "false", ["has_cover", "kind"], "Only cards with a cover"]
        ]
      )
      const rating = caps.filters.find((f) => f.id === "nsfw")!
      assert.deepStrictEqual(rating.kind === "choice" ? rating.options.map((o) => o.label) : [], [
        "Hide NSFW",
        "Show NSFW",
        "Only NSFW"
      ])
      // Safe is the narrowest choice: an assistant may narrow the user's rating to it (cardextools1).
      assert.deepStrictEqual(caps.ratings, { filterId: "nsfw", default: "include", safe: "exclude" })
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
      // Dates are dates (the panel offers a date field); other text criteria are plain text.
      const dated = caps.filters.filter((f) => f.kind === "text" && f.format === "date").map((f) => f.id)
      assert.deepStrictEqual(dated, ["added_after", "added_before", "created_after", "created_before"])
      // The sites cardex lists beyond our own labels keep the labels it gives.
      assert.isTrue(sites.kind === "choice" && sites.options.length === 18)
    })
  )

  it.effect("a creator's profile: v1's /authors facts, the avatar a path on the archive, the filters named", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      const caps = yield* adapter.capabilities(direct())
      assert.deepStrictEqual(caps.creators, {
        filterId: "author",
        excludeFilterId: "not_author",
        anyFilterId: "any_author",
        profiles: true
      })
      // A creator with an account on the site: cardex has a profile only for those.
      const card = archive.cards.find((c) => c.creator !== "lumen" && c.creatorKind === "account")!
      const query = `${card.site}/${card.creator}`
      const profile = yield* adapter.creator!(direct(), query)
      const theirs = archive.cards.filter(
        (c) => c.site === card.site && c.creator === card.creator && c.creatorKind === "account"
      )
      assert.strictEqual(profile.query, query)
      assert.strictEqual(profile.name, `${card.creator} (synthetic)`)
      assert.strictEqual(profile.cards, theirs.length)
      // cardex counts standalone lorebooks apart from cards, not cards with a lorebook in them.
      assert.strictEqual(
        profile.lorebooks,
        archive.lorebooks.filter((l) => l.site === card.site && l.creator === card.creator).length
      )
      assert.strictEqual(profile.site, SITE_LABELS[card.site])
      assert.isString(profile.bio)
      assert.match(profile.avatar!, /\/t\/[0-9a-f]{64}\.512\.webp\?v=1$/)
      assert.strictEqual(profile.url, `${archive.origin}/u/${card.site}/${card.creator}`)
      assert.isAbove(profile.lastSeen!, profile.firstSeen! - 1)
      assert.isTrue(archive.paths().some((p) => p.startsWith(`/api/v1/authors/${card.site}/`)))
      // Not a creator the archive knows; not a site/handle at all.
      for (const missing of [`${card.site}/nobody-here`, "no-slash", "/x"])
        assert.strictEqual((yield* Effect.flip(adapter.creator!(direct(), missing))).reason, "not_found", missing)
    })
  )

  it("a creator envelope keeps only what it can show: no avatar off the archive, no bad counts", () => {
    const profile = creatorOf(
      {
        author: {
          handle: "h",
          source: "chub",
          avatar: { url: "https://elsewhere.example/a.png" },
          card_count: -1,
          lorebook_count: "3",
          first_seen_at: "not a date",
          path: "/u/chub/h"
        }
      },
      "chub/h"
    )
    assert.deepStrictEqual(profile, { query: "chub/h", name: "h", site: "Chub", url: `${CARDEX_ORIGIN}/u/chub/h` })
    assert.throws(() => creatorOf({ results: [] }, "chub/h"))
  })

  it("malformed summaries are rejected without throwing", () => {
    for (const fields of [
      { name: 12 },
      { creator: "wrong" },
      { creator: { name: 12 } },
      { version: {} },
      { stats: { popularity: "many" } },
      { thumbnail_url: [] },
      { download_modes: "json" }
    ])
      assert.isNull(summaryOf({ slug: "synthetic", ...fields } as never))
  })

  it.effect("origin-keyed updates skip a three-version chain and keep historical files unchanged", () =>
    Effect.gen(function* () {
      const local = yield* Effect.promise(() => startFakeCardex({ cards: 6 }))
      try {
        const adapter = fakeCardexAdapter(local)
        const root = local.cards[0]!
        const first = local.publishSuccessor(root.slug)
        const head = local.publishSuccessor(first.slug, "chub")
        const seen: string[] = []
        const transport = direct(seen)
        const http: SourceHttp = {
          ...transport,
          get: (url, kind, headers) => {
            assert.strictEqual(url.origin, local.origin)
            return transport.get(url, kind, headers)
          }
        }
        const historical = yield* adapter.card(http, root.slug)
        assert.strictEqual(historical.summary.version.id, root.sha256)
        assert.isString(historical.locator)
        seen.length = 0
        const [latest] = yield* adapter.versions!(http, [root.slug], { [root.slug]: historical.locator! })
        assert.strictEqual(latest!.version.id, head.sha256)
        assert.strictEqual(latest!.currentId, head.slug)
        assert.lengthOf(seen, 1)
        assert.match(seen[0]!, /^\/api\/v1\/origins\//)
        assert.strictEqual((yield* adapter.card(http, root.slug)).summary.version.id, root.sha256)
        const fork = local.publishFork(head.slug)
        const currentFile = yield* adapter.card(http, head.slug)
        const [again] = yield* adapter.versions!(http, [head.slug], { [head.slug]: currentFile.locator! })
        assert.strictEqual(again!.currentId, head.slug)
        assert.notStrictEqual(again!.currentId, fork.slug)
        local.deleteCard(head.slug)
        const [deleted] = yield* adapter.versions!(http, [root.slug], { [root.slug]: historical.locator! })
        assert.isFalse(deleted!.available)
      } finally {
        yield* Effect.promise(() => local.close())
      }
    })
  )

  it.effect("successor fallback has one bounded request budget, rejects cycles, and never follows a URL", () =>
    Effect.gen(function* () {
      const local = yield* Effect.promise(() => startFakeCardex({ cards: 6 }))
      try {
        const adapter = fakeCardexAdapter(local)
        const root = local.cards[0]!
        const second = local.publishSuccessor(root.slug)
        local.withoutOrigins(root.slug)
        local.withoutOrigins(second.slug)
        const head = local.publishSuccessor(second.slug)
        local.withoutOrigins(head.slug)
        let requests = 0
        const transport = direct()
        const http: SourceHttp = {
          ...transport,
          get: (url, kind, headers) => {
            assert.strictEqual(url.origin, local.origin)
            requests++
            return transport.get(url, kind, headers)
          }
        }
        const [latest] = yield* adapter.versions!(http, [root.slug])
        assert.strictEqual(latest!.currentId, head.slug)
        assert.strictEqual(latest!.version.id, head.sha256)
        assert.isAtMost(requests, 8)
        local.pointSuccessor(head.slug, root.slug)
        requests = 0
        const cycle = yield* Effect.flip(adapter.versions!(http, [root.slug]))
        assert.strictEqual(cycle.reason, "bad_response")
        assert.isAtMost(requests, 8)
        local.pointSuccessor(head.slug, "https://untrusted.example/a-card")
        requests = 0
        const [missing] = yield* adapter.versions!(http, [root.slug])
        assert.isFalse(missing!.available)
        assert.isAtMost(requests, 8)
        let last = head
        for (let i = 0; i < 6; i++) {
          last = local.publishSuccessor(last.slug)
          local.withoutOrigins(last.slug)
        }
        requests = 0
        const long = yield* Effect.flip(adapter.versions!(http, [root.slug]))
        assert.strictEqual(long.reason, "bad_response")
        assert.isAtMost(requests, 8)
        const regional = local.cards[3]!
        const file = yield* adapter.card(http, regional.slug)
        const regionalHead = local.publishSuccessor(regional.slug)
        local.blockRegion(regionalHead.slug)
        const [unavailable] = yield* adapter.versions!(http, [regional.slug], { [regional.slug]: file.locator! })
        assert.isFalse(unavailable!.available)
      } finally {
        yield* Effect.promise(() => local.close())
      }
    })
  )
  it("family duplicates enrich sparse parent rows without losing their relationship", () => {
    const detail = {
      card: { slug: "viewed" },
      origins: [{ fork: { forked_from: { card_slug: "parent" } } }],
      earlier_origins: []
    }
    const family = familyOf("viewed", detail, [
      {
        site: "chub",
        versions: null,
        forks: {
          parent: {
            card: {
              slug: "parent",
              name: "Synthetic parent",
              thumb_url: "/t/parent.webp",
              creator: { name: "Synthetic author", source: "chub", handle: "synthetic-author" }
            }
          },
          children: [],
          next: null
        }
      }
    ])
    assert.lengthOf(family.items, 1)
    assert.deepInclude(family.items[0], {
      relation: "parent",
      remoteId: "parent",
      name: "Synthetic parent",
      creator: "Synthetic author",
      creatorQuery: "chub/synthetic-author",
      thumb: `${CARDEX_ORIGIN}/t/parent.webp`
    })
  })

  it("creator and family envelopes refuse malformed or mismatched identities", () => {
    for (const author of [{}, { source: "other", handle: "h" }, { source: "chub", handle: "different" }])
      assert.throws(() => creatorOf({ author }, "chub/h"))
    for (const detail of [
      {},
      { card: { slug: "other" }, origins: [], earlier_origins: [] },
      { card: { slug: "synthetic" }, origins: "wrong" }
    ])
      assert.throws(() => familyOf("synthetic", detail, []))
    const detail = { card: { slug: "synthetic" }, origins: [], earlier_origins: [] }
    assert.isTrue(
      familyOf(
        "synthetic",
        {
          ...detail,
          origins: Array.from({ length: 4 }, (_, i) => ({ source: "chub", external_id: `synthetic-${i}` }))
        },
        []
      ).more
    )
    for (const lists of [
      [{ site: "chub", versions: {}, forks: null }],
      [{ site: "chub", versions: { items: [false] }, forks: null }],
      [{ site: "chub", versions: null, forks: {} }]
    ])
      assert.throws(() => familyOf("synthetic", detail, lists))
  })

  it("a filter or sort v1 no longer lists, or one the bar doesn't place, is left out, and a body without filters is refused", () => {
    const caps = capabilitiesOf({
      filters: [
        { name: "nsfw", type: "enum", allowed_values: ["include", "exclude"], default: "exclude" },
        // Never a generic control named after the parameter.
        { name: "updated_after", type: "date", label: "Updated after" },
        { name: "constructor", type: "string" }
      ],
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

  it.effect("every parameter the archive describes has a control or is left out on purpose", () =>
    Effect.gen(function* () {
      const raw = yield* Effect.promise(
        async () =>
          (await (await fetch(`${archive.origin}/api/v1/capabilities`)).json()) as {
            readonly filters: ReadonlyArray<unknown>
          }
      )
      // A parameter added here means the bar has no control for it: map it in cardex.ts's PLACEMENT.
      assert.deepStrictEqual(unmappedParameters(raw), [])
      // One the archive adds later is left out of the bar, never a button of its own.
      const later = { ...raw, filters: [...raw.filters, { name: "mood", type: "string", label: "Mood" }] }
      assert.deepStrictEqual(unmappedParameters(later), ["mood"])
      assert.notInclude(
        capabilitiesOf(later).filters.map((f) => f.id),
        "mood"
      )
    })
  )

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
    // Unchosen, characters and standalone lorebooks both (§3.9).
    assert.strictEqual(params.get("kind"), "both")
    assert.strictEqual(searchParams({ ...query, filters: { kind: "lorebook" } }, null).get("kind"), "lorebook")
    assert.strictEqual(searchParams({ ...query, filters: { kind: "nonsense" } }, null).get("kind"), "both")
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
      assert.deepStrictEqual(kind.kind === "choice" ? kind.options.map((o) => [o.value, o.label]) : [], [
        ["both", "All"],
        ["character", "Characters"],
        ["character_lorebook", "Characters with a lorebook"],
        ["lorebook", "Lorebooks"]
      ])
      const c = archive.cards[0]!
      const identity = `${c.site}/${c.creator}`
      const cases: ReadonlyArray<
        readonly [
          Record<string, import("@dreamspan/shared/cardSources.ts").SourceFilterValue>,
          (slug: string) => boolean
        ]
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
        [{ has_cover: "false" }, () => true],
        [{ kind: "lorebook" }, (slug) => archive.lorebooks.some((x) => x.slug === slug)]
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

  it.effect("standalone lorebooks: marked in results, listed beside cards, their original file fetched (§3.9)", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      // Unchosen, the kind is both: the words name lorebooks, and they come back marked.
      const mixed = yield* adapter.search(direct(), { ...emptySourceQuery, text: "gazetteer" }, null)
      assert.isAbove(mixed.items.length, 0)
      assert.isTrue(mixed.items.every((item) => item.kind === "lorebook"))
      const cards = yield* adapter.search(direct(), { ...emptySourceQuery, filters: { kind: "character" } }, null)
      assert.isTrue(cards.items.every((item) => item.kind === undefined))
      // A lorebook without a picture is listed all the same.
      const books = yield* adapter.search(direct(), { ...emptySourceQuery, filters: { kind: "lorebook" } }, null)
      assert.lengthOf(books.items, archive.lorebooks.length)
      assert.isTrue(books.items.some((item) => item.thumb === undefined))
      const book = archive.lorebooks[0]!
      const seen: Array<string> = []
      const file = yield* adapter.card(direct(seen), book.slug)
      assert.strictEqual(file.summary.kind, "lorebook")
      assert.strictEqual(Buffer.from(file.bytes).toString("utf8"), book.json)
      assert.match(file.fileName, /\.json$/)
      assert.isTrue(seen.some((path) => path.includes("mode=original")))
    })
  )

  it.effect("a nullable search total is filled by the exact count endpoint; paging still follows next_cursor", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeCardex({ cards: 120 }))
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

  it.effect("keeps the search results and cursor when count fails or returns invalid data", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      const http = direct()
      const query = { ...emptySourceQuery, text: "a" }
      for (const invalid of [false, true]) {
        const first = yield* adapter.search(
          {
            ...http,
            get: (url, kind) => {
              if (!url.pathname.endsWith("/search/count"))
                return http
                  .get(url, kind)
                  .pipe(
                    Effect.map((page) =>
                      invalid ? { ...page, json: () => ({ ...(page.json() as object), total: 120 }) } : page
                    )
                  )
              if (invalid)
                return Effect.succeed({
                  status: 200,
                  headers: new Headers(),
                  bytes: new Uint8Array(),
                  json: () => ({ total: -1 })
                })
              return Effect.fail(
                new SourceFailed({ sourceId: "cardex", reason: "unreachable", status: 503, message: "Unavailable" })
              )
            }
          },
          query,
          null
        )
        assert.isNotEmpty(first.items)
        assert.isString(first.next)
        assert.strictEqual(first.total, invalid ? 120 : undefined)
        const second = yield* adapter.search(http, query, first.next)
        assert.isNotEmpty(second.items)
        assert.notStrictEqual(first.items[0]!.remoteId, second.items[0]!.remoteId)
      }
    })
  )

  it.effect("Cover: Any includes characters hidden by the archive's default cover filter", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeCardex({ cards: 60, coverless: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const covered = yield* adapter.search(direct(), emptySourceQuery, null)
      assert.strictEqual(covered.total, 40)
      assert.strictEqual(covered.hidden, 20)
      assert.isTrue(covered.items.every((c) => typeof c.thumb === "string"))
      const all = yield* adapter.search(direct(), { ...emptySourceQuery, filters: { has_cover: "false" } }, null)
      assert.strictEqual(all.total, 60)
      assert.strictEqual(all.hidden, 0)
      assert.isTrue(all.items.some((c) => c.thumb === undefined && c.image === undefined))
    }).pipe(Effect.scoped)
  )

  it.effect("healthy name-with-text and fewest-token searches use the requested order without a notice", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      for (const query of [
        { ...emptySourceQuery, text: "synthetic", sort: "name" },
        { ...emptySourceQuery, text: "synthetic", sort: "tokens", reverse: true },
        { ...emptySourceQuery, sort: "tokens", reverse: true }
      ]) {
        const seen: Array<string> = []
        const page = yield* adapter.search(direct(seen), query, null)
        assert.isUndefined(page.notice)
        assert.strictEqual(
          new URL(`http://fake${seen[0]}`).searchParams.get("sort"),
          query.sort === "name" ? "name" : "tokens_asc"
        )
        assert.isTrue(
          page.items.every(
            (item, index) =>
              index === 0 ||
              (query.sort === "name"
                ? item.name.localeCompare(page.items[index - 1]!.name) >= 0
                : item.tokens! >= page.items[index - 1]!.tokens!)
          )
        )
      }
    })
  )

  it.effect("any failed nondefault first-page order can substitute once, and all later pages retain that order", () =>
    Effect.gen(function* () {
      const adapter = fakeCardexAdapter(archive)
      for (const [sort, reverse, requested, substitute, status] of [
        ["name", false, "name", "relevance", 500],
        ["tokens", true, "tokens_asc", "tokens_desc", 502],
        ["newest", false, "newest", "relevance", 503],
        ["created", true, "created_asc", "created_desc", 504]
      ] as const) {
        archive.failSort(requested, status)
        const seen: Array<string> = []
        const http = direct(seen)
        const query = { ...emptySourceQuery, text: "synthetic", sort, reverse }
        const first = yield* adapter.search(http, query, null)
        assert.include(first.notice!, "just now")
        assert.match(first.next!, /^s:/)
        const second = yield* adapter.search(http, query, first.next)
        assert.strictEqual(second.notice, first.notice)
        assert.isFalse(second.reset === true)
        assert.isFalse(second.items.some((item) => first.items.some((old) => old.remoteId === item.remoteId)))
        const used = seen
          .filter((path) => path.startsWith("/api/v1/search?"))
          .map((path) => new URL(`http://fake${path}`).searchParams.get("sort"))
        assert.deepStrictEqual(used, [requested, substitute, substitute])
        const reloaded = yield* adapter.search(http, query, null)
        assert.isUndefined(reloaded.notice)
        assert.match(reloaded.next!, /^c:/)
        // An expired substitute cursor restarts the same order, never the requested one.
        yield* Effect.promise(() => fetch(`${archive.origin}/__fake/expire-cursors`))
        const restarted = yield* adapter.search(http, query, first.next)
        assert.isTrue(restarted.reset)
        assert.deepStrictEqual(restarted.items, first.items)
      }
    })
  )

  it.effect(
    "later pages, default-order failures, nonserver errors and failed substitutes do not enter a fallback loop",
    () =>
      Effect.gen(function* () {
        const adapter = fakeCardexAdapter(archive)
        const query = { ...emptySourceQuery, text: "synthetic", sort: "name" }
        const first = yield* adapter.search(direct(), query, null)
        for (const [sort, token, status] of [
          ["name", first.next, 500],
          ["relevance", null, 500],
          ["name", null, 501],
          ["name", null, 400]
        ] as const) {
          const seen: Array<string> = []
          archive.failSort(sort, status)
          const error = yield* Effect.flip(adapter.search(direct(seen), { ...query, sort }, token))
          assert.strictEqual(error.status, status)
          assert.lengthOf(seen, 1)
        }
        const seen: Array<string> = []
        archive.failNext(500, 2)
        const failed = yield* Effect.flip(adapter.search(direct(seen), query, null))
        assert.strictEqual(failed.status, 500)
        assert.lengthOf(seen, 2)
        const disconnected: SourceHttp = {
          apiKey: null,
          get: () => Effect.fail(new SourceFailed({ sourceId: "cardex", reason: "unreachable", message: "offline" }))
        }
        const offline = yield* Effect.flip(adapter.search(disconnected, query, null))
        assert.isUndefined(offline.status)
      })
  )

  it.live("503 and 429 Retry-After retry the requested order before considering a substitute", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeCardex({ cards: 120 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const seen: Array<string> = []
      const http = makeSourceHttp(adapter, null, {
        network: { fetchFor: () => fetch },
        limiter: makeLimiter(),
        bypassEntries: () => [],
        onRequest: (_id, url) => seen.push(url.pathname + url.search)
      })
      const query = { ...emptySourceQuery, text: "synthetic", sort: "name" }
      for (const status of [503, 429]) {
        seen.length = 0
        fake.failSort("name", status, 1, 0.01)
        const started = Date.now()
        const page = yield* adapter.search(http, query, null)
        assert.isAtLeast(Date.now() - started, 900)
        assert.isUndefined(page.notice)
        assert.deepStrictEqual(
          seen
            .filter((path) => path.startsWith("/api/v1/search?"))
            .map((path) => new URL(`http://fake${path}`).searchParams.get("sort")),
          ["name", "name"]
        )
      }
      seen.length = 0
      fake.failSort("name", 503, 2, 0.01)
      const substituted = yield* adapter.search(http, query, null)
      assert.include(substituted.notice!, "just now")
      assert.deepStrictEqual(
        seen
          .filter((path) => path.startsWith("/api/v1/search?"))
          .map((path) => new URL(`http://fake${path}`).searchParams.get("sort")),
        ["name", "name", "relevance"]
      )
      seen.length = 0
      fake.failSort("name", 429, 2, 0.01)
      const limited = yield* Effect.flip(adapter.search(http, query, null))
      assert.strictEqual(limited.reason, "rate_limited")
      assert.strictEqual(limited.status, 429)
      assert.deepStrictEqual(
        seen
          .filter((path) => path.startsWith("/api/v1/search?"))
          .map((path) => new URL(`http://fake${path}`).searchParams.get("sort")),
        ["name", "name"]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("counts share the search filters and distinguish a capped lower bound", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => startFakeCardex({ cards: 120, countCap: 50 }))
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
            : // cardex suggests creators with an account on their site, not names on a card
              new Set(
                archive.cards.flatMap((card) =>
                  card.creatorKind === "account" ? [`${card.site}/${card.creator}`] : []
                )
              ).size
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

  it.effect("earlier origins use their nested listing, with archive-only links", () =>
    Effect.gen(function* () {
      const card = yield* fakeCardexAdapter(archive).card(direct(), archive.cards[0]!.slug)
      assert.deepStrictEqual(card.summary.earlierOrigins, [
        {
          label: `Earlier listing on ${SITE_LABELS[archive.cards[0]!.site]}`,
          url: `${archive.origin}/o/${archive.cards[0]!.site}/previous-${archive.cards[0]!.slug}`
        }
      ])
      assert.deepStrictEqual(
        detailMetadata({
          earlier_origins: [{ listing: { path: "https://elsewhere.example/x", source: "chub" } }, { listing: null }]
        }),
        {}
      )
      assert.deepStrictEqual(
        detailMetadata({
          earlier_origins: [
            { listing: { path: "/o/unknown/1", source: "generic", source_label: "Other" } },
            { listing: { path: "/o/unknown/2", source: "unrecognized" } },
            { listing: { path: "/o/unknown/3" } },
            { listing: { path: "/o/chub/4", source: "chub" } },
            { listing: { path: "/o/unknown/5", source: "generic", source_label: "Example Archive" } }
          ]
        }).earlierOrigins?.map(({ label }) => label),
        [
          "Earlier listing",
          "Earlier listing",
          "Earlier listing",
          "Earlier listing on Chub",
          "Earlier listing on Example Archive"
        ]
      )
    })
  )

  it("a batch URL is in v1's canonical form: sorted, without duplicates, joined by %2C", () => {
    assert.strictEqual(batchUrl(["b-2", "a-1", "b-2"]).href, `${CARDEX_ORIGIN}/api/v1/cards/batch?ids=a-1%2Cb-2`)
  })

  it("a summary's paths resolve against the archive; a URL elsewhere is dropped", () => {
    const sha = "a".repeat(64)
    // A captured search item (test/fixtures/cardex), with these fields in place of its own.
    const captured = (
      JSON.parse(
        readFileSync(fileURLToPath(new URL("./fixtures/cardex/search-default.json", import.meta.url)), "utf8")
      ) as { body: { items: Array<Record<string, unknown>> } }
    ).body.items[0]!
    const summary = summaryOf({
      ...captured,
      slug: "amber-lantern-1",
      url: "/c/amber-lantern-1",
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
    assert.strictEqual(summary.rating, "NSFW")
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
      const cached = yield* Effect.promise(() => startFakeCardex({ cards: 60, omitDownloadModes: true }))
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
      const listing = yield* Effect.promise(() => startFakeCardex({ cards: 60 }))
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
