// A fake card archive (spec/CARD-SOURCES.md §10): an in-process HTTP server serving our own
// synthetic cards, closely in the shape of cardex's public read API v1, so the real adapter
// can be a thin mapping of this one: capabilities with filters, sorts and modes; search with
// a cursor in fts mode and page numbers in semantic mode, `limit` 1–100, a total capped at
// 10,000 that may be an estimate; tag prefix suggestions with counts; immutable slugs with
// `superseded_by`; the file's sha256 as the version; a batch lookup that answers an unsorted
// or duplicated id list with a 308 to its canonical URL; 512 px WebP thumbnails apart from
// the full image; downloads as JSON or PNG. No real archive's cards, names or images are
// used: everything is generated here. The development server registers it in place of the real adapter, and the tests count what reaches it, so they can
// check that nothing is sent before the user asks (§5.1).
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { deflateSync } from "node:zlib"
import sharp from "sharp"
import { SourceFailed, type SourceCapabilities, type SourceQuery } from "@rp/shared/cardSources.ts"
import { Effect } from "effect"
import type { AdapterSummary, CardSourceAdapter, SourceHttp } from "../../src/sources/adapter.ts"

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
  readonly tags: ReadonlyArray<string>
  readonly tagline: string
  readonly nsfw: boolean
  readonly tokens: number
  readonly popularity: number
  readonly addedAt: number
  readonly hasLorebook: boolean
  /** Made from another card on its source (`exclude_forks` leaves these out). */
  readonly fork: boolean
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
      tags,
      tagline: `A ${tags[0]} ${NOUNS[Math.floor(n / ADJECTIVES.length) % NOUNS.length]!.toLowerCase()} for quiet scenes.`,
      nsfw,
      tokens: 400 + Math.floor(random() * 3600),
      popularity: Math.floor(random() * 10_000),
      addedAt: Date.UTC(2026, 0, 1) + n * 3_600_000,
      hasLorebook,
      fork,
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

/** The archive's own description of what it can filter and sort by (cardex v1: /api/v1/capabilities). */
const capabilitiesBody = {
  modes: [
    { id: "fts", label: "Words", paging: "cursor", default: true },
    { id: "semantic", label: "Meaning", paging: "page" }
  ],
  filters: [
    {
      id: "nsfw",
      label: "Rating",
      type: "choice",
      options: [
        ["sfw", "Safe"],
        ["all", "Everything"],
        ["nsfw", "Mature only"]
      ],
      default: "sfw"
    },
    { id: "tokens", label: "Tokens", type: "range", min: 0, max: 20000 },
    { id: "exclude_forks", label: "Leave out forks", type: "toggle" },
    { id: "author", label: "Creator", type: "text" }
  ],
  sorts: [
    { id: "popularity", label: "Popular", reversible: true },
    { id: "added", label: "Newest", reversible: true },
    { id: "name", label: "Name", reversible: true }
  ],
  limits: { limit_min: 1, limit_max: 100, max_results: 10_000 },
  thumbnail_sizes: [512],
  download_modes: ["mirrored", "self-contained", "json", "original"],
  terms_url: "/terms"
}

/** cardex v1 caps a search's total here, saying it's an estimate. */
const MAX_RESULTS = 10_000

export interface FakeArchiveOptions {
  readonly port?: number
  readonly cards?: number
  /** Report the total as an estimate, as an archive with a large index may. */
  readonly estimate?: boolean
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
  readonly close: () => Promise<void>
}

