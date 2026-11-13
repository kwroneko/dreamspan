// A fake card archive (spec/CARD-SOURCES.md §10): an in-process HTTP server serving our own
// synthetic cards in the shape of cardex's public API v1 (https://cardex.zip/docs/api), so the
// real cardex adapter (`src/sources/cardex.ts`) runs against it unchanged, pointed at its
// origin: v1's capabilities descriptors (names, types, allowed values and labels); search with
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
// does), the older file still downloadable. Standalone lorebooks (`kind: "lorebook"`, a World
// Info JSON in every download mode) are listed for `kind=lorebook`, and beside cards when the
// words name one (`syntheticLorebooks`); `publish` gives them one more entry. No real archive's cards, names or images are used:
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
  readonly hasCover: boolean
  readonly hasLorebook: boolean
  readonly createdAt: number
  readonly deleted: boolean
  readonly verified: boolean
  readonly recommended: boolean
  /** Made from another card on its source (`exclude_forks` leaves these out). */
  readonly fork: boolean
  /** Its original is a CHARX, as some on cardex are: no mirrored or self-contained file, only its JSON. */
  readonly originalOnly: boolean
  readonly json: string
  readonly sha256: string
  readonly color: readonly [number, number, number]
  readonly supersededBy?: string | undefined
  /** The card it was forked from on its site (a fork's parent: the card before it). */
  readonly parent?: string
  /** An earlier version, its own card on the archive under a slug of its own, not in searches. */
  readonly older?: boolean
  /** A standalone lorebook (v1's `kind: "lorebook"`): its file a World Info JSON, not a card. */
  readonly lorebook?: boolean
}

const LORE_NOUNS = ["Gazetteer", "Almanac", "Atlas", "Bestiary"]
const LORE_CREATORS = ["inkmap", "atlas_hand"]
const LORE_TAGS = ["worldbuilding", "places", "factions", "creatures"]

/** A lorebook's file as SillyTavern's World Info export: `entries` keyed by uid. */
const worldInfoJson = (name: string, entries: ReadonlyArray<readonly [string, string]>) =>
  JSON.stringify({
    description: `${name}, a synthetic lorebook made for testing.`,
    entries: Object.fromEntries(
      entries.map(([key, content], uid) => [
        String(uid),
        {
          uid,
          key: [key],
          keysecondary: [],
          comment: key,
          content,
          constant: false,
          selective: true,
          selectiveLogic: 0,
          order: 100,
          position: 0,
          disable: false,
          excludeRecursion: false,
          probability: 100,
          useProbability: true,
          depth: 4,
          displayIndex: uid,
          extensions: {}
        }
      ])
    )
  })

/**
 * Standalone lorebooks: their own names, creators and tags, so the cards' tests see none of
 * them. Searches list them for `kind=lorebook`, and for `both` (unchosen) only when the words
 * name one, so a search for "gazetteer" finds them beside no card.
 */
