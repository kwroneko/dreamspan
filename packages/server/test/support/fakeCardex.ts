// A fake of cardex, the third-party public card archive (spec/CARD-SOURCES.md §10): an
// in-process HTTP server that answers the API v1 requests the cardex adapter
// (`src/sources/cardex.ts`) makes, with our own synthetic cards, so the real adapter runs
// against it unchanged, pointed at its origin.
//
// Every response is built from the captures of the live API in `test/fixtures/cardex/` (see
// its README): the capabilities description is served exactly as captured, each error is the
// captured status, code and message for that misuse, and every other body starts from a
// captured one and only has its values replaced (`fill` refuses a field the capture doesn't
// have), so what the fake sends is what cardex sends. `cardexContract.test.ts` checks that the
// fake still has every field, header and kind of value of each capture.
//
// The synthetic archive: characters with tags, sites, creators (most with an account, some
// only named, some with none), ratings, token counts, covers, lorebooks, forks and earlier
// versions; standalone lorebooks (`kind: "lorebook"`, a World Info JSON in every download
// mode), listed for `kind=lorebook` and beside cards when the words name one. Searches page
// by cursor in text mode (a cursor of another query is refused with `invalid_cursor`) and by
// page number in semantic mode (240 at most), with no total in text mode, as live, and
// `/search/count` for the count. Tests steer it with the methods below and `/__fake/*`, and
// count what reaches it, so they can check that nothing is sent before the user asks (§5.1).
// No archive's real cards, names or images are used anywhere.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import sharp from "sharp"
import type { CardSourceAdapter } from "../../src/sources/adapter.ts"
import { cardexAdapter } from "../../src/sources/cardex.ts"
import { responseKind, unionOf } from "../fixtures/cardex/synthesize.ts"

// --- The captures.

interface Capture {
  readonly name: string
  readonly request: { readonly path: string; readonly query: Record<string, string> }
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: unknown
}

const FIXTURES = fileURLToPath(new URL("../fixtures/cardex/", import.meta.url))
const captures = new Map(
  readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const capture = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Capture
      return [capture.name, capture] as const
    })
)
const capture = (name: string) => {
  const found = captures.get(name)
  if (!found) throw new Error(`no cardex capture named ${name}`)
  return found
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the captured JSON has no static type
type Json = Record<string, any>
/** A captured body, to fill in. */
const template = (name: string, at: (body: Json) => unknown = (b) => b): Json =>
  structuredClone(at(capture(name).body as Json)) as Json

const unions = new Map<string, Json>()
/**
 * Every capture of a kind of response (every search, every card page) as one body, with every
 * field any of them has: what the fake fills in where it sends that kind.
 */
const full = (name: string, at: (body: Json) => unknown = (b) => b): Json => {
  const kind = responseKind(name)
  let union = unions.get(kind)
  if (!union) {
    union = unionOf(
      [...captures.values()]
        .filter((c) => responseKind(c.name) === kind && c.status < 300 && c.body !== undefined)
        .map((c) => c.body)
    ) as Json
    unions.set(kind, union)
  }
  return structuredClone(at(union)) as Json
}
const pathIn = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, key) => (v === null || v === undefined ? undefined : (v as Json)[key]), value)
/** A part of a card page, as all the captured card pages together have it. */
const sample = (path: string, _first?: string): Json => {
  const value = pathIn(full("card-character"), path)
  if (value === null || value === undefined) throw new Error(`no captured card page has ${path}`)
  return value as Json
}

/**
 * The template with these fields replaced, in the template's order. A field the template
 * hasn't got is an error: the fake can't send what cardex doesn't.
 */
const fill = (base: Json, values: Json): Json => {
  for (const key of Object.keys(values))
    if (!(key in base)) throw new Error(`cardex sends no "${key}" here (have ${Object.keys(base).join(", ")})`)
  return { ...base, ...values }
}

/** A captured error, for the misuse it answers. */
const capturedError = (name: string) => {
  const { status, body } = capture(name)
  return { status, body }
}

/** The capabilities description, as captured. */
const capabilities = capture("capabilities").body as {
  filters: Array<{ name: string; allowed_values: Array<string>; default: unknown }>
  sorts: Array<string>
  download_modes: Array<string>
  modes: Array<{ name: string; max_results: number }>
  page_size: { min: number; max: number; default: number; max_results: number; count_cap: number }
}
const allowed = (name: string) => capabilities.filters.find((f) => f.name === name)?.allowed_values ?? []
const SITES = allowed("source")
const SORTS = capabilities.sorts
const DOWNLOAD_MODES = capabilities.download_modes
const MAX_RESULTS = capabilities.page_size.max_results
const SEMANTIC_MAX = capabilities.modes.find((m) => m.name === "semantic")?.max_results ?? 240
const PAGE_DEFAULT = capabilities.page_size.default
const DEFAULT_MIN_TOKENS = Number(capabilities.filters.find((f) => f.name === "min_tokens")?.default ?? 300)
/** The label cardex gives each site (its capabilities' `allowed_value_labels`). */
export const SITE_LABELS: Record<string, string> = Object.fromEntries(
  (
    (
      capabilities.filters.find((f) => f.name === "source") as {
        allowed_value_labels?: Array<{ value: string; label: string }>
      }
    )?.allowed_value_labels ?? []
  ).map((v) => [v.value, v.label])
)

/** The headers cardex sends with a capture's kind of response, the ETag aside (the fake computes its own). */
const headersOf = (name: string): Record<string, string> => {
  const { etag: _etag, "content-disposition": _disposition, ...rest } = capture(name).headers
  return rest
}

// --- The synthetic archive.

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
/** Sites the synthetic cards were found on (all of them in cardex's list). */
const CARD_SITES = ["chub", "risuai", "char_tavern", "generic"]
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
const LORE_NOUNS = ["Gazetteer", "Almanac", "Atlas", "Bestiary"]
const LORE_CREATORS = ["inkmap", "atlas_hand"]
const LORE_TAGS = ["worldbuilding", "places", "factions", "creatures"]

/** How cardex knows a card's creator: an account on its site, only a name, or not at all. */
type CreatorKind = "account" | "named" | "none"

interface FakeCard {
  readonly slug: string
  readonly name: string
  readonly creator: string
  readonly creatorKind: CreatorKind
  /** The site it was found on. */
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
  /** Removed from its site. */
  readonly deleted: boolean
  readonly verified: boolean
  readonly recommended: boolean
  /** Made from another card on its site (`exclude_forks` leaves these out). */
  readonly fork: boolean
  /** Its original is a CHARX, as some on cardex are: no mirrored or self-contained file, only its JSON. */
  readonly originalOnly: boolean
  readonly json: string
  readonly sha256: string
  readonly color: readonly [number, number, number]
  readonly supersededBy?: string | undefined
  /** The card it was forked from on its site. */
  readonly parent?: string
  /** An earlier version, a card of its own under a slug of its own, not in searches. */
  readonly older?: boolean
  /** A standalone lorebook: its file a World Info JSON, not a card. */
  readonly lorebook?: boolean
}

