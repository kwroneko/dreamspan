// A fake card archive (spec/CARD-SOURCES.md §10): an in-process HTTP server serving our own
// synthetic cards in the shape of cardex's public API v1 (https://cardex.zip/docs/api), so the
// real cardex adapter (`src/sources/cardex.ts`) runs against it unchanged, pointed at its
// origin: v1's capabilities descriptors (names, types, allowed values; no labels); search with
// `nsfw` include/exclude/only, `kind`, tags, tokens, sites, `author` as site/handle, v1's sorts,
// `limit` 1–100 (else 400), a cursor in text mode (refused for another query with 400
// `invalid_cursor`) and page numbers
// in either mode, semantic mode capped at 240 with no cursor and no sort, a total capped at
// 10,000 and then an estimate; the tags envelope; a card's detail envelope; a batch lookup that
// answers anything but its canonical form (sorted, without duplicates, joined by `%2C`) with a
// 308; pictures as paths (`/t/<sha256>.512.webp?v=1`, `/i/<sha256>.png`); downloads as a
// mirrored card PNG or JSON, a CHARX-original card (`originalOnly`) answering 404 for its
// mirrored and self-contained files, each summary's and detail file's `download_modes` (left
// out with `omitDownloadModes`, as a response cached from before cardex listed them), and
// `refuseDownloads`, a card whose downloads are refused (an empty list, 403). Misuse answers
// 400 `bad_request`, a cursor of another query 400 `invalid_cursor`. `publish` makes a newer
// version of a card under the same slug (its file changes, so its version, the file's SHA-256,
// does), the older file still downloadable. No real archive's cards, names or images are used:
// everything is generated here. The development server and the tests use it in place of cardex, and the tests
// count what reaches it, so they can check that nothing is sent before the user asks (§5.1).
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { deflateSync } from "node:zlib"
import sharp from "sharp"
import type { CardSourceAdapter } from "../../src/sources/adapter.ts"
import { cardexAdapter } from "../../src/sources/cardex.ts"

const ADJECTIVES = [
  "Amber",
  "Quiet",
  "Copper",
  "Velvet",
  "Hollow",
  "Bright",
  "Salt",
  "Ashen",
  "Lunar",
  "Wild",
  "Paper",
  "Iron",
  "Silver",
  "Misty",
  "Gilded",
  "Rustic",
  "Frost",
  "Sable",
  "Coral",
  "Ember"
]
const NOUNS = [
  "Lantern",
  "Harbor",
  "Archivist",
  "Courier",
  "Gardener",
  "Sentinel",
  "Cartographer",
  "Tinker",
  "Wanderer",
  "Keeper",
  "Scribe",
  "Alchemist",
  "Navigator",
  "Herald",
  "Warden",
  "Minstrel"
]
const CREATORS = ["fable_forge", "night-owl", "quillwork", "tidepool", "lumen", "graywind", "marrow"]
/** v1's site names the synthetic cards say they were found on. */
const SITES = ["chub", "risuai", "char_tavern", "generic"]
const TAGS = [
  "fantasy",
  "sci-fi",
  "mystery",
  "slice-of-life",
  "adventure",
  "romance",
  "comedy",
  "horror",
  "historical",
  "cyberpunk",
  "steampunk",
  "detective",
  "magic",
  "space",
  "school",
  "noir",
  "post-apocalyptic",
  "fairy-tale",
  "mythology",
  "western",
  "pirates",
  "dragons",
  "robots",
  "ghosts"
]

interface FakeCard {
  readonly slug: string
  readonly name: string
  readonly creator: string
  /** The site it was found on (v1's `source`). */
  readonly site: string
  readonly tags: ReadonlyArray<string>
  readonly tagline: string
  readonly nsfw: boolean
  readonly tokens: number
  readonly popularity: number
  readonly addedAt: number
  readonly hasLorebook: boolean
  /** Made from another card on its source (`exclude_forks` leaves these out). */
  readonly fork: boolean
  /** Its original is a CHARX, as some on cardex are: no mirrored or self-contained file, only its JSON. */
  readonly originalOnly: boolean
  readonly json: string
  readonly sha256: string
  readonly color: readonly [number, number, number]
  readonly supersededBy?: string
}