export const startFakeArchive = async (options: FakeArchiveOptions = {}): Promise<FakeArchive> => {
  const cards = syntheticCards(options.cards ?? 240)
  const bySlug = new Map(cards.map((c) => [c.slug, c]))
  const bySha = new Map(cards.map((c) => [c.sha256, c]))
  // The full image is a PNG; the thumbnail, as cardex's, a 512 px wide WebP.
  const images = new Map<string, Promise<Buffer>>()
  const image = (card: FakeCard, size: "thumb" | "full") => {
    const key = `${card.sha256}:${size}`
    let made = images.get(key)
    if (!made) {
      const png = portraitPng(512, 768, card.color)
      made = size === "full" ? Promise.resolve(png) : sharp(png).resize({ width: 512 }).webp().toBuffer()
      images.set(key, made)
    }
    return made
  }
  const seen: Array<string> = []
  let failure: { status: number; times: number; retryAfter?: number } | null = null

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  let origin = ""
  const summary = (c: FakeCard) => ({
    slug: c.slug,
    url: `${origin}/c/${c.slug}`,
    name: c.name,
    creator: { name: c.creator, source: "fake", handle: c.creator, url: `${origin}/u/${c.creator}` },
    tags: c.tags,
    tagline: c.tagline,
    nsfw: c.nsfw,
    kind: "character",
    token_count: c.tokens,
    stats: { popularity: c.popularity, rating_avg: 4, rating_count: 10 },
    thumbnail_url: `${origin}/t/${c.sha256}.512.webp`,
    image_url: `${origin}/i/${c.sha256}.png`,
    version: c.sha256,
    updated_at: new Date(c.addedAt).toISOString(),
    superseded_by: c.supersededBy ?? null
  })

  /**
   * cardex v1's search: `limit` 1–100, else 400; fts mode (the default) pages with the
   * `next_cursor` it gave, for the same query and limit only; semantic mode with `page` (from
   * 1), and gives no cursor. The total is capped at 10,000, marked as an estimate past that.
   */
  const search = (params: URLSearchParams): { status: number; body: unknown } => {
    const mode = params.get("mode") ?? "fts"
    if (mode !== "fts" && mode !== "semantic") return { status: 400, body: { error: "mode is fts or semantic" } }
    const limit = Number(params.get("limit") ?? "20")
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return { status: 400, body: { error: "limit must be 1 to 100" } }
    if (mode === "fts" && params.has("page")) return { status: 400, body: { error: "fts mode pages with cursor" } }
    if (mode === "semantic" && params.has("cursor"))
      return { status: 400, body: { error: "semantic mode pages with page" } }
    // The query a cursor belongs to: every parameter but the cursor itself, in order.
    const normalized = [...params].filter(([k]) => k !== "cursor").sort(([a], [b]) => a.localeCompare(b))
    const queryHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12)
    let offset = 0
    if (mode === "semantic") {
      const page = Number(params.get("page") ?? "1")
      if (!Number.isInteger(page) || page < 1) return { status: 400, body: { error: "page starts at 1" } }
      offset = (page - 1) * limit
    } else if (params.has("cursor")) {
      const cursor = /^(\d+)\.([0-9a-f]{12})$/.exec(Buffer.from(params.get("cursor")!, "base64url").toString("utf8"))
      if (!cursor || cursor[2] !== queryHash)
        return { status: 400, body: { error: "the cursor belongs to another query" } }
      offset = Number(cursor[1])
    }
    const q = (params.get("q") ?? "").toLowerCase()
    const include = (params.get("tags") ?? "").split(",").filter(Boolean)
    const exclude = (params.get("not_tags") ?? "").split(",").filter(Boolean)
    const nsfw = params.get("nsfw") ?? "sfw"
    const author = (params.get("author") ?? "").toLowerCase()
    const min = Number(params.get("min_tokens") ?? "0")
    const max = Number(params.get("max_tokens") ?? "Infinity")
    const noForks = params.get("exclude_forks") === "true"
    const sort = params.get("sort") ?? "popularity"
    const ascending = params.get("order") === "asc"
    const matching = cards.filter(
      (c) =>
        (!q || c.name.toLowerCase().includes(q) || c.tagline.toLowerCase().includes(q)) &&
        include.every((t) => c.tags.includes(t)) &&
        !exclude.some((t) => c.tags.includes(t)) &&
        (nsfw === "all" || (nsfw === "nsfw" ? c.nsfw : !c.nsfw)) &&
        (!author || c.creator.toLowerCase().includes(author)) &&
        c.tokens >= min &&
        c.tokens <= max &&
        (!noForks || !c.fork)
    )
    // Semantic mode ranks by likeness to the words: here, a stable hash of the words and the card.
    const likeness = (c: FakeCard) => createHash("sha256").update(`${q}\u0000${c.slug}`).digest().readUInt32BE(0)
    const key = (c: FakeCard) =>
      mode === "semantic" && q ? likeness(c) : sort === "name" ? c.name : sort === "added" ? c.addedAt : c.popularity
    const sorted = [...matching].sort((a, b) => {
      const [x, y] = [key(a), key(b)]
      const order = x < y ? -1 : x > y ? 1 : 0
      // Popular and Newest come highest first; Name A to Z.
      return (sort === "name" ? order : -order) * (ascending ? -1 : 1) || a.slug.localeCompare(b.slug)
    })
    const reachable = sorted.slice(0, MAX_RESULTS)
    const items = reachable.slice(offset, offset + limit)
    const more = offset + limit < reachable.length
    const estimated = options.estimate === true || sorted.length > MAX_RESULTS
    return {
      status: 200,
      body: {
        total: options.estimate ? Math.round(reachable.length / 10) * 10 : reachable.length,
        total_is_estimate: estimated,
        next_cursor:
          mode === "fts" && more ? Buffer.from(`${offset + limit}.${queryHash}`, "utf8").toString("base64url") : null,
        items: items.map(summary)
      }
    }
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
        ...(url.searchParams.has("retryAfter") ? { retryAfter: Number(url.searchParams.get("retryAfter")) } : {})
      }
      return json(res, 200, { ok: true })
    }
    seen.push(`${path}${url.search}`)
    if (failure && failure.times > 0) {
      failure.times -= 1
      const { status, retryAfter } = failure
      if (failure.times === 0) failure = null
      res.writeHead(status, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) })
      return res.end()
    }
    if (path === "/api/v1/capabilities") return json(res, 200, capabilitiesBody)
    if (path === "/api/v1/search") {
      const { status, body } = search(url.searchParams)
      return json(res, status, body)
    }
    if (path === "/api/v1/tags") {
      const prefix = (url.searchParams.get("q") ?? "").toLowerCase()
      const counts = new Map<string, number>()
      for (const c of cards) for (const t of c.tags) if (t.startsWith(prefix)) counts.set(t, (counts.get(t) ?? 0) + 1)
      return json(
        res,
        200,
        [...counts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, Number(url.searchParams.get("limit") ?? "10"))
          .map(([slug, card_count]) => ({ slug, label: slug, card_count }))
      )
    }
    if (path === "/api/v1/cards/batch") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)
      const canonical = [...new Set(ids)].sort()
      if (canonical.length > 100) return json(res, 400, { error: "at most 100 ids" })
      // An unsorted or duplicated list answers 308 to its canonical URL, as cardex v1 does.
      if (canonical.join(",") !== ids.join(",")) {
        res.writeHead(308, { location: `/api/v1/cards/batch?ids=${canonical.map(encodeURIComponent).join(",")}` })
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
    const card = /^\/api\/v1\/cards\/([^/]+)$/.exec(path)
    if (card) {
      const c = bySlug.get(decodeURIComponent(card[1]!))
      return c ? json(res, 200, summary(c)) : json(res, 404, { error: "not found" })
    }
    const download = /^\/api\/v1\/download\/([0-9a-f]{64})$/.exec(path)
    if (download) {
      const c = bySha.get(download[1]!)
      if (!c) return json(res, 404, { error: "not found" })
      // `json` and `original` (these cards were uploaded as JSON) are the JSON; the generated modes, a card PNG.
      const mode = url.searchParams.get("mode") ?? "mirrored"
      if (!["mirrored", "self-contained", "json", "original"].includes(mode))
        return json(res, 400, { error: "unknown mode" })
      if (mode === "json" || mode === "original") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(c.json)
      }
      res.writeHead(200, { "content-type": "image/png" })
      return res.end(cardPng(c))
    }
    const picture = /^\/(?:t\/([0-9a-f]{64})\.512\.webp|i\/([0-9a-f]{64})\.png)$/.exec(path)
    if (picture) {
      const thumb = picture[1] !== undefined
      const c = bySha.get((picture[1] ?? picture[2])!)
      if (!c) return json(res, 404, { error: "not found" })
      void image(c, thumb ? "thumb" : "full").then((bytes) => {
        res.writeHead(200, {
          "content-type": thumb ? "image/webp" : "image/png",
          "cache-control": "public, max-age=31536000, immutable"
        })
        res.end(bytes)
      })
      return
    }
    json(res, 404, { error: "not found" })
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
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
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