const syntheticLorebooks = (count: number): ReadonlyArray<FakeCard> =>
  Array.from({ length: count }, (_, n): FakeCard => {
    const name = `${ADJECTIVES[n % ADJECTIVES.length]} ${LORE_NOUNS[n % LORE_NOUNS.length]}`
    const tags = [LORE_TAGS[n % LORE_TAGS.length]!, LORE_TAGS[(n + 1) % LORE_TAGS.length]!]
    const json = worldInfoJson(name, [
      ["harbor", `The harbor of ${name} opens at dawn.`],
      ["tower", `A tower of ${name} keeps the old maps.`]
    ])
    const sha256 = createHash("sha256").update(json).digest("hex")
    return {
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sha256.slice(0, 8)}`,
      name,
      creator: LORE_CREATORS[n % LORE_CREATORS.length]!,
      site: SITES[n % SITES.length]!,
      tags,
      tagline: `A ${tags[0]} lorebook of ${LORE_NOUNS[n % LORE_NOUNS.length]!.toLowerCase()} entries.`,
      nsfw: false,
      tokens: 600 + n * 50,
      popularity: 500 + n,
      addedAt: Date.UTC(2026, 1, 1) + n * 3_600_000,
      // Some have no picture, as on cardex.
      hasCover: n % 4 !== 2,
      hasLorebook: false,
      createdAt: Date.UTC(2025, 6, 1) + n * 86_400_000,
      deleted: false,
      verified: false,
      recommended: false,
      fork: false,
      originalOnly: false,
      json,
      sha256,
      color: hsl((n * 83 + 20) % 360),
      lorebook: true
    }
  })

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
      hasCover: true,
      hasLorebook,
      createdAt: Date.UTC(2025, 0, 1) + (count - n) * 86_400_000,
      deleted: n % 11 === 0,
      verified: n % 3 === 0,
      recommended: n % 4 === 0,
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
  "pephop",
  "caveduck",
  "crushon"
]
const V1_SORTS = [
  "relevance",
  "newest",
  "oldest",
  "created_desc",
  "created_asc",
  "popular",
  "name",
  "name_desc",
  "tokens_asc",
  "tokens_desc"
]
/** cardex v1's search caps: in text mode a total past 10,000 is an estimate; semantic mode finds 240 at most. */
const MAX_RESULTS = 10_000
const SEMANTIC_MAX = 240

/** The archive's own description of what it can filter and sort by (v1: /api/v1/capabilities). */
const capabilitiesBody = {
  version: "v1",
  filters: [
    field("q", "string", { max: 500 }),
    field("fields", "list", {
      label: "Search in",
      allowed_values: ["name", "description", "character", "lorebook"],
      allowed_value_labels: [
        { value: "name", label: "Name" },
        { value: "description", label: "Tagline and description" },
        { value: "character", label: "Character definition" },
        { value: "lorebook", label: "Lorebook, creator and tags" }
      ],
      default: []
    }),
    field("nsfw", "enum", { allowed_values: ["include", "exclude", "only"], default: "include" }),
    field("kind", "enum", { allowed_values: ["character", "lorebook", "both", "character_lorebook"], default: "both" }),
    field("source", "list", { allowed_values: V1_SITES, default: [] }),
    field("not_source", "list", { allowed_values: V1_SITES, default: [] }),
    field("any_tags", "groups", { default: [], max: 20 }),
    field("tags", "list", { default: [], max: 20 }),
    field("not_tags", "list", { default: [], max: 20 }),
    field("min_tokens", "integer", { default: 300, min: 0, max: 10_000_000 }),
    field("max_tokens", "integer", { min: 0, max: 10_000_000 }),
    flag("has_cover", true),
    field("author", "identity"),
    field("any_author", "identities", { default: [], max: 20 }),
    field("not_author", "identities", { default: [], max: 20 }),
    field("picture", "sha256"),
    ...["added_after", "added_before", "created_after", "created_before"].map((name) => field(name, "date")),
    flag("exclude_forks"),
    flag("deleted_from_source"),
    flag("deleted_from_any_source"),
    flag("chub_verified"),
    flag("chub_recommended")
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
  /** Live v1 omits the expensive count on cursor searches. */
  readonly countCap?: number
  readonly unknownTotal?: boolean
  /** Include some characters without cover images. */
  readonly coverless?: boolean
  /** Leave `download_modes` out, as a response cached from before cardex listed them. */
  readonly omitDownloadModes?: boolean
  /** How many standalone lorebooks it has (12 by default). */
  readonly lorebooks?: number
}

export interface FakeArchive {
  readonly origin: string
  readonly host: string
  readonly cards: ReadonlyArray<FakeCard>
  readonly lorebooks: ReadonlyArray<FakeCard>
  /** Requests received, by path, and all together. */
  readonly conditionalHits: () => number
  readonly notModified: () => number
  readonly hits: () => number
  readonly paths: () => ReadonlyArray<string>
  readonly reset: () => void
  /** The next `times` requests get this status (and `Retry-After`), as a failing archive would answer. */
  readonly failSort: (sort: string, status: number, times?: number, retryAfterSeconds?: number) => void
  readonly failNext: (status: number, times?: number, retryAfterSeconds?: number) => void
  /** The card's author publishes a newer version: a changed description, the next `character_version`. */
  readonly publish: (slug: string) => FakeCard
  readonly publishSuccessor: (slug: string, site?: string) => FakeCard
  readonly publishFork: (slug: string) => FakeCard
  readonly pointSuccessor: (slug: string, target: string) => void
  readonly withoutOrigins: (slug: string) => void
  readonly deleteCard: (slug: string) => void
  readonly blockRegion: (slug: string) => void
  /** From now on the archive refuses downloads of this card: no `download_modes`, 403 on a try. */
  readonly refuseDownloads: (slug: string) => void
  readonly close: () => Promise<void>
}

/** The real cardex adapter, pointed at the fake: what tests and the development instance register. */
export const fakeCardexAdapter = (archive: Pick<FakeArchive, "origin">): CardSourceAdapter =>
  cardexAdapter({ origin: archive.origin })

const error = (code: string, message: string) => ({ error: code, message })

export const startFakeArchive = async (options: FakeArchiveOptions = {}): Promise<FakeArchive> => {
  const generated = syntheticCards(options.cards ?? 240)
  const cards = generated.map((card, n): FakeCard => ({
    ...card,
    hasCover: options.coverless ? n % 3 !== 0 : true,
    // A fork was made from the card before it, on the same site.
    ...(card.fork && n > 0 ? { parent: generated[n - 1]!.slug } : {})
  }))
  // Every sixth card has an earlier version: a card of its own on the archive, which searches
  // don't list, as the archive keeps a card's versions.
  const olderVersions = cards.flatMap((card, n): Array<FakeCard> => {
    if (n % 6 !== 1) return []
    const doc = JSON.parse(card.json) as { data: { description: string; character_version: string } }
    doc.data.description = `${doc.data.description} (An earlier draft.)`
    doc.data.character_version = "0.9"
    const json = JSON.stringify(doc)
    const sha256 = createHash("sha256").update(json).digest("hex")
    return [
      {
        ...card,
        slug: `${card.slug}-v09`,
        json,
        sha256,
        addedAt: card.addedAt - 30 * 86_400_000,
        older: true,
        supersededBy: card.slug
      }
    ]
  })
  const lorebooks = [...syntheticLorebooks(options.lorebooks ?? 12)]
  // Every third lorebook has an earlier version, as cards do.
  for (const [n, book] of lorebooks.entries()) {
    if (n % 3 !== 1) continue
    const doc = JSON.parse(book.json) as { description: string }
    doc.description = `${doc.description} (An earlier draft.)`
    const json = JSON.stringify(doc)
    olderVersions.push({
      ...book,
      slug: `${book.slug}-v09`,
      json,
      sha256: createHash("sha256").update(json).digest("hex"),
      addedAt: book.addedAt - 30 * 86_400_000,
      older: true,
      supersededBy: book.slug
    })
  }
  /** The list a card or lorebook is in. */
  const listOf = (c: FakeCard) => (c.lorebook ? lorebooks : cards)
  let countCap = options.countCap ?? 100_000
  let cursorEpoch = 0
  const bySlug = new Map([...cards, ...lorebooks, ...olderVersions].map((c) => [c.slug, c]))
  const bySha = new Map([...cards, ...lorebooks, ...olderVersions].map((c) => [c.sha256, c]))
  /** A card's listing on its site, as v1's origins name it. */
  const externalOf = (c: FakeCard) => `ext-${c.slug}`
  const originKeys = new Map<string, readonly [string, string]>()
  const originHeads = new Map<string, string>()
  const roots = new Map<string, string>()
  const deleted = new Set<string>()
  const regional = new Set<string>()
  const noOrigins = new Set<string>()
  const originKey = (pair: readonly [string, string]) => JSON.stringify(pair)
  for (const c of [...cards, ...lorebooks]) {
    const pair = [c.site, externalOf(c)] as const
    originKeys.set(c.slug, pair)
    originHeads.set(originKey(pair), c.slug)
    roots.set(c.slug, c.slug)
  }
  for (const c of olderVersions) {
    const root = c.slug.slice(0, -4)
    originKeys.set(c.slug, originKeys.get(root)!)
    roots.set(c.slug, root)
  }
  const byExternal = (site: string, external: string) => {
    const slug = originHeads.get(originKey([site, external]))
    return slug && !deleted.has(slug) ? bySlug.get(slug) : undefined
  }
  /** v1's short card in a family listing (`/forks`' parent and children). */
  const familyEntry = (c: FakeCard, viewed: FakeCard) => ({
    id: String(cards.indexOf(c) + 1),
    external_id: externalOf(c),
    source_url: `https://synthetic.example/${c.site}/${c.slug}`,
    card: {
      slug: c.slug,
      path: `/c/${c.slug}`,
      name: c.name,
      is_this: c.slug === viewed.slug,
      nsfw: c.nsfw,
      origins: [
        {
          removal: null,
          source: c.site,
          external_id: externalOf(c),
          path: `/o/${c.site}/${externalOf(c)}`,
          is_fork: c.fork
        }
      ],
      earliest_known: new Date(c.createdAt).toISOString(),
      estimated_creation: {
        at: new Date(c.createdAt).toISOString(),
        kind: "site_created",
        source: c.site,
        board: null
      },
      has_lorebook: c.hasLorebook,
      thumb_url: c.hasCover ? `/t/${c.sha256}.512.webp` : null,
      creator: { kind: "account", name: c.creator, path: `/u/${c.site}/${c.creator}`, source: c.site, avatar_url: null }
    }
  })
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
  /** A lorebook's next version: one more entry. */
  const reviseLorebook = (book: FakeCard) => {
    const doc = JSON.parse(book.json) as { entries: Record<string, Record<string, unknown>> }
    const revision = Object.keys(doc.entries).length - 1
    const first = doc.entries["0"]!
    doc.entries[String(revision + 1)] = {
      ...first,
      uid: revision + 1,
      displayIndex: revision + 1,
      key: [`garden ${revision}`],
      comment: `garden ${revision}`,
      content: `Revised ${revision}: ${book.name} now lists a garden.`
    }
    return { json: JSON.stringify(doc), revision }
  }
  const publish = (slug: string) => {
    const list = listOf(bySlug.get(slug) ?? cards[0]!)
    const at = list.findIndex((c) => c.slug === slug)
    if (at < 0) throw new Error(`no fake card ${slug}`)
    const card = list[at]!
    let json: string
    let revision: number
    if (card.lorebook) ({ json, revision } = reviseLorebook(card))
    else {
      const doc = JSON.parse(card.json) as { data: { description: string; character_version: string } }
      revision = Number(doc.data.character_version.split(".")[1] ?? "0") + 1
      doc.data.description = `${doc.data.description} Revised ${revision}: ${card.name} now keeps a garden.`
      doc.data.character_version = `1.${revision}`
      json = JSON.stringify(doc)
    }
    const sha256 = createHash("sha256").update(json).digest("hex")
    const next: FakeCard = { ...card, json, sha256, addedAt: card.addedAt + revision * 86_400_000 }
    list[at] = next
    bySlug.set(slug, next)
    bySha.set(sha256, next)
    return next
  }
  let successorSerial = 0
  const pointSuccessor = (slug: string, target: string) => {
    const old = bySlug.get(slug)!
    const next = { ...old, supersededBy: target }
    bySlug.set(slug, next)
    bySha.set(old.sha256, next)
    const list = listOf(old)
    const at = list.findIndex((c) => c.slug === slug)
    if (at >= 0) list[at] = next
  }
  const publishSuccessor = (slug: string, site?: string) => {
    const original = bySlug.get(slug)!
    const list = listOf(original)
    const changed = publish(slug)
    const nextSlug = `${roots.get(slug) ?? slug}-successor-${++successorSerial}`
    const next = { ...changed, slug: nextSlug, site: site ?? original.site, supersededBy: undefined }
    list[list.findIndex((c) => c.slug === slug)] = original
    bySlug.set(slug, original)
    bySha.set(original.sha256, original)
    pointSuccessor(slug, nextSlug)
    list.push(next)
    bySlug.set(nextSlug, next)
    bySha.set(next.sha256, next)
    const previousKey = originKeys.get(slug)!
    const pair = next.site === original.site ? previousKey : ([next.site, externalOf(next)] as const)
    originKeys.set(nextSlug, pair)
    roots.set(nextSlug, roots.get(slug) ?? slug)
    for (const [key, head] of originHeads) if (head === slug) originHeads.set(key, nextSlug)
    originHeads.set(originKey(pair), nextSlug)
    return next
  }
  const publishFork = (slug: string) => {
    const parent = bySlug.get(slug)!
    const doc = JSON.parse(parent.json) as { data: { name: string } }
    doc.data.name += " (synthetic fork)"
    const json = JSON.stringify(doc)
    const sha256 = createHash("sha256").update(json).digest("hex")
    const fork = {
      ...parent,
      slug: `${slug}-fork-${++successorSerial}`,
      name: doc.data.name,
      json,
      sha256,
      parent: slug,
      fork: true,
      supersededBy: undefined
    }
    cards.push(fork)
    bySlug.set(fork.slug, fork)
    bySha.set(sha256, fork)
    const pair = [fork.site, externalOf(fork)] as const
    originKeys.set(fork.slug, pair)
    originHeads.set(originKey(pair), fork.slug)
    roots.set(fork.slug, fork.slug)
    return fork
  }
  const seen: Array<string> = []
  let failure: { status: number; times: number; retryAfter?: number; path?: string; sort?: string } | null = null

  let conditionalHits = 0
  let notModified = 0
  const send = (res: ServerResponse, status: number, bytes: string | Uint8Array, headers: Record<string, string>) => {
    if (status === 200 && !res.req.url?.startsWith("/__fake/")) {
      const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`
      headers.etag = etag
      if (res.req.headers["if-none-match"] === etag) {
        notModified++
        res.writeHead(304, { etag })
        return res.end()
      }
    }
    res.writeHead(status, headers)
    res.end(bytes)
  }
  const json = (res: ServerResponse, status: number, body: unknown) =>
    send(res, status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8" })
  // v1's CardSummary; its URLs are paths on the archive.
  const summary = (c: FakeCard) => ({
    slug: c.slug,
    url: `/c/${c.slug}`,
    name: c.name,
    creator: { name: c.creator, source: c.site, handle: c.creator, url: `/u/${c.site}/${c.creator}` },
    tags: c.tags,
    tagline: c.tagline,
    nsfw: c.nsfw,
    kind: c.lorebook ? "lorebook" : "character",
    token_count: c.tokens,
    stats: { popularity: c.popularity, rating_avg: 4, rating_count: 10 },
    thumbnail_url: c.hasCover ? `/t/${c.sha256}.512.webp?v=1` : null,
    image_url: c.hasCover ? `/i/${c.sha256}.png` : null,
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
    if (!["character", "lorebook", "both", "character_lorebook"].includes(kind))
      return { status: 400, body: error("bad_request", "unknown kind") }
    const sites = list(params.get("source"))
    if (sites.some((s) => !V1_SITES.includes(s))) return { status: 400, body: error("bad_request", "unknown source") }
    const notSites = list(params.get("not_source"))
    const verified = truthy(params.get("chub_verified"))
    const recommended = truthy(params.get("chub_recommended"))
    if ((verified || recommended) && (sites.length !== 1 || sites[0] !== "chub"))
      return { status: 400, body: error("bad_request", "Chub must be the only included source") }
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
    const queryHash = createHash("sha256")
      .update(JSON.stringify([cursorEpoch, normalized]))
      .digest("hex")
      .slice(0, 12)
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
    const min = Number(params.get("min_tokens") ?? "300")
    const max = Number(params.get("max_tokens") ?? "Infinity")
    const noForks = truthy(params.get("exclude_forks"))
    const semantic = mode === "semantic"
    const fields = list(params.get("fields"))
    const words = (c: FakeCard) =>
      [
        ...(!fields.length || fields.includes("name") ? [c.name] : []),
        ...(!fields.length || fields.includes("description") ? [c.tagline] : []),
        ...(!fields.length || fields.includes("character") ? [c.json] : []),
        ...(!fields.length || fields.includes("lorebook") ? [c.creator, ...c.tags] : [])
      ].some((text) => text.toLowerCase().includes(q))
    const groups = list(params.get("any_tags")).map((group) => group.split("|"))
    const identities = (name: string) =>
      (params.get(name) ?? "")
        .split(/(?<!\\),/)
        .map((v) => v.replace(/\\(.)/g, "$1").toLowerCase())
        .filter(Boolean)
    const anyAuthors = identities("any_author")
    const notAuthors = identities("not_author")
    const dateMatches = (c: FakeCard, kind: "added" | "created") => {
      const value = kind === "added" ? c.addedAt : c.createdAt
      const after = params.get(`${kind}_after`)
      const before = params.get(`${kind}_before`)
      return (!after || value >= Date.parse(after)) && (!before || value < Date.parse(before))
    }
    // Lorebooks for `lorebook`, and for `both` when the words name one (see `syntheticLorebooks`).
    const pool =
      kind === "lorebook"
        ? lorebooks
        : kind === "both" && q
          ? [...cards, ...lorebooks.filter((c) => [c.name, c.tagline].some((t) => t.toLowerCase().includes(q)))]
          : cards
    const matching = pool.filter(
      (c) =>
        // Meaning search finds something for any words; text search needs them.
        (semantic || !q || words(c)) &&
        // Live, lorebooks without a picture are listed whatever `has_cover` says.
        (!truthy(params.get("has_cover") ?? "true") || c.hasCover || c.lorebook === true) &&
        (kind !== "character_lorebook" || c.hasLorebook) &&
        !notSites.includes(c.site) &&
        groups.every((group) => group.some((tag) => c.tags.includes(tag))) &&
        (!anyAuthors.length || anyAuthors.includes(`${c.site}/${c.creator}`.toLowerCase())) &&
        !notAuthors.includes(`${c.site}/${c.creator}`.toLowerCase()) &&
        (!params.get("picture") || params.get("picture") === c.sha256) &&
        dateMatches(c, "added") &&
        dateMatches(c, "created") &&
        (!(truthy(params.get("deleted_from_source")) || truthy(params.get("deleted_from_any_source"))) || c.deleted) &&
        (!verified || c.verified) &&
        (!recommended || c.recommended) &&
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
      name_desc: (a, b) => b.name.localeCompare(a.name),
      created_desc: (a, b) => b.createdAt - a.createdAt,
      created_asc: (a, b) => a.createdAt - b.createdAt,
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
        exact_count: sorted.length,
        query: Object.fromEntries(params),
        author: null,
        author_error: null,
        results: items,
        items,
        total: options.unknownTotal && !semantic ? null : total,
        has_more: more,
        total_capped: sorted.length > reachable.length,
        total_is_estimate: estimated,
        page: Math.floor(offset / limit) + 1,
        pages: Math.ceil(reachable.length / limit),
        page_size: limit,
        tags: include,
        not_tags: exclude,
        unknown_tags: [],
        semantic: semantic ? { max_results: SEMANTIC_MAX } : null,
        defaults: { nsfw: "include", kind: "both", min_tokens: 300, has_cover: true },
        next_cursor:
          !semantic && more ? Buffer.from(`${offset + limit}.${queryHash}`, "utf8").toString("base64url") : null
      }
    }
  }

  const download = (res: ServerResponse, c: FakeCard, mode: string) => {
    if (deleted.has(c.slug)) return json(res, 404, error("not_found", "no card"))
    if (regional.has(c.slug)) return json(res, 451, error("region_unavailable", "not available here"))
    if (!capabilitiesBody.download_modes.includes(mode)) return json(res, 400, error("bad_request", "unknown mode"))
    // A CHARX original has no mirrored or self-contained file, but its JSON, as every card's.
    // These synthetic originals are themselves JSON.
    if (refused.has(c.slug)) return json(res, 403, error("download_refused", "this card can't be downloaded"))
    if (!downloadModes(c).includes(mode)) return json(res, 404, error("no_derived_download", "not in this form"))
    // A lorebook's every form is JSON; here all of them the creator's file.
    if (mode === "json" || mode === "original" || c.lorebook) {
      return send(res, 200, c.json, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${c.slug}.json"`
      })
    }
    return send(res, 200, cardPng(c), {
      "content-type": "image/png",
      "content-disposition": `attachment; filename="${c.slug}.png"`
    })
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const path = url.pathname
    if (path === "/__fake/count-cap") {
      countCap = Number(url.searchParams.get("value") ?? 100_000)
      return json(res, 200, { ok: true })
    }
    if (path === "/__fake/expire-cursors") {
      cursorEpoch++
      return json(res, 200, { ok: true })
    }
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
        ...(url.searchParams.has("path") ? { path: url.searchParams.get("path")! } : {}),
        ...(url.searchParams.has("sort") ? { sort: url.searchParams.get("sort")! } : {})
      }
      return json(res, 200, { ok: true })
    }
    if (path === "/__fake/successor") {
      const slug = url.searchParams.get("slug") ?? ""
      if (!bySlug.has(slug)) return json(res, 404, error("not_found", "no such card"))
      const next = publishSuccessor(slug, url.searchParams.get("site") ?? undefined)
      return json(res, 200, { slug: next.slug, version: next.sha256 })
    }
    if (path === "/__fake/publish") {
      const slug = url.searchParams.get("slug") ?? ""
      if (!bySlug.has(slug)) return json(res, 404, error("not_found", "no such card"))
      const next = publish(slug)
      return json(res, 200, { slug, version: next.sha256 })
    }
    seen.push(`${path}${url.search}`)
    if (req.headers["if-none-match"]) conditionalHits++
    if (
      failure &&
      failure.times > 0 &&
      (failure.path === undefined || failure.path === path) &&
      (failure.sort === undefined || failure.sort === url.searchParams.get("sort"))
    ) {
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
    if (path === "/api/v1/search/count") {
      const params = new URLSearchParams(url.searchParams)
      params.set("limit", "1")
      const result = search(params)
      if (result.status !== 200) return json(res, result.status, result.body)
      const body = result.body as { exact_count: number }
      const cap = countCap
      return json(res, 200, {
        total: Math.min(body.exact_count, cap),
        capped: body.exact_count >= cap,
        cap,
        timed_out: false
      })
    }
    if (path === "/api/v1/search") {
      const { status, body } = search(url.searchParams)
      return json(res, status, body)
    }
    if (path === "/api/v1/tags" || path === "/api/v1/search/authors") {
      const tags = path.endsWith("/tags")
      const prefix = (url.searchParams.get("q") ?? "").toLowerCase()
      const counts = new Map<string, number>()
      for (const c of cards)
        for (const value of tags ? c.tags : [`${c.site}/${c.creator}`])
          if (tags ? value.toLowerCase().startsWith(prefix) : value.toLowerCase().includes(prefix))
            counts.set(value, (counts.get(value) ?? 0) + 1)
      const all = [...counts].sort(([a], [b]) => a.localeCompare(b))
      const cursor = url.searchParams.get("cursor")
      let after = ""
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
            prefix: string
            after: string
            tags: boolean
          }
          if (decoded.prefix !== prefix || decoded.tags !== tags || typeof decoded.after !== "string") throw new Error()
          after = decoded.after
        } catch {
          return json(res, 400, error("invalid_cursor", "suggestion cursor expired"))
        }
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10)))
      const rest = all.filter(([value]) => value.localeCompare(after) > 0)
      const items = rest.slice(0, limit)
      const next =
        rest.length > limit
          ? Buffer.from(JSON.stringify({ prefix, tags, after: items.at(-1)![0] })).toString("base64url")
          : null
      return json(res, 200, {
        [tags ? "tags" : "authors"]: items.map(([value, card_count]) =>
          tags
            ? { slug: value, label: value, card_count }
            : {
                source: value.split("/")[0],
                handle: value.split("/")[1],
                display_name: value.split("/")[1],
                card_count
              }
        ),
        next,
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
          return c && !deleted.has(c.slug) ? [{ ...summary(c), file_sha256: c.sha256 }] : []
        }),
        missing: canonical.filter((id) => !bySlug.has(id))
      })
    }
    const author = /^\/api\/v1\/authors\/([^/]+)\/([^/]+)$/.exec(path)
    if (author) {
      // v1's creator profile: the creator, then a page of their cards (left as the legacy list).
      const site = decodeURIComponent(author[1]!)
      const handle = decodeURIComponent(author[2]!)
      const theirs = cards.filter((c) => c.site === site && c.creator === handle)
      if (theirs.length === 0) return json(res, 404, error("not_found", "no such author"))
      const first = theirs[0]!
      return json(res, 200, {
        author: {
          source: site,
          source_label: `Synthetic ${site}`,
          handle,
          display_name: `${handle} (synthetic)`,
          bio: handle === "lumen" ? null : `A synthetic creator who makes ${theirs.length} test cards.`,
          avatar:
            handle === "lumen" ? null : { url: `/i/${first.sha256}.png`, thumb_url: `/t/${first.sha256}.512.webp` },
          path: `/u/${site}/${handle}`,
          card_count: theirs.length,
          lorebook_count: theirs.filter((c) => c.hasLorebook).length,
          first_seen_at: new Date(Math.min(...theirs.map((c) => c.addedAt))).toISOString(),
          last_seen_at: new Date(Math.max(...theirs.map((c) => c.addedAt))).toISOString()
        },
        sort: "newest",
        page: 1,
        pages: theirs.length,
        total: theirs.length,
        page_size: 1,
        results: [],
        link_map: []
      })
    }
    const originRoute = /^\/api\/v1\/origins\/([^/]+)\/([^/]+)$/.exec(path)
    if (originRoute) {
      const site = decodeURIComponent(originRoute[1]!)
      const external = decodeURIComponent(originRoute[2]!)
      const c = byExternal(site, external)
      if (!c) return json(res, 404, error("not_found", "no current card"))
      if (regional.has(c.slug)) return json(res, 451, error("region_unavailable", "not available here"))
      return json(res, 200, {
        ...detailOf(c),
        view: { path: `/o/${site}/${external}`, canonical_path: `/c/${c.slug}`, version: null }
      })
    }
    const detail = /^\/api\/v1\/cards\/([^/]+)$/.exec(path)
    if (detail) {
      // v1's card page envelope: its `card` is the archive's record, not a summary.
      const c = bySlug.get(decodeURIComponent(detail[1]!))
      if (!c || deleted.has(c.slug)) return json(res, 404, error("not_found", "no such card"))
      return json(res, 200, detailOf(c))
    }

    const family = /^\/api\/v1\/(versions|forks)\/([^/]+)\/([^/]+)$/.exec(path)
    if (family) {
      const c = byExternal(decodeURIComponent(family[2]!), decodeURIComponent(family[3]!))
      if (!c) return json(res, 404, error("not_found", "no such origin"))
      if (family[1] === "versions") {
        const version = (v: FakeCard, current: boolean, n: number) => ({
          id: String(n),
          version: {
            slug: v.slug,
            content_hash: v.sha256,
            card_path: `/c/${v.slug}`,
            origin_path: `/o/${c.site}/${externalOf(c)}/v/${n}`,
            active_from: new Date(v.addedAt).toISOString(),
            active_to: current ? null : new Date(c.addedAt).toISOString(),
            is_current: current,
            is_viewing: false,
            meta: {
              character_version: current ? "1.0" : "0.9",
              created: null,
              modified: null,
              sources: [],
              creator: null
            }
          },
          cover_thumb_url: v.hasCover ? `/t/${v.sha256}.512.webp` : null,
          nsfw: v.nsfw,
          json_url: `/api/v1/download/${v.sha256}?mode=json`
        })
        const history = [...bySlug.values()]
          .filter((v) => roots.get(v.slug) === roots.get(c.slug))
          .sort((a, b) => b.addedAt - a.addedAt)
        return json(res, 200, {
          items: history.map((v, i) => version(v, v.slug === c.slug, history.length - i)),
          next: null
        })
      }
      const parent = c.parent ? bySlug.get(c.parent) : undefined
      const children = cards.filter((card) => card.parent === c.slug)
      return json(res, 200, {
        parent: parent ? familyEntry(parent, c) : null,
        children: children.map((child) => familyEntry(child, c)),
        next: null,
        viewed_slug: c.slug
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
        send(res, 200, bytes, {
          "content-type": thumb ? "image/webp" : "image/png",
          "cache-control": "public, max-age=31536000, immutable"
        })
      })
      return
    }
    json(res, 404, error("not_found", "no such path"))
  }

  const detailOf = (c: FakeCard) => {
    const at = cards.findIndex((card) => card.slug === c.slug)
    const forkedFrom = c.parent ? bySlug.get(c.parent) : undefined
    const children = cards.filter((card) => card.parent === c.slug)
    const pair = originKeys.get(c.slug) ?? [c.site, externalOf(c)]
    const head = byExternal(pair[0]!, pair[1]!)
    const origin = {
      source: pair[0]!,
      external_id: pair[1]!,
      path: `/o/${pair[0]}/${pair[1]}`,
      removal: null,
      serves_card: true,
      card_slug: c.slug,
      author: { source: c.site, handle: c.creator, display_name: c.creator, path: `/u/${c.site}/${c.creator}` },
      name: c.name,
      tagline: c.tagline,
      tags: c.tags,
      fork: {
        parent_known: forkedFrom !== undefined,
        is_fork: c.fork,
        forked_from: forkedFrom
          ? { source: forkedFrom.site, external_id: externalOf(forkedFrom), card_slug: forkedFrom.slug }
          : null,
        child_count: children.length,
        children: []
      }
    }
    // An earlier listing of the card's, which the archive now files under a card further on.
    const next = cards[(at + 7) % cards.length]!
    return {
      card: {
        slug: c.slug,
        kind: c.lorebook ? "lorebook" : "character",
        nsfw: c.nsfw,
        tags: c.tags,
        path: `/c/${c.slug}`,
        content_hash: c.sha256,
        token_counts: {
          model: "o200k_base",
          fields: { description: 40, personality: 9, scenario: 12, creator_notes: 7 },
          mes_example: 0,
          greetings: [18, 15],
          permanent: 61,
          total_budget_estimate: c.tokens
        }
      },
      creator: summary(c).creator,
      files: [
        {
          sha256: c.sha256,
          ...(c.lorebook ? { kind: "json_lorebook", mime: "application/json" } : {}),
          ext: c.originalOnly ? "charx" : "json",
          is_original: true,
          current: true,
          url: `/i/${c.sha256}.png`,
          ...(options.omitDownloadModes ? {} : { download_modes: downloadModes(c) })
        }
      ],
      origins: noOrigins.has(c.slug) || head?.slug !== c.slug ? [] : [origin],
      main_origin: noOrigins.has(c.slug) || head?.slug !== c.slug ? null : { source: pair[0], path: origin.path },
      top: { name: { value: c.name, from: null } },
      earlier_origins: noOrigins.has(c.slug)
        ? []
        : c.lorebook && head?.slug === c.slug
          ? []
          : head?.slug !== c.slug
            ? [
                {
                  origin: {
                    source: pair[0],
                    external_id: pair[1],
                    path: origin.path,
                    card_slug: head?.slug ?? c.supersededBy
                  },
                  listing: { ...origin, card_slug: head?.slug ?? c.supersededBy },
                  active_from: new Date(c.addedAt).toISOString(),
                  active_to: new Date(c.addedAt + 1).toISOString()
                }
              ]
            : [
                {
                  listing: {
                    source: c.site,
                    source_label: "Synthetic site",
                    external_id: `previous-${c.slug}`,
                    path: `/o/${c.site}/previous-${c.slug}`,
                    source_url: "https://synthetic.example/previous"
                  },
                  origin: {
                    source: c.site,
                    external_id: `previous-${c.slug}`,
                    path: `/o/${c.site}/previous-${c.slug}`,
                    card_slug: next.slug
                  },
                  active_from: "2025-01-01T00:00:00Z",
                  active_to: "2026-01-01T00:00:00Z"
                }
              ],
      related: [],
      variants: []
    }
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    host: `127.0.0.1:${port}`,
    cards,
    lorebooks,
    conditionalHits: () => conditionalHits,
    notModified: () => notModified,
    hits: () => seen.length,
    paths: () => [...seen],
    reset: () => {
      seen.length = 0
      failure = null
    },
    failSort: (sort, status, times = 1, retryAfterSeconds) => {
      failure = {
        status,
        times,
        sort,
        path: "/api/v1/search",
        ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds })
      }
    },
    failNext: (status, times = 1, retryAfterSeconds) => {
      failure = { status, times, ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds }) }
    },
    publish,
    publishSuccessor,
    publishFork,
    pointSuccessor,
    withoutOrigins: (slug) => void noOrigins.add(slug),
    deleteCard: (slug) => void deleted.add(slug),
    blockRegion: (slug) => void regional.add(slug),
    refuseDownloads: (slug) => void refused.add(slug),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