/** A deterministic pseudo-random sequence, so every run serves the same archive. */
const sequence = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const syntheticCards = (count = 240): ReadonlyArray<FakeCard> => {
  const random = sequence(20261107)
  const cards: Array<FakeCard> = []
  for (let n = 0; n < count; n++) {
    const name = `${ADJECTIVES[n % ADJECTIVES.length]} ${NOUNS[Math.floor(n / ADJECTIVES.length) % NOUNS.length]}${n >= 320 ? ` ${n}` : ""}`
    const creator = CREATORS[Math.floor(random() * CREATORS.length)]!
    const tags = [
      ...new Set(Array.from({ length: 2 + Math.floor(random() * 4) }, () => TAGS[Math.floor(random() * TAGS.length)]!))
    ]
    const nsfw = random() < 0.15
    const hasLorebook = random() < 0.3
    const fork = n % 5 === 3
    const description = `${name} is a synthetic character made for testing, who enjoys ${tags.join(" and ")} stories.`
    const firstMessage = `*${name} looks up from a stack of notes.* "Oh, hello. I wasn't expecting anyone today."`
    const doc = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description,
        personality: "Curious, patient, a little dry.",
        scenario: `A quiet afternoon in a ${tags[0]} setting.`,
        first_mes: firstMessage,
        mes_example: "",
        creator_notes: `Synthetic card ${n + 1}.`,
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: random() < 0.5 ? [`"Back again?" ${name} smiles.`] : [],
        tags,
        creator,
        character_version: "1.0",
        extensions: {},
        ...(hasLorebook
          ? {
              character_book: {
                name: `${name}'s notes`,
                entries: [
                  {
                    keys: ["notes"],
                    content: `${name} keeps careful notes.`,
                    enabled: true,
                    insertion_order: 100,
                    extensions: {}
                  }
                ],
                extensions: {}
              }
            }
          : {})
      }
    }
    const json = JSON.stringify(doc)
    const sha256 = createHash("sha256").update(json).digest("hex")
    const hue = (n * 47) % 360
    cards.push({
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sha256.slice(0, 8)}`,
      name,
      creator,
      site: SITES[n % SITES.length]!,
      tags,
      tagline: `A ${tags[0]} ${NOUNS[Math.floor(n / ADJECTIVES.length) % NOUNS.length]!.toLowerCase()} for quiet scenes.`,
      nsfw,
      tokens: 400 + Math.floor(random() * 3600),
      popularity: Math.floor(random() * 10_000),
      addedAt: Date.UTC(2026, 0, 1) + n * 3_600_000,
      hasLorebook,
      fork,
      originalOnly: n % 40 === 7,
      json,
      sha256,
      color: hsl(hue)
    })
  }
  return cards
}

const hsl = (hue: number): readonly [number, number, number] => {
  const c = 0.5
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [Math.round((r + 0.3) * 255), Math.round((g + 0.3) * 255), Math.round((b + 0.3) * 255)]
}

// --- A tiny PNG encoder, so the fake needs no image library: a portrait in one colour with a
// lighter band, enough to tell tiles apart.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** The card as a PNG: its portrait with the card's JSON in a `chara` text chunk, as card PNGs carry it. */
const cardPng = (card: FakeCard) => {
  const png = portraitPng(512, 768, card.color)
  const text = Buffer.concat([Buffer.from("chara\0", "latin1"), Buffer.from(Buffer.from(card.json).toString("base64"))])
  // Before IEND, the last 12 bytes.
  return Buffer.concat([png.subarray(0, png.length - 12), chunk("tEXt", text), png.subarray(png.length - 12)])
}

const portraitPng = (width: number, height: number, color: readonly [number, number, number]) => {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    const band = y > height * 0.3 && y < height * 0.55 ? 40 : 0
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.min(255, color[0] + band)
      raw[row + 2 + x * 3] = Math.min(255, color[1] + band)
      raw[row + 3 + x * 3] = Math.min(255, color[2] + band)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array())
  ])
}

const flag = (name: string, value = false) => ({
  name,
  type: "boolean",
  allowed_values: ["true", "false", "1", "0"],
  default: value,
  min: null,
  max: null
})
const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  allowed_values: [],
  default: null,
  min: null,
  max: null,
  ...extra
})
/** v1's sites, all of them, as its capabilities list them. */
const V1_SITES = [
  "chub",
  "char_tavern",
  "risuai",
  "janitorai",
  "venusai",
  "nyaime",
  "booru",
  "webring",
  "catbox",
  "generic",
  "botbooru",
  "pygmalion",
  "aicc",
  "backyard",
  "wyvern",
  "pephop"
]
const V1_SORTS = ["relevance", "newest", "oldest", "popular", "name", "tokens_asc", "tokens_desc"]
/** cardex v1's search caps: in text mode a total past 10,000 is an estimate; semantic mode finds 240 at most. */
const MAX_RESULTS = 10_000
const SEMANTIC_MAX = 240

/** The archive's own description of what it can filter and sort by (v1: /api/v1/capabilities). */
const capabilitiesBody = {
  version: "v1",
  filters: [
    field("q", "string", { max: 500 }),
    field("nsfw", "enum", { allowed_values: ["include", "exclude", "only"], default: "include" }),
    field("kind", "enum", { allowed_values: ["character", "lorebook", "both"], default: "both" }),
    field("source", "list", { allowed_values: V1_SITES, default: [] }),
    field("tags", "list", { default: [], max: 20 }),
    field("not_tags", "list", { default: [], max: 20 }),
    field("min_tokens", "integer", { default: 30, min: 0, max: 10_000_000 }),
    field("max_tokens", "integer", { min: 0, max: 10_000_000 }),
    flag("has_cover", true),
    field("author", "identity"),
    flag("exclude_forks")
  ],
  sorts: V1_SORTS,
  default_sort: "relevance with q; newest without q",
  modes: [
    { name: "fts", pagination: ["page", "cursor"], max_results: MAX_RESULTS },
    { name: "semantic", pagination: ["page"], max_results: SEMANTIC_MAX }
  ],
  page_size: { min: 1, max: 100, default: 24, max_results: MAX_RESULTS },
  thumbnail_variants: ["512", "64"],
  download_modes: ["mirrored", "self-contained", "json", "original"],
  rate_limits: { requests_per_second: 10, burst: 60 },
  terms_url: "/docs/api#terms"
}

export interface FakeArchiveOptions {
  readonly port?: number
  readonly cards?: number
  /** Report the total as an estimate, as an archive with a large index may. */
  readonly estimate?: boolean
  /** Leave `download_modes` out, as a response cached from before cardex listed them. */
  readonly omitDownloadModes?: boolean
}

export interface FakeArchive {
  readonly origin: string
  readonly host: string
  readonly cards: ReadonlyArray<FakeCard>
  /** Requests received, by path, and all together. */
  readonly hits: () => number
  readonly paths: () => ReadonlyArray<string>
  readonly reset: () => void
  /** The next `times` requests get this status (and `Retry-After`), as a failing archive would answer. */
  readonly failNext: (status: number, times?: number, retryAfterSeconds?: number) => void
  /** The card's author publishes a newer version: a changed description, the next `character_version`. */
  readonly publish: (slug: string) => FakeCard
  /** From now on the archive refuses downloads of this card: no `download_modes`, 403 on a try. */
  readonly refuseDownloads: (slug: string) => void
  readonly close: () => Promise<void>
}

/** The real cardex adapter, pointed at the fake: what tests and the development instance register. */
export const fakeCardexAdapter = (archive: Pick<FakeArchive, "origin">): CardSourceAdapter =>
  cardexAdapter({ origin: archive.origin })

const error = (code: string, message: string) => ({ error: code, message })

export const startFakeArchive = async (options: FakeArchiveOptions = {}): Promise<FakeArchive> => {
  const cards = [...syntheticCards(options.cards ?? 240)]
  const bySlug = new Map(cards.map((c) => [c.slug, c]))
  const bySha = new Map(cards.map((c) => [c.sha256, c]))
  // The full image is a PNG; the thumbnails, as cardex's, WebP at 512 and 64 px wide.
  const images = new Map<string, Promise<Buffer>>()
  const image = (card: FakeCard, size: "512" | "64" | "full") => {
    const key = `${card.sha256}:${size}`
    let made = images.get(key)
    if (!made) {
      const png = portraitPng(512, 768, card.color)
      made =
        size === "full"
          ? Promise.resolve(png)
          : sharp(png)
              .resize({ width: Number(size) })
              .webp()
              .toBuffer()
      images.set(key, made)
    }
    return made
  }
  const publish = (slug: string) => {
    const at = cards.findIndex((c) => c.slug === slug)
    if (at < 0) throw new Error(`no fake card ${slug}`)
    const card = cards[at]!
    const doc = JSON.parse(card.json) as { data: { description: string; character_version: string } }
    const revision = Number(doc.data.character_version.split(".")[1] ?? "0") + 1
    doc.data.description = `${doc.data.description} Revised ${revision}: ${card.name} now keeps a garden.`
    doc.data.character_version = `1.${revision}`
    const json = JSON.stringify(doc)
    const sha256 = createHash("sha256").update(json).digest("hex")
    const next: FakeCard = { ...card, json, sha256, addedAt: card.addedAt + revision * 86_400_000 }
    cards[at] = next
    bySlug.set(slug, next)
    bySha.set(sha256, next)
    return next
  }
  const seen: Array<string> = []
  let failure: { status: number; times: number; retryAfter?: number; path?: string } | null = null

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
  }
  // v1's CardSummary; its URLs are paths on the archive.
  const summary = (c: FakeCard) => ({
    slug: c.slug,
    url: `/c/${c.slug}`,
    name: c.name,
    creator: { name: c.creator, source: c.site, handle: c.creator, url: `/u/${c.site}/${c.creator}` },
    tags: c.tags,
    tagline: c.tagline,
    nsfw: c.nsfw,
    kind: "character",
    token_count: c.tokens,
    stats: { popularity: c.popularity, rating_avg: 4, rating_count: 10 },
    thumbnail_url: `/t/${c.sha256}.512.webp?v=1`,
    image_url: `/i/${c.sha256}.png`,
    version: c.sha256,
    updated_at: new Date(c.addedAt).toISOString(),
    superseded_by: c.supersededBy ?? null,
    ...(options.omitDownloadModes ? {} : { download_modes: downloadModes(c) })
  })
  /** The modes that answer 200: a CHARX original has no mirrored or self-contained file. */
  const refused = new Set<string>()
  const downloadModes = (c: FakeCard) =>
    refused.has(c.slug) ? [] : c.originalOnly ? ["json", "original"] : [...capabilitiesBody.download_modes]
  const list = (value: string | null) => (value ?? "").split(",").filter(Boolean)
  const truthy = (value: string | null) => value === "true" || value === "1"

  /**
   * v1's search: `limit` 1–100 (24 by default), else 400; text mode pages by `page` or by the
   * `next_cursor` it gave, which belongs to the same query and limit only; semantic mode by
   * `page` alone, 240 results at most, ranked by likeness whatever the sort.
   */
  const search = (params: URLSearchParams): { status: number; body: unknown } => {
    const mode = params.get("mode") ?? "fts"
    if (mode !== "fts" && mode !== "semantic")
      return { status: 400, body: error("bad_request", "mode is fts or semantic") }
    const limit = Number(params.get("limit") ?? "24")
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return { status: 400, body: error("bad_request", "limit must be 1 to 100") }
    if (mode === "semantic" && params.has("cursor"))
      return { status: 400, body: error("bad_request", "semantic mode pages with page") }
    const nsfw = params.get("nsfw") ?? "include"
    if (!["include", "exclude", "only"].includes(nsfw))
      return { status: 400, body: error("bad_request", "unknown nsfw") }
    const kind = params.get("kind") ?? "both"
    if (!["character", "lorebook", "both"].includes(kind))
      return { status: 400, body: error("bad_request", "unknown kind") }
    const sites = list(params.get("source"))
    if (sites.some((s) => !V1_SITES.includes(s))) return { status: 400, body: error("bad_request", "unknown source") }
    const q = (params.get("q") ?? "").trim().toLowerCase()
    const sort = params.get("sort") ?? (q ? "relevance" : "newest")
    if (!V1_SORTS.includes(sort)) return { status: 400, body: error("bad_request", "unknown sort") }
    const include = list(params.get("tags"))
    const exclude = list(params.get("not_tags"))
    if (include.length > 20 || exclude.length > 20)
      return { status: 400, body: error("bad_request", "at most 20 tags") }
    // The query a cursor belongs to: every parameter but the cursor and page, in order.
    const normalized = [...params]
      .filter(([k]) => k !== "cursor" && k !== "page")
      .sort(([a], [b]) => a.localeCompare(b))
    const queryHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12)
    let offset = 0
    if (params.has("cursor")) {
      const cursor = /^(\d+)\.([0-9a-f]{12})$/.exec(Buffer.from(params.get("cursor")!, "base64url").toString("utf8"))
      if (!cursor || cursor[2] !== queryHash)
        return { status: 400, body: error("invalid_cursor", "the cursor belongs to another query") }
      offset = Number(cursor[1])
    } else if (params.has("page")) {
      const page = Number(params.get("page"))
      if (!Number.isInteger(page) || page < 1) return { status: 400, body: error("bad_request", "page starts at 1") }
      offset = (page - 1) * limit
    }
    const author = (params.get("author") ?? "").toLowerCase()
    const min = Number(params.get("min_tokens") ?? "30")
    const max = Number(params.get("max_tokens") ?? "Infinity")
    const noForks = truthy(params.get("exclude_forks"))
    const semantic = mode === "semantic"
    const words = (c: FakeCard) => c.name.toLowerCase().includes(q) || c.tagline.toLowerCase().includes(q)
    const matching = cards.filter(
      (c) =>
        // Meaning search finds something for any words; text search needs them.
        (semantic || !q || words(c)) &&
        kind !== "lorebook" &&
        (sites.length === 0 || sites.includes(c.site)) &&
        include.every((t) => c.tags.includes(t)) &&
        !exclude.some((t) => c.tags.includes(t)) &&
        (nsfw === "include" || (nsfw === "only" ? c.nsfw : !c.nsfw)) &&
        (!author || `${c.site}/${c.creator}`.toLowerCase() === author) &&
        c.tokens >= min &&
        c.tokens <= max &&
        (!noForks || !c.fork)
    )
    // Semantic mode ranks by likeness to the words: here, a stable hash of the words and the card.
    const likeness = (c: FakeCard) => createHash("sha256").update(`${q}\u0000${c.slug}`).digest().readUInt32BE(0)
    const order: Record<string, (a: FakeCard, b: FakeCard) => number> = {
      relevance: (a, b) =>
        Number(b.name.toLowerCase().includes(q)) - Number(a.name.toLowerCase().includes(q)) ||
        b.popularity - a.popularity,
      newest: (a, b) => b.addedAt - a.addedAt,
      oldest: (a, b) => a.addedAt - b.addedAt,
      popular: (a, b) => b.popularity - a.popularity,
      name: (a, b) => a.name.localeCompare(b.name),
      tokens_asc: (a, b) => a.tokens - b.tokens,
      tokens_desc: (a, b) => b.tokens - a.tokens
    }
    const by = semantic ? (a: FakeCard, b: FakeCard) => likeness(a) - likeness(b) : order[sort]!
    const sorted = [...matching].sort((a, b) => by(a, b) || a.slug.localeCompare(b.slug))
    const reachable = sorted.slice(0, semantic ? SEMANTIC_MAX : MAX_RESULTS)
    const items = reachable.slice(offset, offset + limit).map(summary)
    const more = offset + limit < reachable.length
    const estimated = !semantic && (options.estimate === true || sorted.length > MAX_RESULTS)
    const total = semantic
      ? reachable.length
      : options.estimate
        ? Math.round(reachable.length / 10) * 10
        : reachable.length
    return {
      status: 200,
      body: {
        query: Object.fromEntries(params),
        author: null,
        author_error: null,
        results: items,
        items,
        total,
        total_capped: sorted.length > reachable.length,
        total_is_estimate: estimated,
        page: Math.floor(offset / limit) + 1,
        pages: Math.ceil(reachable.length / limit),
        page_size: limit,
        tags: include,
        not_tags: exclude,
        unknown_tags: [],
        semantic: semantic ? { max_results: SEMANTIC_MAX } : null,
        defaults: { nsfw: "include", kind: "both", min_tokens: 30, has_cover: true },
        next_cursor:
          !semantic && more ? Buffer.from(`${offset + limit}.${queryHash}`, "utf8").toString("base64url") : null
      }
    }
  }

  const download = (res: ServerResponse, c: FakeCard, mode: string) => {
    if (!capabilitiesBody.download_modes.includes(mode)) return json(res, 400, error("bad_request", "unknown mode"))
    // A CHARX original has no mirrored or self-contained file, but its JSON, as every card's.
    // These synthetic originals are themselves JSON.
    if (refused.has(c.slug)) return json(res, 403, error("download_refused", "this card can't be downloaded"))
    if (!downloadModes(c).includes(mode)) return json(res, 404, error("no_derived_download", "not in this form"))
    if (mode === "json" || mode === "original") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${c.slug}.json"`
      })
      return res.end(c.json)
    }
    res.writeHead(200, { "content-type": "image/png", "content-disposition": `attachment; filename="${c.slug}.png"` })
    return res.end(cardPng(c))
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const path = url.pathname
    if (path === "/__fake/hits") return json(res, 200, { hits: seen.length, paths: seen })
    if (path === "/__fake/reset") {
      seen.length = 0
      failure = null
      return json(res, 200, { ok: true })
    }
    if (path === "/__fake/fail") {
      failure = {
        status: Number(url.searchParams.get("status") ?? "500"),
        times: Number(url.searchParams.get("times") ?? "1"),
        ...(url.searchParams.has("retryAfter") ? { retryAfter: Number(url.searchParams.get("retryAfter")) } : {}),
        // Only requests to this path fail, so a picture loading meanwhile doesn't use the failure up.
        ...(url.searchParams.has("path") ? { path: url.searchParams.get("path")! } : {})
      }
      return json(res, 200, { ok: true })
    }
    if (path === "/__fake/publish") {
      const slug = url.searchParams.get("slug") ?? ""
      if (!bySlug.has(slug)) return json(res, 404, error("not_found", "no such card"))
      const next = publish(slug)
      return json(res, 200, { slug, version: next.sha256 })
    }
    seen.push(`${path}${url.search}`)
    if (failure && failure.times > 0 && (failure.path === undefined || failure.path === path)) {
      failure.times -= 1
      const { status, retryAfter } = failure
      if (failure.times === 0) failure = null
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) })
      })
      return res.end(JSON.stringify(error(status === 429 ? "rate_limited" : "failed", "a failure the test asked for")))
    }
    if (path === "/api/v1/capabilities") return json(res, 200, capabilitiesBody)
    if (path === "/api/v1/search") {
      const { status, body } = search(url.searchParams)
      return json(res, status, body)
    }
    if (path === "/api/v1/tags") {
      // A page of 200 by card count; `limit` isn't a v1 parameter here.
      const prefix = (url.searchParams.get("q") ?? "").toLowerCase()
      const counts = new Map<string, number>()
      for (const c of cards) for (const t of c.tags) if (t.startsWith(prefix)) counts.set(t, (counts.get(t) ?? 0) + 1)
      const all = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return json(res, 200, {
        q: prefix,
        tags: all.slice(0, 200).map(([slug, card_count]) => ({ slug, label: slug, card_count })),
        page: 1,
        pages: Math.max(1, Math.ceil(all.length / 200)),
        total: all.length
      })
    }
    if (path === "/api/v1/cards/batch") {
      const ids = list(url.searchParams.get("ids"))
      const canonical = [...new Set(ids)].sort()
      if (canonical.length > 100) return json(res, 400, error("bad_request", "at most 100 ids"))
      // Anything but the canonical form (sorted, without duplicates, joined by %2C) answers 308.
      const form = `?ids=${canonical.map(encodeURIComponent).join("%2C")}`
      if (url.search !== form) {
        res.writeHead(308, { location: `/api/v1/cards/batch${form}` })
        return res.end()
      }
      return json(res, 200, {
        items: canonical.flatMap((id) => {
          const c = bySlug.get(id)
          return c ? [{ ...summary(c), file_sha256: c.sha256 }] : []
        }),
        missing: canonical.filter((id) => !bySlug.has(id))
      })
    }
    const detail = /^\/api\/v1\/cards\/([^/]+)$/.exec(path)
    if (detail) {
      // v1's card page envelope: its `card` is the archive's record, not a summary.
      const c = bySlug.get(decodeURIComponent(detail[1]!))
      if (!c) return json(res, 404, error("not_found", "no such card"))
      const origin = { source: c.site, author: c.creator, name: c.name, tagline: c.tagline, tags: c.tags, fork: c.fork }
      return json(res, 200, {
        card: {
          slug: c.slug,
          kind: "character",
          nsfw: c.nsfw,
          tags: c.tags,
          path: `/c/${c.slug}`,
          content_hash: c.sha256
        },
        creator: summary(c).creator,
        files: [
          {
            sha256: c.sha256,
            ext: c.originalOnly ? "charx" : "json",
            is_original: true,
            url: `/i/${c.sha256}.png`,
            ...(options.omitDownloadModes ? {} : { download_modes: downloadModes(c) })
          }
        ],
        origins: [origin],
        main_origin: origin,
        earlier_origins: [],
        related: [],
        variants: []
      })
    }
    const file = /^\/api\/v1\/download\/([0-9a-f]{64})$/.exec(path)
    if (file) {
      const c = bySha.get(file[1]!)
      return c
        ? download(res, c, url.searchParams.get("mode") ?? "mirrored")
        : json(res, 404, error("not_found", "no such file"))
    }
    const picture = /^\/(?:t\/([0-9a-f]{64})\.(512|64)\.webp|i\/([0-9a-f]{64})\.png)$/.exec(path)
    if (picture) {
      const thumb = picture[1] !== undefined
      const c = bySha.get((picture[1] ?? picture[3])!)
      if (!c) return json(res, 404, error("not_found", "no such picture"))
      void image(c, thumb ? (picture[2] as "512" | "64") : "full").then((bytes) => {
        res.writeHead(200, {
          "content-type": thumb ? "image/webp" : "image/png",
          "cache-control": "public, max-age=31536000, immutable"
        })
        res.end(bytes)
      })
      return
    }
    json(res, 404, error("not_found", "no such path"))
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    host: `127.0.0.1:${port}`,
    cards,
    hits: () => seen.length,
    paths: () => [...seen],
    reset: () => {
      seen.length = 0
      failure = null
    },
    failNext: (status, times = 1, retryAfterSeconds) => {
      failure = { status, times, ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds }) }
    },
    publish,
    refuseDownloads: (slug) => void refused.add(slug),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