// --- The adapter: what a real archive's adapter does, against the fake's API.

interface ArchiveSummary {
  readonly slug: string
  readonly url: string
  readonly name: string
  readonly creator: { readonly name: string }
  readonly tags: ReadonlyArray<string>
  readonly tagline: string
  readonly nsfw: boolean
  readonly token_count: number
  readonly stats: { readonly popularity: number }
  readonly thumbnail_url: string
  readonly image_url: string
  readonly version: string
  readonly updated_at: string
  readonly superseded_by: string | null
}

const bad = (sourceId: string) =>
  new SourceFailed({ sourceId, reason: "bad_response", message: `${sourceId} sent something this app can't read` })

const asSummary = (item: ArchiveSummary): AdapterSummary => ({
  remoteId: item.slug,
  name: item.name,
  creator: item.creator.name,
  tagline: item.tagline,
  tags: item.tags,
  ...(item.nsfw ? { rating: "Mature" } : {}),
  tokens: item.token_count,
  thumb: item.thumbnail_url,
  image: item.image_url,
  version: {
    id: item.version,
    updatedAt: Date.parse(item.updated_at),
    ...(item.superseded_by ? { supersededBy: item.superseded_by } : {})
  },
  url: item.url,
  stats: { popularity: item.stats.popularity }
})