const slugOf = (name: string, sha256: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sha256.slice(0, 8)}`
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")

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

/** Standalone lorebooks, with names, creators and tags of their own, so a card search lists none of them. */
const syntheticLorebooks = (count: number): Array<FakeCard> =>
  Array.from({ length: count }, (_, n): FakeCard => {
    const name = `${ADJECTIVES[n % ADJECTIVES.length]} ${LORE_NOUNS[n % LORE_NOUNS.length]}`
    const tags = [LORE_TAGS[n % LORE_TAGS.length]!, LORE_TAGS[(n + 1) % LORE_TAGS.length]!]
    const json = worldInfoJson(name, [
      ["harbor", `The harbor of ${name} opens at dawn.`],
      ["tower", `A tower of ${name} keeps the old maps.`]
    ])
    const sha256 = sha(json)
    return {
      slug: slugOf(name, sha256),
      name,
      creator: LORE_CREATORS[n % LORE_CREATORS.length]!,
      creatorKind: "account",
      site: CARD_SITES[n % CARD_SITES.length]!,
      tags,
      tagline: `A ${tags[0]} lorebook of ${LORE_NOUNS[n % LORE_NOUNS.length]!.toLowerCase()} entries.`,
      nsfw: false,
      tokens: 600 + n * 50,
      popularity: 500 + n,
      addedAt: Date.UTC(2026, 1, 1) + n * 3_600_000,
      // Lorebooks on cardex have no picture.
      hasCover: false,
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

const syntheticCards = (count: number): Array<FakeCard> => {
  const random = sequence(20261107)
  const cards: Array<FakeCard> = []
  for (let n = 0; n < count; n++) {
    const noun = NOUNS[Math.floor(n / ADJECTIVES.length) % NOUNS.length]!
    const name = `${ADJECTIVES[n % ADJECTIVES.length]} ${noun}${n >= 320 ? ` ${n}` : ""}`
    const creator = CREATORS[Math.floor(random() * CREATORS.length)]!
    const tags = [
      ...new Set(Array.from({ length: 2 + Math.floor(random() * 4) }, () => TAGS[Math.floor(random() * TAGS.length)]!))
    ]
    const nsfw = random() < 0.15
    const hasLorebook = random() < 0.3
    const description = `${name} is a synthetic character made for testing, who enjoys ${tags.join(" and ")} stories.`
    const doc = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description,
        personality: "Curious, patient, a little dry.",
        scenario: `A quiet afternoon in a ${tags[0]} setting.`,
        first_mes: `*${name} looks up from a stack of notes.* "Oh, hello. I wasn't expecting anyone today."`,
        // Every fourth card has a nickname and example dialogue.
        ...(n % 4 === 1 ? { nickname: name.split(" ")[0]! } : {}),
        mes_example: n % 4 === 1 ? `<START>\n{{user}}: Hello there.\n{{char}}: "Hello yourself," ${name} says.` : "",
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
    const sha256 = sha(json)
    cards.push({
      slug: slugOf(name, sha256),
      name,
      creator,
      // Most of cardex's creators have an account on their site; some are only a name in the
      // card, and some cards name none.
      creatorKind: n % 29 === 17 ? "none" : n % 13 === 6 ? "named" : "account",
      site: CARD_SITES[n % CARD_SITES.length]!,
      tags,
      tagline: `A ${tags[0]} ${noun.toLowerCase()} for quiet scenes.`,
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
      fork: n % 5 === 3,
      originalOnly: n % 40 === 7,
      json,
      sha256,
      color: hsl((n * 47) % 360)
    })
  }
  return cards
}

// --- Pictures: a portrait in one colour with a lighter band, enough to tell tiles apart.

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
const COVER = { width: 512, height: 768 }
const portraitPng = (color: readonly [number, number, number]) => {
  const { width, height } = COVER
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
/** A card PNG: its portrait with the card's JSON in a `chara` text chunk, as card PNGs carry it. */
const cardPng = (color: readonly [number, number, number], json: string) => {
  const png = portraitPng(color)
  const text = Buffer.concat([Buffer.from("chara\0", "latin1"), Buffer.from(Buffer.from(json).toString("base64"))])
  return Buffer.concat([png.subarray(0, png.length - 12), chunk("tEXt", text), png.subarray(png.length - 12)])
}

// --- The fake.

export interface FakeCardexOptions {
  readonly port?: number
  readonly cards?: number
  /** What `/search/count` counts up to (cardex's `count_cap`). */
  readonly countCap?: number
  /** Some characters without a cover. */
  readonly coverless?: boolean
  /** Leave `download_modes` out, as a response cached from before cardex listed them. */
  readonly omitDownloadModes?: boolean
  /** How many standalone lorebooks it has (12 by default). */
  readonly lorebooks?: number
}

export interface FakeCardex {
  readonly origin: string
  readonly host: string
  readonly cards: ReadonlyArray<FakeCard>
  readonly lorebooks: ReadonlyArray<FakeCard>
  readonly conditionalHits: () => number
  readonly notModified: () => number
  /** Requests received, all together, and by path. */
  readonly hits: () => number
  readonly paths: () => ReadonlyArray<string>
  readonly reset: () => void
  /** The next `times` searches with this sort get this status (and `Retry-After`). */
  readonly failSort: (sort: string, status: number, times?: number, retryAfterSeconds?: number) => void
  /** The next `times` requests get this status (and `Retry-After`), as a failing archive would answer. */
  readonly failNext: (status: number, times?: number, retryAfterSeconds?: number) => void
  /** The card's author publishes a newer version under the same slug: a changed description, the next `character_version`. */
  readonly publish: (slug: string) => FakeCard
  /** A newer version under a new slug, on the same listing (or on `site`), the old one superseded. */
  readonly publishSuccessor: (slug: string, site?: string) => FakeCard
  readonly publishFork: (slug: string) => FakeCard
  readonly pointSuccessor: (slug: string, target: string) => void
  readonly withoutOrigins: (slug: string) => void
  readonly deleteCard: (slug: string) => void
  readonly blockRegion: (slug: string) => void
  /** From now on cardex refuses downloads of this card: no `download_modes`, 403 on a try. */
  readonly refuseDownloads: (slug: string) => void
  readonly close: () => Promise<void>
}

/** The real cardex adapter, pointed at the fake: what tests and the development instance register. */
export const fakeCardexAdapter = (archive: Pick<FakeCardex, "origin">): CardSourceAdapter =>
  cardexAdapter({ origin: archive.origin })

/** An error in cardex's envelope, for a misuse no capture shows. */
const error = (code: string, message: string) => ({ error: code, message })
const NOT_FOUND = () => capturedError("card-missing")

const iso = (ms: number) => new Date(ms).toISOString()

export const startFakeCardex = async (options: FakeCardexOptions = {}): Promise<FakeCardex> => {
  const generated = syntheticCards(options.cards ?? 240)
  const cards = generated.map((card, n): FakeCard => ({
    ...card,
    hasCover: options.coverless ? n % 3 !== 0 : true,
    // A fork was made from the card before it, on the same site.
    ...(card.fork && n > 0 ? { parent: generated[n - 1]!.slug } : {})
  }))
  // Every sixth card has an earlier version: a card of its own, which searches don't list.
  const olderVersions = cards.flatMap((card, n): Array<FakeCard> => {
    if (n % 6 !== 1) return []
    const doc = JSON.parse(card.json) as { data: { description: string; character_version: string } }
    doc.data.description = `${doc.data.description} (An earlier draft.)`
    doc.data.character_version = "0.9"
    const json = JSON.stringify(doc)
    return [
      {
        ...card,
        slug: `${card.slug}-v09`,
        json,
        sha256: sha(json),
        addedAt: card.addedAt - 30 * 86_400_000,
        older: true,
        supersededBy: card.slug
      }
    ]
  })
  const lorebooks = syntheticLorebooks(options.lorebooks ?? 12)
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
      sha256: sha(json),
      addedAt: book.addedAt - 30 * 86_400_000,
      older: true,
      supersededBy: book.slug
    })
  }
  const listOf = (c: FakeCard) => (c.lorebook ? lorebooks : cards)
  let countCap = options.countCap ?? capabilities.page_size.count_cap
  let cursorEpoch = 0
  const bySlug = new Map([...cards, ...lorebooks, ...olderVersions].map((c) => [c.slug, c]))
  const bySha = new Map([...cards, ...lorebooks, ...olderVersions].map((c) => [c.sha256, c]))
  /** A card's listing on its site (an origin's external id). */
  const externalOf = (c: FakeCard) => `ext-${c.slug}`
  const originKeys = new Map<string, readonly [string, string]>()
  const originHeads = new Map<string, string>()
  const roots = new Map<string, string>()
  const deleted = new Set<string>()
  const regional = new Set<string>()
  const noOrigins = new Set<string>()
  const refused = new Set<string>()
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
  const childrenOf = (c: FakeCard) => cards.filter((card) => card.parent === c.slug)

  // --- Pieces of the responses, each from its capture.

  const thumbOf = (c: FakeCard) => (c.hasCover ? `/t/${c.sha256}.512.webp?v=1` : null)
  const imageOf = (c: FakeCard) => (c.hasCover ? `/i/${c.sha256}.png` : null)
  const creatorPath = (c: FakeCard) => `/u/${c.site}/${c.creator}`
  const downloadModes = (c: FakeCard) =>
    refused.has(c.slug) ? [] : c.originalOnly ? ["json", "original"] : [...DOWNLOAD_MODES]
  const tagObject = (tag: string) => ({ slug: tag, label: tag })

  /** v1's `CardSummary` (search `items`, batch items). */
  const summary = (c: FakeCard, base = full("search-default", (b) => b.items[0])) => {
    const { download_modes: _modes, ...rest } = base
    const out = fill(options.omitDownloadModes ? rest : base, {
      slug: c.slug,
      url: `/c/${c.slug}`,
      name: c.name,
      creator: fill(base.creator, {
        name: c.creatorKind === "none" ? null : c.creator,
        source: c.creatorKind === "account" ? c.site : null,
        handle: c.creatorKind === "account" ? c.creator : null,
        url: c.creatorKind === "account" ? creatorPath(c) : null
      }),
      tags: [...c.tags],
      tagline: c.tagline,
      nsfw: c.nsfw,
      kind: c.lorebook ? "lorebook" : "character",
      token_count: c.tokens,
      stats: fill(base.stats, { popularity: c.popularity }),
      thumbnail_url: thumbOf(c),
      image_url: imageOf(c),
      version: c.sha256,
      updated_at: iso(c.addedAt),
      superseded_by: c.supersededBy ?? null,
      ...(options.omitDownloadModes ? {} : { download_modes: downloadModes(c) })
    })
    return out
  }
  /** The creator as cardex's search results and pages show it; null for a card that names none. */
  /** A creator's picture: their first card's cover (none for "lumen", or a creator without an account). */
  const avatarOf = (c: FakeCard) => {
    if (c.creatorKind !== "account" || c.creator === "lumen") return null
    const first = cards.find((card) => card.site === c.site && card.creator === c.creator && card.hasCover)
    return first ? { url: imageOf(first)!, thumb: thumbOf(first)! } : null
  }
  const resultCreator = (c: FakeCard, base: Json) => {
    if (c.creatorKind === "none") return null
    // "graywind" also made the card under another name on another site: cardex lists both.
    const other = c.creator === "graywind" && base.others_list?.[0]
    return fill(base, {
      kind: c.creatorKind,
      name: c.creator,
      path: c.creatorKind === "account" ? creatorPath(c) : null,
      source: c.creatorKind === "account" ? c.site : null,
      avatar_url: avatarOf(c)?.thumb ?? null,
      avatar_nsfw: false,
      others: other ? 1 : 0,
      others_list: other
        ? [
            fill(other, {
              name: "graywind_alt",
              path: "/u/generic/graywind_alt",
              source: "generic",
              avatar_url: thumbOf(c),
              avatar_nsfw: false,
              variant_count: 1,
              card_path: `/c/${c.slug}`
            })
          ]
        : []
    })
  }
  const CREATOR_TEMPLATE = () => full("search-default", (b) => b.results[0].creator)
  /** v1's search `results` entry: the card as cardex's own pages list it. */
  const result = (c: FakeCard) => {
    const base = full("search-default", (b) => b.results[0])
    const topTag = base.top_tags[0] as Json
    return fill(base, {
      all_origins_removed: deleted.has(c.slug) || c.deleted,
      slug: c.slug,
      path: `/c/${c.slug}`,
      name: c.name,
      tagline: c.tagline,
      thumb_url: thumbOf(c),
      cover_w: c.hasCover ? COVER.width : null,
      cover_h: c.hasCover ? COVER.height : null,
      nsfw: c.nsfw,
      kind: c.lorebook ? "lorebook" : "character",
      sources: [c.site],
      top_tags: c.tags
        .slice(0, 6)
        .map((tag, n) => (n === 0 ? fill(topTag, { ...tagObject(tag), shortlist_display: "female" }) : tagObject(tag))),
      search_tags: c.tags.map(tagObject),
      tag_count: c.tags.length,
      token_budget: c.tokens,
      fork_count: childrenOf(c).length,
      first_seen_at: iso(c.addedAt),
      // Every seventeenth card is also listed elsewhere: cardex groups the listings.
      group:
        cards.indexOf(c) % 17 === 5
          ? fill(
              full("search-default", (b) => b.results[0].group),
              {
                key: c.sha256.slice(0, 16),
                others: 1,
                other_listings: 1,
                other_listing_source: "risuai"
              }
            )
          : null,
      creator: resultCreator(c, base.creator ?? CREATOR_TEMPLATE())
    })
  }

  /** An origin's short reference (`earlier_origins[].origin`, `fork.forked_from`). */
  const originRef = (site: string, external: string, cardSlug: string) => ({
    source: site,
    external_id: external,
    path: `/o/${site}/${external}`,
    card_slug: cardSlug
  })
  /** One version of an origin (detail `origins[].versions`, `/versions` items' `version`). */
  const versionEntry = (base: Json, v: FakeCard, head: FakeCard, n: number, current: boolean, viewed: FakeCard) =>
    fill(base, {
      slug: v.slug,
      content_hash: v.sha256,
      card_path: `/c/${v.slug}`,
      origin_path: `/o/${head.site}/${externalOf(head)}/v/${n}`,
      active_from: iso(v.addedAt),
      active_to: current ? null : iso(head.addedAt),
      is_current: current,
      is_viewing: v.slug === viewed.slug,
      meta: fill(base.meta, {
        character_version: v.lorebook ? null : v.older ? "0.9" : "1.0",
        created: null,
        modified: null,
        sources: [],
        creator: null
      })
    })
  /** A listing's versions, newest first. */
  const historyOf = (c: FakeCard) =>
    [...bySlug.values()].filter((v) => roots.get(v.slug) === roots.get(c.slug)).sort((a, b) => b.addedAt - a.addedAt)
  /** v1's listing of a card on a site (detail `origins[]`, `earlier_origins[].listing`). */
  const listing = (base: Json, c: FakeCard, pair: readonly [string, string], servesCard: boolean, cardSlug: string) => {
    const forkedFrom = c.parent ? bySlug.get(c.parent) : undefined
    const history = historyOf(c)
    const versionBase = sample("origins.0.versions.0")
    return fill(base, {
      removal: null,
      source: pair[0],
      source_label: SITE_LABELS[pair[0]] ?? pair[0],
      external_id: pair[1],
      path: `/o/${pair[0]}/${pair[1]}`,
      api_path: `/api/v1/origins/${pair[0]}/${encodeURIComponent(pair[1])}`,
      source_url: `https://${pair[0]}.example/${pair[1]}`,
      serves_card: servesCard,
      card_slug: cardSlug,
      author:
        c.creatorKind === "account"
          ? fill(sample("origins.0.author"), {
              source: c.site,
              handle: c.creator,
              display_name: c.creator,
              avatar: avatarOf(c)
                ? fill(sample("top.cover.image"), {
                    url: avatarOf(c)!.url,
                    thumb_url: avatarOf(c)!.thumb,
                    width: COVER.width,
                    height: COVER.height,
                    animated: false
                  })
                : null,
              path: creatorPath(c)
            })
          : null,
      name: c.name,
      tagline: c.tagline,
      description: c.lorebook ? `${c.name}, a synthetic lorebook.` : null,
      tags: [...c.tags],
      cover: c.hasCover
        ? fill(sample("origins.0.cover"), {
            url: imageOf(c),
            thumb_url: thumbOf(c),
            width: COVER.width,
            height: COVER.height,
            animated: false
          })
        : null,
      source_created_at: iso(c.createdAt),
      first_seen_at: iso(c.addedAt),
      fork: fill(sample("origins.0.fork"), {
        parent_known: forkedFrom !== undefined,
        is_fork: c.fork,
        forked_from_external_id: forkedFrom ? externalOf(forkedFrom) : null,
        forked_from: forkedFrom ? originRef(forkedFrom.site, externalOf(forkedFrom), forkedFrom.slug) : null,
        child_count: childrenOf(c).length,
        children: []
      }),
      versions: history.map((v, i) => versionEntry(versionBase, v, c, history.length - i, i === 0, c)),
      version_count: history.length
    })
  }
  const sourceBuilt = (c: FakeCard) => !c.lorebook && cards.indexOf(c) % 9 === 4
  /** v1's card envelope (`/cards/<slug>`, and `/origins/<site>/<id>` with its `view`). */
  const detailOf = (c: FakeCard, arrival: "canonical" | "origin" = "canonical") => {
    const kind = c.lorebook ? "card-lorebook" : c.hasLorebook ? "card-character-lorebook" : "card-character"
    const base = full(kind)
    const part = (path: string) => sample(path, kind)
    const at = cards.findIndex((card) => card.slug === c.slug)
    const doc = JSON.parse(c.json) as Json
    const data = (c.lorebook ? {} : doc.data) as Json
    const pair = originKeys.get(c.slug) ?? ([c.site, externalOf(c)] as const)
    const head = byExternal(pair[0], pair[1])
    const serves = !noOrigins.has(c.slug) && head?.slug === c.slug
    const originBase = part("origins.0")
    const origin = listing(originBase, c, pair, true, c.slug)
    const fileBase = part("files.0")
    const neighbour = cards[(at + 7 + cards.length) % cards.length] ?? c
    const book = (c.lorebook ? JSON.parse(c.json) : data.character_book) as Json | undefined
    const bookEntries: Array<Json> = book
      ? Array.isArray(book.entries)
        ? book.entries
        : Object.values(book.entries ?? {})
      : []
    const entryBase = sample("lorebook.entries.0", "card-lorebook")
    // An earlier listing of the card's: for a superseded one, its own listing, which now
    // serves the card further on; for a current one, a listing that now serves another card.
    const earlier = noOrigins.has(c.slug)
      ? []
      : !serves
        ? [
            {
              listing: listing(originBase, c, pair, false, head?.slug ?? c.supersededBy ?? c.slug),
              origin: originRef(pair[0], pair[1], head?.slug ?? c.supersededBy ?? c.slug),
              from: c.addedAt,
              to: c.addedAt + 1
            }
          ]
        : c.lorebook
          ? []
          : [
              {
                listing: listing(originBase, c, [c.site, `previous-${c.slug}`], false, neighbour.slug),
                origin: originRef(c.site, `previous-${c.slug}`, neighbour.slug),
                from: Date.UTC(2025, 0, 1),
                to: Date.UTC(2026, 0, 1)
              }
            ]
    const coverImage = c.hasCover
      ? fill(part("top.cover.image"), {
          url: imageOf(c),
          thumb_url: thumbOf(c),
          width: COVER.width,
          height: COVER.height,
          animated: false
        })
      : null
    const relative = (rel: Json, other: FakeCard) =>
      fill(rel, {
        slug: other.slug,
        path: `/c/${other.slug}`,
        name: other.name,
        nsfw: other.nsfw,
        thumb_url: thumbOf(other),
        ...("creator" in rel ? { creator: resultCreator(other, rel.creator ?? CREATOR_TEMPLATE()) } : {}),
        ...("origins" in rel
          ? {
              origins: [
                fill(rel.origins[0], {
                  removal: null,
                  source: other.site,
                  external_id: externalOf(other),
                  path: `/o/${other.site}/${externalOf(other)}`,
                  is_fork: other.fork
                })
              ]
            }
          : {})
      })
    const variants = c.lorebook ? [] : (part("variants") as unknown as Array<Json>).slice(0, 2)
    const related = c.lorebook ? [] : (part("related") as unknown as Array<Json>).slice(0, 1)
    return fill(base, {
      card: fill(part("card"), {
        all_origins_removed: c.deleted,
        slug: c.slug,
        content_hash: c.sha256,
        kind: c.lorebook ? "lorebook" : "character",
        path: `/c/${c.slug}`,
        hidden: false,
        nsfw: c.nsfw,
        content_warnings: c.nsfw ? part("card.content_warnings") : [],
        token_counts: fill(part("card.token_counts"), {
          model: "o200k_base",
          fields: c.lorebook
            ? { description: 20 }
            : { description: 40, personality: 9, scenario: 12, creator_notes: 7 },
          mes_example: 0,
          greetings: c.lorebook ? [] : [18, 15],
          permanent: 61,
          total_budget_estimate: c.tokens
        }),
        token_budget: c.tokens,
        fork_count: childrenOf(c).length,
        first_seen_at: iso(c.addedAt),
        tags: c.tags.map(tagObject)
      }),
      estimated_creation: fill(part("estimated_creation"), {
        at: iso(c.createdAt),
        kind: "site_created",
        source: c.site,
        board: null
      }),
      view: fill(part("view"), {
        arrival,
        path: arrival === "origin" ? origin.path : `/c/${c.slug}`,
        canonical_path: `/c/${c.slug}`,
        version: null,
        default_tab: origin.path
      }),
      top: fill(part("top"), {
        // A fork's page takes its name, description and cover from its own listing.
        name: fill(part("top.name"), { value: c.name, from: c.fork ? c.site : null }),
        tagline: fill(part("top.tagline"), { value: c.tagline, from: c.site, origin_path: origin.path }),
        description: fill(part("top.description"), {
          value: c.lorebook ? origin.description : data.description,
          from: c.fork ? c.site : null,
          ai_summary: false
        }),
        creator: fill(part("top.creator"), { value: c.creator, from: c.creatorKind === "account" ? c.site : null }),
        cover: coverImage ? fill(part("top.cover"), { image: coverImage, from: c.fork ? c.site : null }) : null,
        tags: c.tags.map(tagObject)
      }),
      definition: fill(part("definition"), {
        name: c.lorebook ? c.name : data.name,
        nickname: typeof data.nickname === "string" ? data.nickname : null,
        description: c.lorebook ? origin.description : data.description,
        personality: data.personality || null,
        scenario: data.scenario || null,
        first_mes: data.first_mes || null,
        alternate_greetings: data.alternate_greetings ?? [],
        mes_example: data.mes_example || null,
        creator_notes: data.creator_notes || null,
        system_prompt: null,
        post_history_instructions: null,
        depth_prompt: null,
        book: book
          ? fill(sample("definition.book", "card-lorebook"), {
              name: book.name ?? c.name,
              description: book.description ?? "",
              scan_depth: 4,
              token_budget: 2048,
              recursive_scanning: false,
              entry_count: bookEntries.length
            })
          : null
      }),
      lorebook: fill(part("lorebook"), {
        total: bookEntries.length,
        offset: 0,
        entries: bookEntries.map((entry, n) =>
          fill(entryBase, {
            order_idx: n,
            name: entry.comment ?? entry.name ?? `entry ${n}`,
            keys: entry.keys ?? entry.key ?? [],
            secondary_keys: entry.secondary_keys ?? entry.keysecondary ?? [],
            content: entry.content,
            enabled: entry.enabled ?? !entry.disable,
            constant: entry.constant ?? false,
            selective: entry.selective ?? false,
            insertion_order: entry.insertion_order ?? entry.order ?? 100
          })
        )
      }),
      files: [
        fill(fileBase, {
          sha256: c.sha256,
          ext: c.originalOnly ? "charx" : c.lorebook ? "json" : "png",
          mime: c.originalOnly ? "application/x-charx" : c.lorebook ? "application/json" : "image/png",
          kind: c.lorebook ? "json_lorebook" : c.originalOnly ? "charx" : "png_card",
          spec_version: c.lorebook ? null : "2.0",
          // Every ninth card's file cardex built from the site's data, as it does where the
          // site offers no file of its own: not an original, though it is the current one.
          is_original: !sourceBuilt(c),
          provenance: sourceBuilt(c) ? "source_build" : "original",
          hidden: false,
          first_seen_at: iso(c.addedAt),
          url: `/i/${c.sha256}.${c.lorebook ? "json" : "png"}`,
          thumb_url: c.lorebook ? null : thumbOf(c),
          width: c.lorebook || c.originalOnly ? null : COVER.width,
          height: c.lorebook || c.originalOnly ? null : COVER.height,
          downloads: fill(fileBase.downloads, {
            original: `/api/v1/download/${c.sha256}?mode=original`,
            json: `/api/v1/download/${c.sha256}?mode=json`,
            mirrored: `/api/v1/download/${c.sha256}`,
            self_contained: `/api/v1/download/${c.sha256}?mode=self-contained`
          }),
          ...(options.omitDownloadModes ? {} : { download_modes: downloadModes(c) }),
          current: true,
          meta: fill(fileBase.meta, {
            character_version: c.lorebook ? null : c.older ? "0.9" : "1.0",
            created: null,
            modified: null,
            sources: [],
            creator: c.lorebook ? null : c.creator
          })
        })
      ],
      file_count: 1,
      origins: serves ? [origin] : [],
      earlier_origins: earlier.map((e) =>
        fill(
          template("card-character", () => ({ listing: null, origin: null, active_from: null, active_to: null })),
          {
            listing: e.listing,
            origin: e.origin,
            active_from: iso(e.from),
            active_to: iso(e.to)
          }
        )
      ),
      variants: variants.map((v, n) => relative(v, cards[(at + n + 1 + cards.length) % cards.length] ?? c)),
      gallery: c.hasCover
        ? [
            fill(part("gallery.0"), {
              image: coverImage,
              is_cover: true,
              sources: [c.site],
              copies: 1,
              sharing: { count: 1, search_path: `/search?picture=${c.sha256}` }
            })
          ]
        : [],
      sharing: c.hasCover ? { count: 1, search_path: `/search?picture=${c.sha256}` } : null,
      related: related.map((r) => relative(r, neighbour)),
      og: fill(part("og"), {
        attribution: `${c.name} on cardex`,
        title: c.name,
        description: c.tagline,
        image_url: c.hasCover ? `${originOf()}${thumbOf(c)}` : null,
        twitter_card: c.hasCover ? "summary_large_image" : "summary",
        canonical_url: `${originOf()}/c/${c.slug}`
      }),
      main_origin: serves
        ? fill(part("main_origin"), {
            source: pair[0],
            source_label: SITE_LABELS[pair[0]] ?? pair[0],
            path: origin.path,
            uploader: c.creator
          })
        : null,
      creator:
        resultCreator(c, part("creator")) ??
        fill(part("creator"), { kind: "named", name: "", path: null, source: null, avatar_url: null }),
      credited_in_card: null
    })
  }
  /** v1's short card in a family listing (`/forks`' parent and children). */
  const familyEntry = (base: Json, c: FakeCard, viewed: FakeCard) =>
    fill(base, {
      id: String(cards.indexOf(c) + 1),
      external_id: externalOf(c),
      source_url: `https://${c.site}.example/${externalOf(c)}`,
      card: fill(base.card, {
        slug: c.slug,
        path: `/c/${c.slug}`,
        name: c.name,
        is_this: c.slug === viewed.slug,
        nsfw: c.nsfw,
        origins: [
          fill(base.card.origins[0], {
            removal: null,
            source: c.site,
            external_id: externalOf(c),
            path: `/o/${c.site}/${externalOf(c)}`,
            is_fork: c.fork
          })
        ],
        earliest_known: iso(c.createdAt),
        estimated_creation: fill(base.card.estimated_creation, {
          at: iso(c.createdAt),
          kind: "site_created",
          source: c.site,
          board: null
        }),
        has_lorebook: c.hasLorebook,
        lorebook_entries: c.hasLorebook ? 1 : 0,
        lorebook_attached_by: c.hasLorebook ? c.site : null,
        differs_in: [],
        is_main: true,
        thumb_url: thumbOf(c),
        creator: resultCreator(c, base.card.creator)
      })
    })

  // --- Searches.

  const list = (value: string | null) => (value ?? "").split(",").filter(Boolean)
  const truthy = (value: string | null) => value === "true" || value === "1"
  const identities = (value: string | null) =>
    (value ?? "")
      .split(/(?<!\\),/)
      .map((v) => v.replace(/\\(.)/g, "$1"))
      .filter(Boolean)

  /** What a search matches, in order, or the captured refusal. */
  const run = (params: URLSearchParams) => {
    const mode = params.get("mode") ?? "fts"
    if (mode !== "fts" && mode !== "semantic") return { refused: capturedError("error-mode") }
    const limit = Number(params.get("limit") ?? String(PAGE_DEFAULT))
    if (!Number.isInteger(limit) || limit < 1 || limit > capabilities.page_size.max)
      return { refused: capturedError("error-limit-0") }
    const page = Number(params.get("page") ?? "1")
    if (!Number.isInteger(page) || page < 1) return { refused: capturedError("error-page-0") }
    if (params.has("cursor") && (mode === "semantic" || page > 1))
      return { refused: capturedError("error-semantic-cursor") }
    const nsfw = params.get("nsfw") ?? "include"
    if (!allowed("nsfw").includes(nsfw))
      return { refused: { status: 400, body: error("bad_request", "nsfw must be one of include, exclude, only") } }
    const kind = params.get("kind") ?? "both"
    if (!allowed("kind").includes(kind))
      return {
        refused: {
          status: 400,
          body: error("bad_request", "kind must be one of character, lorebook, both, character_lorebook")
        }
      }
    const sites = list(params.get("source"))
    const notSites = list(params.get("not_source"))
    const unknownSite = [...sites, ...notSites].find((s) => !SITES.includes(s))
    if (unknownSite !== undefined)
      return { refused: { status: 400, body: error("bad_request", `unknown source "${unknownSite}"`) } }
    const verified = truthy(params.get("chub_verified"))
    const recommended = truthy(params.get("chub_recommended"))
    if ((verified || recommended) && (sites.length !== 1 || sites[0] !== "chub"))
      return { refused: capturedError("error-chub-verified") }
    const q = (params.get("q") ?? "").trim().toLowerCase()
    const sort = params.get("sort") ?? (q ? "relevance" : "newest")
    if (!SORTS.includes(sort)) return { refused: capturedError("error-sort") }
    const include = list(params.get("tags"))
    const exclude = list(params.get("not_tags"))
    if (include.length > 20 || exclude.length > 20) return { refused: capturedError("error-tags-21") }
    const author = params.get("author") ?? ""
    const cover = params.get("has_cover")
    const explicitMin = Number(params.get("min_tokens") ?? "0")
    const min = Number(params.get("min_tokens") ?? String(DEFAULT_MIN_TOKENS))
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
    const anyAuthors = identities(params.get("any_author")).map((v) => v.toLowerCase())
    const notAuthors = identities(params.get("not_author")).map((v) => v.toLowerCase())
    const identity = (c: FakeCard) => (c.creatorKind === "account" ? `${c.site}/${c.creator}`.toLowerCase() : null)
    const dateMatches = (c: FakeCard, which: "added" | "created") => {
      const value = which === "added" ? c.addedAt : c.createdAt
      const after = params.get(`${which}_after`)
      const before = params.get(`${which}_before`)
      return (!after || value >= Date.parse(after)) && (!before || value < Date.parse(before))
    }
    // Lorebooks for `lorebook`, and for `both` when the words name one.
    const pool =
      kind === "lorebook"
        ? lorebooks
        : kind === "both" && q
          ? [...cards, ...lorebooks.filter((c) => [c.name, c.tagline].some((t) => t.toLowerCase().includes(q)))]
          : cards
    const withoutDefaults = pool.filter(
      (c) =>
        // Meaning search finds something for any words; text search needs them.
        (semantic || !q || words(c)) &&
        // Lorebooks are never left out for a missing cover or their token count.
        (!truthy(cover) || c.hasCover || c.lorebook === true) &&
        (kind !== "character_lorebook" || c.hasLorebook) &&
        !notSites.includes(c.site) &&
        groups.every((group) => group.some((tag) => c.tags.includes(tag))) &&
        (!anyAuthors.length || anyAuthors.includes(identity(c) ?? "")) &&
        !notAuthors.includes(identity(c) ?? "") &&
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
        (!author || identity(c) === author.toLowerCase()) &&
        (c.lorebook === true || (c.tokens >= explicitMin && c.tokens <= max)) &&
        (!noForks || !c.fork)
    )
    const matching = withoutDefaults.filter(
      (c) => c.lorebook === true || ((cover !== null || c.hasCover) && c.tokens >= min)
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
    const hidden = withoutDefaults.length - matching.length
    return {
      mode,
      limit,
      page,
      nsfw,
      kind,
      sort,
      q,
      include,
      exclude,
      sites,
      notSites,
      semantic,
      sorted,
      hidden,
      author,
      fields,
      groups,
      anyAuthors,
      notAuthors,
      min
    }
  }

  /** The search's own query, as cardex echoes it. */
  const echo = (params: URLSearchParams, r: Exclude<ReturnType<typeof run>, { refused: unknown }>) => {
    const base = full("search-default", (b) => b.query)
    const extra = (name: string) => template(`search-${name}`, (b) => b.query)
    const date = (name: string) => params.get(name) ?? null
    const number = (name: string) => (params.has(name) ? Number(params.get(name)) : null)
    return {
      ...fill(base, {
        author: r.author || null,
        deleted_from_source: truthy(params.get("deleted_from_source")),
        q: params.get("q")?.trim() || null,
        mode: r.mode,
        tags: r.include,
        not_tags: r.exclude,
        source: r.sites,
        not_source: r.notSites,
        nsfw: r.nsfw,
        kind: r.kind,
        min_tokens: number("min_tokens"),
        max_tokens: number("max_tokens"),
        has_cover: truthy(params.get("has_cover") ?? "true"),
        added_after: date("added_after"),
        added_before: date("added_before"),
        created_after: date("created_after"),
        created_before: date("created_before"),
        exclude_forks: truthy(params.get("exclude_forks")),
        chub_verified: truthy(params.get("chub_verified")),
        chub_recommended: truthy(params.get("chub_recommended")),
        picture: params.get("picture") ?? null,
        sort: r.semantic ? base.sort : r.sort,
        page: r.page,
        limit: r.limit,
        cursor: params.get("cursor")
      }),
      // Listed only when asked for, as live.
      ...(r.fields.length
        ? { fields: fill({ fields: extra("fields-name").fields }, { fields: r.fields }).fields }
        : {}),
      ...(r.groups.length ? { any_tags: r.groups.map((g) => [...g].sort()).sort() } : {}),
      ...(r.anyAuthors.length ? { any_author: identities(params.get("any_author")) } : {}),
      ...(r.notAuthors.length ? { not_author: identities(params.get("not_author")) } : {}),
      ...(truthy(params.get("deleted_from_any_source")) ? { deleted_from_any_source: true } : {})
    }
  }

  /** A tag as a search echoes the ones it asked for: with its number of cards. */
  const tagCount = (tag: string) =>
    fill(
      full("search-tags", (b) => b.tags[0]),
      { slug: tag, label: tag, card_count: cards.filter((c) => c.tags.includes(tag)).length }
    )
  /** What a search for a creator cardex doesn't know says instead of the creator. */
  const capturedAuthorError = (capture("search-author-unknown").body as Json).author_error as string

  /**
   * v1's search: text mode pages by `next_cursor`, which belongs to the same query and limit
   * only, and gives no total (`/search/count` counts); semantic mode pages by `page`, 240
   * results at most.
   */
  const search = (params: URLSearchParams): { status: number; body: unknown } => {
    const r = run(params)
    if ("refused" in r) return r.refused
    // The query a cursor belongs to: every parameter but the cursor and page, in order.
    const normalized = [...params]
      .filter(([k]) => k !== "cursor" && k !== "page")
      .sort(([a], [b]) => a.localeCompare(b))
    const queryHash = sha(JSON.stringify([cursorEpoch, normalized])).slice(0, 12)
    let offset = (r.page - 1) * r.limit
    if (params.has("cursor")) {
      const cursor = /^(\d+)\.([0-9a-f]{12})$/.exec(Buffer.from(params.get("cursor")!, "base64url").toString("utf8"))
      if (!cursor || cursor[2] !== queryHash) return capturedError("error-cursor")
      offset = Number(cursor[1])
    }
    const reachable = r.sorted.slice(0, r.semantic ? SEMANTIC_MAX : MAX_RESULTS)
    const shown = reachable.slice(offset, offset + r.limit)
    const more = offset + r.limit < reachable.length
    const base = full("search-default")
    const authorCard = r.author ? r.sorted.find((c) => c.creatorKind === "account") : undefined
    return {
      status: 200,
      body: fill(base, {
        query: echo(params, r),
        author:
          r.author && authorCard
            ? fill(
                full("search-author", (b) => b.author),
                {
                  source: authorCard.site,
                  handle: authorCard.creator,
                  display_name: authorCard.creator
                }
              )
            : null,
        author_error: r.author && !authorCard ? capturedAuthorError : null,
        results: shown.map(result),
        total: r.semantic ? reachable.length : null,
        total_capped: r.semantic ? r.sorted.length > SEMANTIC_MAX : false,
        page: Math.floor(offset / r.limit) + 1,
        pages: r.semantic ? Math.ceil(reachable.length / r.limit) : null,
        page_size: r.limit,
        tags: r.include.map(tagCount),
        not_tags: r.exclude.map(tagCount),
        unknown_tags: r.include.filter((t) => !TAGS.includes(t) && !LORE_TAGS.includes(t)),
        semantic: r.semantic
          ? fill(
              full("search-semantic", (b) => b.semantic),
              { embedded_cards: cards.length, search_cards: cards.length }
            )
          : null,
        defaults: fill(base.defaults, {
          min_tokens: DEFAULT_MIN_TOKENS,
          has_cover: true,
          hidden: r.semantic ? null : r.hidden,
          hidden_capped: false
        }),
        items: shown.map((c) => summary(c)),
        total_is_estimate: r.semantic && r.sorted.length > SEMANTIC_MAX,
        next_cursor:
          !r.semantic && more ? Buffer.from(`${offset + r.limit}.${queryHash}`, "utf8").toString("base64url") : null,
        has_more: more
      })
    }
  }

  // --- Downloads: the creator's file, or the archive's mirrored PNG.

  /** The card's JSON as cardex serves it: its own, with cardex's `extensions.cardex` block. */
  const servedJson = (c: FakeCard) => {
    const doc = JSON.parse(c.json) as Json
    const block = fill(
      template("download-json", (b) => b.data.extensions.cardex),
      {
        url: `${originOf()}/c/${c.slug}`,
        version: 1,
        origins: [
          fill(
            template("download-json", (b) => b.data.extensions.cardex.origins[0]),
            {
              created: iso(c.createdAt),
              current: true,
              first_seen: iso(c.addedAt),
              id: externalOf(c),
              source: c.site,
              url: `https://${c.site}.example/${externalOf(c)}`
            }
          )
        ]
      }
    )
    const extensions = (c.lorebook ? doc : doc.data).extensions ?? {}
    if (c.lorebook) doc.extensions = { ...extensions, cardex: block }
    else doc.data.extensions = { ...extensions, cardex: block }
    return JSON.stringify(doc)
  }

  const images = new Map<string, Promise<Buffer>>()
  const image = (card: FakeCard, size: "512" | "full") => {
    const key = `${card.sha256}:${size}`
    let made = images.get(key)
    if (!made) {
      const png = portraitPng(card.color)
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

  // --- Changes the tests make.

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
    const next: FakeCard = { ...card, json, sha256: sha(json), addedAt: card.addedAt + revision * 86_400_000 }
    list[at] = next
    bySlug.set(slug, next)
    bySha.set(next.sha256, next)
    return next
  }
  let serial = 0
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
    const nextSlug = `${roots.get(slug) ?? slug}-successor-${++serial}`
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
    const fork: FakeCard = {
      ...parent,
      slug: `${slug}-fork-${++serial}`,
      name: doc.data.name,
      json,
      sha256: sha(json),
      parent: slug,
      fork: true,
      supersededBy: undefined
    }
    cards.push(fork)
    bySlug.set(fork.slug, fork)
    bySha.set(fork.sha256, fork)
    const pair = [fork.site, externalOf(fork)] as const
    originKeys.set(fork.slug, pair)
    originHeads.set(originKey(pair), fork.slug)
    roots.set(fork.slug, fork.slug)
    return fork
  }

  // --- Serving.

  const seen: Array<string> = []
  let failure: { status: number; times: number; retryAfter?: number; path?: string; sort?: string } | null = null
  let conditionalHits = 0
  let notModified = 0
  let origin = ""
  const originOf = () => origin

  /** An answer with the headers of the capture `like`: an ETag only where that one had one. */
  const send = (
    res: ServerResponse,
    status: number,
    bytes: string | Uint8Array,
    headers: Record<string, string>,
    like: string
  ) => {
    if (status === 200 && capture(like).headers.etag !== undefined) {
      // cardex's ETags are weak; a match answers 304 with no body.
      // A picture's is a strong one, as a file server makes it.
      const etag = like.startsWith("image-")
        ? `"${sha(bytes).slice(0, 8)}-${bytes.length.toString(16)}"`
        : `W/"${sha(bytes)}"`
      headers.etag = etag
      if (res.req.headers["if-none-match"] === etag) {
        notModified++
        const { "content-type": _type, ...rest } = headers
        res.writeHead(304, rest)
        return res.end()
      }
    }
    res.writeHead(status, headers)
    res.end(bytes)
  }
  const json = (res: ServerResponse, status: number, body: unknown, like: string) =>
    send(res, status, JSON.stringify(body), { ...headersOf(like) }, like)
  const refusal = (res: ServerResponse, refused: { status: number; body: unknown }) =>
    json(res, refused.status, refused.body, "error-limit-0")
  const notFound = (res: ServerResponse) => refusal(res, NOT_FOUND())

  const download = (res: ServerResponse, c: FakeCard, mode: string) => {
    if (deleted.has(c.slug)) return notFound(res)
    if (regional.has(c.slug))
      return refusal(res, { status: 451, body: error("region_unavailable", "not available in your region") })
    if (!DOWNLOAD_MODES.includes(mode)) return refusal(res, capturedError("download-bad-mode"))
    if (refused.has(c.slug))
      return refusal(res, { status: 403, body: error("forbidden", "downloads of this card are not available") })
    if (!downloadModes(c).includes(mode)) return notFound(res)
    // The original is the creator's file (these synthetic originals are themselves JSON); a
    // JSON download is that with cardex's block, and every other form of a lorebook is too.
    const disposition = (ext: string) => `attachment; filename="${c.slug}.${ext}"`
    if (mode === "original")
      return send(
        res,
        200,
        c.json,
        { ...headersOf("download-original"), "content-disposition": disposition(c.originalOnly ? "charx" : "json") },
        "download-original"
      )
    if (mode === "json" || c.lorebook)
      return send(
        res,
        200,
        servedJson(c),
        { ...headersOf("download-json"), "content-disposition": disposition("json") },
        "download-json"
      )
    return send(
      res,
      200,
      cardPng(c.color, servedJson(c)),
      { ...headersOf("download-mirrored"), "content-disposition": disposition("png") },
      "download-mirrored"
    )
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const path = url.pathname
    const control = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (path === "/__fake/count-cap") {
      countCap = Number(url.searchParams.get("value") ?? capabilities.page_size.count_cap)
      return control({ ok: true })
    }
    if (path === "/__fake/expire-cursors") {
      cursorEpoch++
      return control({ ok: true })
    }
    if (path === "/__fake/hits") return control({ hits: seen.length, paths: seen })
    if (path === "/__fake/reset") {
      seen.length = 0
      failure = null
      return control({ ok: true })
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
      return control({ ok: true })
    }
    if (path === "/__fake/successor" || path === "/__fake/publish") {
      const slug = url.searchParams.get("slug") ?? ""
      if (!bySlug.has(slug)) return notFound(res)
      if (path === "/__fake/publish") return control({ slug, version: publish(slug).sha256 })
      const next = publishSuccessor(slug, url.searchParams.get("site") ?? undefined)
      return control({ slug: next.slug, version: next.sha256 })
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
        ...headersOf("error-limit-0"),
        ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) })
      })
      return res.end(
        JSON.stringify(error(status === 429 ? "rate_limited" : "internal", "a failure the test asked for"))
      )
    }
    if (path === "/api/v1/capabilities") return json(res, 200, capture("capabilities").body, "capabilities")
    if (path === "/api/v1/search/count") {
      const params = new URLSearchParams(url.searchParams)
      params.set("limit", "1")
      const r = run(params)
      if ("refused" in r) return refusal(res, r.refused)
      const total = Math.min(r.sorted.length, countCap)
      return json(
        res,
        200,
        fill(template("count-default"), {
          total,
          capped: r.sorted.length >= countCap,
          cap: countCap,
          pages: Math.ceil(Math.min(total, MAX_RESULTS) / PAGE_DEFAULT),
          timed_out: false
        }),
        "count-default"
      )
    }
    if (path === "/api/v1/search") {
      const { status, body } = search(url.searchParams)
      return status === 200 ? json(res, status, body, "search-default") : refusal(res, { status, body })
    }
    if (path === "/api/v1/tags" || path === "/api/v1/search/authors") {
      const tags = path.endsWith("/tags")
      const prefix = (url.searchParams.get("q") ?? "").toLowerCase()
      const counts = new Map<string, number>()
      for (const c of cards)
        for (const value of tags ? c.tags : c.creatorKind === "account" ? [`${c.site}/${c.creator}`] : [])
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
          return refusal(res, capturedError("tags-bad-cursor"))
        }
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10)))
      const rest = all.filter(([value]) => value.localeCompare(after) > 0)
      const items = rest.slice(0, limit)
      const next =
        rest.length > limit
          ? Buffer.from(JSON.stringify({ prefix, tags, after: items.at(-1)![0] })).toString("base64url")
          : null
      if (tags) {
        const base = template("tags-prefix")
        const entry = template("tags-prefix", (b) => b.tags.find((t: Json) => "matched_label" in t) ?? b.tags[0])
        const plain = template("tags", (b) => b.tags[0])
        const page = Math.floor(all.findIndex(([value]) => value === items[0]?.[0]) / limit) + 1
        return json(
          res,
          200,
          fill(base, {
            q: url.searchParams.get("q") ?? null,
            tags: items.map(([value, card_count]) =>
              prefix && value.includes("-") && !value.startsWith(`${prefix}-`)
                ? fill(entry, {
                    slug: value,
                    label: value,
                    card_count,
                    match_kind: "split",
                    via_alias: false,
                    matched_label: value
                  })
                : fill(plain, { slug: value, label: value, card_count, match_kind: "direct" })
            ),
            page: Math.max(1, page),
            pages: Math.max(1, Math.ceil(all.length / limit)),
            total: all.length,
            next
          }),
          "tags"
        )
      }
      const entry = template("authors-suggest", (b) => b.authors[0])
      return json(
        res,
        200,
        fill(template("authors-suggest"), {
          authors: items.map(([value, card_count]) =>
            fill(entry, {
              source: value.split("/")[0],
              handle: value.split("/")[1],
              display_name: value.split("/")[1],
              card_count
            })
          ),
          next
        }),
        "authors-suggest"
      )
    }
    if (path === "/api/v1/cards/batch") {
      const ids = list(url.searchParams.get("ids"))
      const canonical = [...new Set(ids)].sort()
      if (canonical.length > 100)
        return refusal(res, { status: 400, body: error("bad_request", "ids: at most 100 ids") })
      // Anything but the canonical form (sorted, without duplicates, joined by %2C) answers 308.
      const form = `?ids=${canonical.map(encodeURIComponent).join("%2C")}`
      if (url.search !== form) {
        res.writeHead(308, { ...headersOf("batch-not-canonical"), location: `/api/v1/cards/batch${form}` })
        return res.end()
      }
      const base = full("batch", (b) => b.items[0])
      return json(
        res,
        200,
        fill(full("batch"), {
          items: canonical.flatMap((id) => {
            const c = bySlug.get(id)
            return c && !deleted.has(c.slug) ? [{ ...summary(c, base), file_sha256: c.sha256 }] : []
          }),
          missing: canonical.filter((id) => !bySlug.has(id))
        }),
        "batch"
      )
    }
    const author = /^\/api\/v1\/authors\/([^/]+)\/([^/]+)$/.exec(path)
    if (author) {
      // v1's creator profile: the creator, then a page of their cards.
      const site = decodeURIComponent(author[1]!)
      const handle = decodeURIComponent(author[2]!)
      const theirs = cards.filter((c) => c.site === site && c.creator === handle && c.creatorKind === "account")
      if (theirs.length === 0) return notFound(res)
      const first = theirs[0]!
      const base = full("author")
      const page = theirs.slice(0, 24)
      return json(
        res,
        200,
        fill(base, {
          author: fill(base.author, {
            source: site,
            source_label: SITE_LABELS[site] ?? site,
            handle,
            display_name: `${handle} (synthetic)`,
            bio: handle === "lumen" ? null : `A synthetic creator who makes ${theirs.length} test cards.`,
            avatar:
              handle === "lumen" || !first.hasCover
                ? null
                : fill(sample("top.cover.image"), {
                    url: imageOf(first),
                    thumb_url: thumbOf(first),
                    width: COVER.width,
                    height: COVER.height,
                    animated: false
                  }),
            path: `/u/${site}/${handle}`,
            card_count: theirs.filter((c) => !c.lorebook).length,
            lorebook_count: theirs.filter((c) => c.lorebook).length,
            first_seen_at: iso(Math.min(...theirs.map((c) => c.addedAt))),
            last_seen_at: iso(Math.max(...theirs.map((c) => c.addedAt)))
          }),
          sort: "newest",
          page: 1,
          pages: Math.ceil(theirs.length / 24),
          total: theirs.length,
          page_size: 24,
          results: page.map(result),
          link_map: []
        }),
        "author"
      )
    }
    const originRoute = /^\/api\/v1\/origins\/([^/]+)\/([^/]+)$/.exec(path)
    if (originRoute) {
      const c = byExternal(decodeURIComponent(originRoute[1]!), decodeURIComponent(originRoute[2]!))
      if (!c) return notFound(res)
      if (regional.has(c.slug))
        return refusal(res, { status: 451, body: error("region_unavailable", "not available in your region") })
      return json(res, 200, detailOf(c, "origin"), "forked-origin")
    }
    const detail = /^\/api\/v1\/cards\/([^/]+)$/.exec(path)
    if (detail) {
      const c = bySlug.get(decodeURIComponent(detail[1]!))
      if (!c || deleted.has(c.slug)) return notFound(res)
      return json(res, 200, detailOf(c), "card-character")
    }
    const family = /^\/api\/v1\/(versions|forks)\/([^/]+)\/([^/]+)$/.exec(path)
    if (family) {
      const c = byExternal(decodeURIComponent(family[2]!), decodeURIComponent(family[3]!))
      if (!c) return notFound(res)
      if (family[1] === "versions") {
        const history = historyOf(c)
        const current = full("forked-versions", (b) => b.items[0])
        const earlier = current
        return json(
          res,
          200,
          fill(full("forked-versions"), {
            items: history.map((v, i) => {
              const base = i === 0 ? current : earlier
              return fill(base, {
                id: String(history.length - i),
                version: versionEntry(base.version, v, c, history.length - i, i === 0, c),
                cover_thumb_url: thumbOf(v),
                nsfw: v.nsfw,
                json_url: `/api/v1/download/${v.sha256}?mode=json`
              })
            }),
            next: null
          }),
          "forked-versions"
        )
      }
      const parent = c.parent ? bySlug.get(c.parent) : undefined
      const base = full("forked-forks")
      const parentBase = full("fork-forks", (b) => b.parent)
      const childBase = full("forked-forks", (b) => b.children[0])
      return json(
        res,
        200,
        fill(base, {
          parent: parent ? familyEntry(parentBase, parent, c) : null,
          children: childrenOf(c).map((child) => familyEntry(childBase, child, c)),
          next: null,
          viewed_slug: c.slug
        }),
        "forked-forks"
      )
    }
    const file = /^\/api\/v1\/download\/([0-9a-f]{64})$/.exec(path)
    if (file) {
      const c = bySha.get(file[1]!)
      return c ? download(res, c, url.searchParams.get("mode") ?? "mirrored") : notFound(res)
    }
    // Only the 512 px thumbnail: cardex lists a 64 px variant but answers 404 for it.
    const picture = /^\/(?:t\/([0-9a-f]{64})\.(512)\.webp|i\/([0-9a-f]{64})\.png)$/.exec(path)
    const c = picture ? bySha.get((picture[1] ?? picture[3])!) : undefined
    if (picture && c?.hasCover) {
      const thumb = picture[1] !== undefined
      void image(c, thumb ? "512" : "full").then((bytes) =>
        send(
          res,
          200,
          bytes,
          { ...headersOf(thumb ? "image-thumb-512" : "image-full") },
          thumb ? "image-thumb-512" : "image-full"
        )
      )
      return
    }
    if (path.startsWith("/t/") || path.startsWith("/i/")) {
      res.writeHead(404, headersOf("image-missing"))
      return res.end("not found\n")
    }
    notFound(res)
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
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