const PAGE_SIZE = 50

/**
 * The page token we hand out (opaque to everything but this adapter): `c:<cursor>` in fts
 * mode, where cardex pages with its cursor; `p:<n>` in semantic mode, where it pages by number.
 */
const pageOf = (token: string | null) =>
  token?.startsWith("c:")
    ? ({ cursor: token.slice(2) } as const)
    : token?.startsWith("p:")
      ? ({ page: Number(token.slice(2)) } as const)
      : ({} as const)

/** The query as the archive's search parameters. */
const searchParams = (query: SourceQuery, token: string | null) => {
  const params = new URLSearchParams()
  const page = pageOf(token)
  if (query.text.trim()) params.set("q", query.text.trim())
  if (query.tags.length) params.set("tags", query.tags.join(","))
  if (query.excludeTags.length) params.set("not_tags", query.excludeTags.join(","))
  for (const [id, value] of Object.entries(query.filters)) {
    if (id === "tokens" && typeof value === "object" && !Array.isArray(value)) {
      const range = value as { readonly min?: number; readonly max?: number }
      if (range.min !== undefined) params.set("min_tokens", String(range.min))
      if (range.max !== undefined) params.set("max_tokens", String(range.max))
    } else if (typeof value === "string" && value !== "") params.set(id, value)
    else if (value === true) params.set(id, "true")
  }
  if (query.sort) params.set("sort", query.sort)
  if (query.reverse) params.set("order", "asc")
  params.set("limit", String(PAGE_SIZE))
  if ("cursor" in page) params.set("cursor", page.cursor)
  if ("page" in page) params.set("page", String(page.page))
  return params
}

export interface FakeAdapterOptions {
  /** "cardex" on the development server, standing in for the real adapter (phase 4). */
  readonly id?: string
  readonly name?: string
  readonly origin: string
  readonly rate?: { readonly perSecond: number; readonly burst: number }
}

export const fakeArchiveAdapter = (options: FakeAdapterOptions): CardSourceAdapter => {
  const id = options.id ?? "cardex"
  const base = new URL(options.origin)
  const api = (path: string, params?: URLSearchParams) => {
    const url = new URL(path, base)
    if (params) url.search = params.toString()
    return url
  }
  const getJson = (http: SourceHttp, url: URL) =>
    Effect.flatMap(http.get(url, "json"), (response) =>
      Effect.try({ try: () => response.json(), catch: () => bad(id) })
    )
  /** Only the archive's own URLs: an image or card URL elsewhere is refused before any request. */
  const own = (raw: string) =>
    Effect.suspend(() => {
      const url = URL.canParse(raw) ? new URL(raw) : null
      return url && url.origin === base.origin ? Effect.succeed(url) : Effect.fail(bad(id))
    })
  return {
    id,
    name: options.name ?? "cardex",
    hosts: [base.host],
    scheme: base.protocol === "http:" ? "http" : "https",
    local: base.protocol === "http:",
    key: "optional",
    ...(options.rate ? { rate: options.rate } : { rate: { perSecond: 10, burst: 60 } }),
    capabilities: (http) =>
      Effect.map(getJson(http, api("/api/v1/capabilities")), (raw): SourceCapabilities => {
        const body = raw as typeof capabilitiesBody
        const rating = body.filters.find((f) => f.id === "nsfw")
        // The search modes are one more choice: how the words are matched.
        const modes = {
          id: "mode",
          label: "Match",
          kind: "choice" as const,
          multi: false,
          options: body.modes.map((m) => ({ value: m.id, label: m.label })),
          about: "Words finds cards that contain your words; Meaning finds cards about what you describe."
        }
        return {
          text: true,
          tags: { include: true, exclude: true, suggest: true },
          filters: [
            ...body.filters.map((f) =>
              f.type === "choice"
                ? {
                    id: f.id,
                    label: f.label,
                    kind: "choice" as const,
                    multi: false,
                    options: (f.options ?? []).map(([value, label]) => ({ value: value!, label: label! }))
                  }
                : f.type === "range"
                  ? {
                      id: f.id,
                      label: f.label,
                      kind: "range" as const,
                      unit: "tokens",
                      min: f.min ?? 0,
                      max: f.max ?? 0
                    }
                  : f.type === "toggle"
                    ? { id: f.id, label: f.label, kind: "toggle" as const }
                    : { id: f.id, label: f.label, kind: "text" as const }
            ),
            modes
          ],
          sorts: body.sorts,
          ratings: { filterId: "nsfw", default: rating?.default ?? null },
          paging: "cursor",
          stats: [{ id: "popularity", label: "popularity" }]
        }
      }),
    search: (http, query, page) =>
      Effect.flatMap(getJson(http, api("/api/v1/search", searchParams(query, page))), (raw) => {
        const body = raw as {
          total: number
          total_is_estimate: boolean
          next_cursor: string | null
          items: Array<ArchiveSummary>
        }
        if (!Array.isArray(body?.items)) return Effect.fail(bad(id))
        // Semantic mode gives no cursor: the next page is the next number while results remain.
        const semantic = query.filters.mode === "semantic"
        const number = pageOf(page)
        const current = "page" in number ? number.page : 1
        const next = semantic
          ? body.items.length === PAGE_SIZE && current * PAGE_SIZE < body.total
            ? `p:${current + 1}`
            : null
          : body.next_cursor === null
            ? null
            : `c:${body.next_cursor}`
        return Effect.succeed({
          items: body.items.map(asSummary),
          next,
          total: body.total,
          totalEstimated: body.total_is_estimate
        })
      }),
    tags: (http, prefix) =>
      Effect.map(getJson(http, api("/api/v1/tags", new URLSearchParams({ q: prefix, limit: "10" }))), (raw) =>
        (raw as Array<{ slug: string; label: string; card_count: number }>).map((t) => ({
          tag: t.slug,
          label: t.label,
          count: t.card_count
        }))
      ),
    card: (http, remoteId) =>
      Effect.gen(function* () {
        const item = (yield* getJson(http, api(`/api/v1/cards/${encodeURIComponent(remoteId)}`))) as ArchiveSummary
        const file = yield* http.get(
          api(`/api/v1/download/${item.version}`, new URLSearchParams({ mode: "json" })),
          "card"
        )
        return { bytes: file.bytes, fileName: `${item.name}.json`, summary: asSummary(item) }
      }),
    image: (http, ref) =>
      Effect.flatMap(own(ref), (url) => Effect.map(http.get(url, "image"), (response) => response.bytes)),
    // Sorted and without duplicates, the list's canonical form, so cardex needn't redirect it.
    versions: (http, ids) =>
      Effect.map(
        getJson(http, api("/api/v1/cards/batch", new URLSearchParams({ ids: [...new Set(ids)].sort().join(",") }))),
        (raw) =>
          (raw as { items: Array<ArchiveSummary & { file_sha256: string }> }).items.map((c) => ({
            remoteId: c.slug,
            version: {
              id: c.version,
              updatedAt: Date.parse(c.updated_at),
              ...(c.superseded_by ? { supersededBy: c.superseded_by } : {})
            }
          }))
      )
  }
}
