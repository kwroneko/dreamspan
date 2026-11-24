// Turns captured cardex responses into synthetic fixtures (README.md): the API's structure
// stays as captured (every key, every status and header, the capabilities description, the
// API's own labels and enum values, numbers, booleans, nulls, dates), and everything that came
// from a card or a person is replaced by our own SFW words of a similar shape and length, the
// same value the same way everywhere, so a slug in a summary still matches the one in its path.
// Also the shape comparison the contract test and `capture.ts --verify` share.
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"

export interface Capture {
  readonly name: string
  readonly request: { readonly path: string; readonly query: Record<string, string> }
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: unknown
  /** A response that isn't JSON (a picture, a card PNG, an empty redirect): its size and first bytes. */
  readonly bodyInfo?: { readonly bytes: number; readonly magic: string }
}

/** The fixtures in a directory, by name (every `.json` file but the README's neighbours). */
export const captureNames = (dir: string): Array<string> =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort()

/** Where synthetic absolute URLs on the archive point. */
const ARCHIVE_ORIGIN = "https://archive.example"

const WORDS = [
  "amber",
  "anchor",
  "apple",
  "arch",
  "atlas",
  "autumn",
  "badge",
  "bamboo",
  "banner",
  "basin",
  "beacon",
  "bell",
  "berry",
  "birch",
  "blossom",
  "boat",
  "bramble",
  "breeze",
  "brook",
  "button",
  "cabin",
  "candle",
  "canyon",
  "cedar",
  "chalk",
  "chime",
  "cider",
  "clover",
  "cobble",
  "comet",
  "copper",
  "coral",
  "cotton",
  "cove",
  "crane",
  "creek",
  "cricket",
  "crystal",
  "daisy",
  "dawn",
  "delta",
  "drift",
  "dune",
  "echo",
  "elm",
  "ember",
  "fable",
  "fern",
  "field",
  "finch",
  "fjord",
  "flint",
  "frost",
  "garden",
  "glade",
  "glen",
  "grove",
  "harbor",
  "hazel",
  "heron",
  "hill",
  "hollow",
  "honey",
  "island",
  "ivy",
  "jade",
  "juniper",
  "kettle",
  "kite",
  "lagoon",
  "lantern",
  "larch",
  "lark",
  "laurel",
  "leaf",
  "lemon",
  "linen",
  "lotus",
  "maple",
  "marble",
  "meadow",
  "mellow",
  "mint",
  "mist",
  "moss",
  "nectar",
  "north",
  "oak",
  "ocean",
  "olive",
  "orchard",
  "otter",
  "paper",
  "pebble",
  "pepper",
  "petal",
  "pine",
  "plum",
  "pond",
  "poppy",
  "quill",
  "quiet",
  "rain",
  "raven",
  "reed",
  "ridge",
  "river",
  "robin",
  "rose",
  "saffron",
  "sage",
  "sail",
  "sand",
  "shell",
  "silver",
  "sky",
  "slate",
  "snow",
  "sorrel",
  "spark",
  "spruce",
  "star",
  "stone",
  "summer",
  "swan",
  "teal",
  "thistle",
  "thyme",
  "tide",
  "timber",
  "topaz",
  "trail",
  "tulip",
  "valley",
  "velvet",
  "violet",
  "willow",
  "wind",
  "winter",
  "wren",
  "yarrow",
  "zephyr"
]
const TAGS = [
  "fantasy",
  "adventure",
  "mystery",
  "slice-of-life",
  "comedy",
  "sci-fi",
  "historical",
  "detective",
  "magic",
  "space",
  "school",
  "steampunk",
  "cyberpunk",
  "fairy-tale",
  "mythology",
  "western",
  "pirates",
  "dragons",
  "robots",
  "ghosts",
  "cooking",
  "gardening",
  "music",
  "sports",
  "travel",
  "library",
  "museum",
  "village",
  "castle",
  "forest",
  "ocean",
  "desert",
  "mountains",
  "winter",
  "summer",
  "festival",
  "puzzle",
  "inventor",
  "scholar",
  "knight",
  "healer",
  "bard",
  "merchant",
  "sailor",
  "explorer",
  "astronomer",
  "baker",
  "painter",
  "poet",
  "teacher",
  "friendly",
  "cheerful",
  "calm",
  "curious",
  "wholesome",
  "cozy",
  "drama",
  "action",
  "strategy",
  "worldbuilding",
  "places",
  "factions",
  "creatures",
  "english",
  "original",
  "multiple-greetings",
  "has-lorebook",
  "game",
  "anime",
  "fictional",
  "oc"
]

/** Keys whose string values are the API's own vocabulary (enums, labels, kinds), kept as captured. */
const KEPT_KEYS = new Set([
  "kind",
  "mode",
  "sort",
  "nsfw",
  "ext",
  "mime",
  "model",
  "match_kind",
  "type",
  "position",
  "spec",
  "spec_version",
  "source_label",
  "shortlist_display",
  "arrival",
  "provenance",
  "fetch_status",
  "permissions",
  "primaryFormat",
  "projectSpace",
  "twitter_card",
  "file_from",
  "status",
  "rating",
  "differs_in",
  "cosmetic",
  "first",
  "rule",
  "viewScreen",
  "role",
  "removal",
  "board",
  "download_modes",
  "error",
  "default_sort",
  "origin",
  "fields"
])
/** Keys whose values name sites (kept when they are one of the capabilities' sites). */
const SITE_KEYS = new Set(["source", "sources", "not_source", "site"])
/** Keys holding tags. */
const TAG_KEYS = new Set(["tags", "not_tags", "unknown_tags", "embedded_card_tags", "any_tags"])
/** Path segments and identifier parts that are the API's, not a card's. */
const STRUCTURAL = new Set([
  "api",
  "v1",
  "c",
  "u",
  "o",
  "t",
  "i",
  "v",
  "a",
  "search",
  "count",
  "cards",
  "batch",
  "download",
  "origins",
  "versions",
  "forks",
  "authors",
  "tags",
  "capabilities",
  "webp",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "json",
  "charx",
  "512",
  "64",
  "character",
  "characters",
  "lorebook",
  "lorebooks",
  "card",
  "chat",
  "chats",
  "user",
  "users",
  "tab",
  "images",
  "image",
  "files",
  "file",
  "lore",
  "definition",
  "versions",
  "history",
  "family",
  "gallery"
])
/** How far every captured time is moved back: 17 days, 5 h 13 min 29 s. */
const TIME_SHIFT_MS = (((17 * 24 + 5) * 60 + 13) * 60 + 29) * 1000
const ISO = /^\d{4}-\d\d-\d\d(?:[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/

const digest = (value: string) => createHash("sha256").update(`cardex-fixture:${value}`).digest()

class Synthesizer {
  private readonly ids = new Map<string, string>()
  private readonly tags = new Map<string, string>()
  private readonly hosts = new Map<string, string>()
  private readonly opaque = new Map<string, string>()
  /** Every original string replaced, for the leak check. */
  readonly replaced = new Set<string>()
  readonly sites: ReadonlySet<string>
  readonly origin: string
  constructor(origin: string, sites: ReadonlyArray<string>) {
    this.origin = origin
    this.sites = new Set(sites)
  }

  hex(value: string) {
    let out = ""
    for (let n = 0; out.length < value.length; n++) out += digest(`hex:${value}:${n}`).toString("hex")
    const hex = out.slice(0, value.length)
    return value === value.toUpperCase() ? hex.toUpperCase() : hex
  }

  digits(value: string) {
    const bytes = digest(`digits:${value}`)
    let out = ""
    for (let n = 0; n < value.length; n++) out += String(bytes[n % bytes.length]! % 10)
    return value.length > 1 && out[0] === "0" ? `1${out.slice(1)}` : out
  }

  /** A word of exactly this many letters, with the original's capitals. */
  letters(value: string, salt: string) {
    const bytes = digest(`letters:${salt}:${value}`)
    const length = [...value].length
    let out = ""
    for (let n = 0; out.length < length; n++) out += WORDS[bytes[n % bytes.length]! % WORDS.length]
    let word = out.slice(0, length)
    if (value === value.toUpperCase() && value.length > 1) word = word.toUpperCase()
    else if (value[0] === value[0]!.toUpperCase() && value[0] !== value[0]!.toLowerCase())
      word = word[0]!.toUpperCase() + word.slice(1)
    return word
  }

  /** One identifier part: hex stays hex, digits digits, a UUID a UUID, words words. */
  private part(value: string): string {
    if (value === "" || STRUCTURAL.has(value) || this.sites.has(value)) return value
    if (/^\d+$/.test(value)) return value.length <= 2 ? value : this.digits(value)
    if (/^\p{N}+$/u.test(value)) return this.digits(value)
    if (/^[0-9a-f]{6,}$/i.test(value) && /\d/.test(value)) return this.hex(value)
    return value.replace(/\p{L}+|\p{N}+|[^\p{L}\p{N}]+/gu, (run) =>
      /^\p{L}+$/u.test(run)
        ? this.letters(run, value)
        : /^\p{N}+$/u.test(run)
          ? this.digits(run)
          : run.replace(/[^\x20-\x7e]/g, "-")
    )
  }

  /** A slug, handle, external id or name without spaces, the same everywhere. */
  id(value: string): string {
    const known = this.ids.get(value)
    if (known !== undefined) return known
    let out: string
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      out = value.replace(/[0-9a-f]+/gi, (run) => this.hex(`${value}:${run}`).slice(0, run.length))
    else
      out = value
        .split(/([/.:_-])/)
        .map((piece, n) => (n % 2 ? piece : this.part(piece)))
        .join("")
    this.ids.set(value, out)
    if (out !== value) this.replaced.add(value)
    return out
  }

  tag(value: string): string {
    const known = this.tags.get(value)
    if (known !== undefined) return known
    const n = this.tags.size
    const out = n < TAGS.length ? TAGS[n]! : `${TAGS[n % TAGS.length]}-${Math.floor(n / TAGS.length) + 1}`
    this.tags.set(value, out)
    this.replaced.add(value)
    return out
  }

  /** A tag's label from its synthetic slug, cased as the original label was. */
  tagLabel(label: string, slug: string) {
    const words = this.tag(slug).replaceAll("-", " ")
    if (label.length > 1 && label === label.toUpperCase()) return words.toUpperCase()
    if (/^[A-Z]/.test(label)) return words.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    return words
  }

  /** Text: each line our own words, of the same length and ending as the original's. */
  text(value: string): string {
    if (value.trim() === "") return value
    this.replaced.add(value)
    return value
      .split("\n")
      .map((line, n) => {
        if (line.trim() === "") return line
        const bytes = digest(`text:${n}:${line}`)
        let out = ""
        for (let k = 0; out.length < line.length; k++) {
          const word = WORDS[bytes[k % bytes.length]! % WORDS.length]!
          out += (out ? " " : "") + (k === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)
        }
        out = out.slice(0, line.length).trimEnd().padEnd(line.length, ".")
        return /[.!?"*)]$/.test(line) ? `${out.slice(0, -1)}${line.at(-1)}` : out
      })
      .join("\n")
  }

  /**
   * A time a card was made, seen or changed: every one moved back by the same amount (so their
   * order and spacing stay), its fraction of a second mapped. A bare date is a request's own.
   */
  time(value: string): string {
    const parts = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)(\.\d+)?(.*)$/.exec(value)
    if (!parts) return value
    const at = Date.parse(`${parts[1]!.replace(" ", "T")}Z`)
    if (Number.isNaN(at)) return value
    const moved = new Date(at - TIME_SHIFT_MS).toISOString().slice(0, 19).replace("T", parts[1]![10]!)
    return `${moved}${parts[2] ? `.${this.digits(parts[2].slice(1))}` : ""}${parts[3]}`
  }

  cursor(value: string): string {
    const known = this.opaque.get(value)
    if (known !== undefined) return known
    let out = ""
    for (let n = 0; out.length < value.length; n++) out += digest(`cursor:${value}:${n}`).toString("base64url")
    out = out.slice(0, value.length)
    // Keep the separators an opaque token had (a signed cursor's ".").
    out = [...value].map((c, n) => (/[A-Za-z0-9_-]/.test(c) ? out[n] : c)).join("")
    this.opaque.set(value, out)
    this.replaced.add(value)
    return out
  }

  host(host: string) {
    const known = this.hosts.get(host)
    if (known !== undefined) return known
    const out = `site${this.hosts.size + 1}.example`
    this.hosts.set(host, out)
    return out
  }

  /** A path on the archive: the API's segments kept, the rest mapped as identifiers. */
  path(value: string): string {
    const [path, query] = value.split(/\?(.*)/s, 2) as [string, string | undefined]
    const segments = path.split("/").map((segment) => {
      let decoded: string
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        decoded = segment
      }
      const mapped = this.id(decoded)
      return mapped === decoded
        ? segment
        : encodeURIComponent(mapped).replaceAll("%2F", segment.includes("%2F") ? "%2F" : "/")
    })
    if (query === undefined) return segments.join("/")
    const params = new URLSearchParams(query)
    const out = new URLSearchParams()
    for (const [key, val] of params) out.append(key, this.param(key, val))
    return `${segments.join("/")}?${out.toString()}`
  }

  url(value: string): string {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return this.text(value)
    }
    if (!/^https?:$/.test(url.protocol)) return this.text(value)
    this.replaced.add(value)
    const base = url.origin === this.origin ? ARCHIVE_ORIGIN : `${url.protocol}//${this.host(url.host)}`
    return `${base}${this.path(`${url.pathname}${url.search}`)}${url.hash ? `#${this.id(url.hash.slice(1))}` : ""}`
  }

  identity(value: string) {
    const [site, ...rest] = value.split("/")
    return [site, ...rest.map((r) => this.id(r))].join("/")
  }

  /** A request parameter (or one echoed back), by its name. */
  param(key: string, value: string): string {
    if (["tags", "not_tags"].includes(key))
      return value
        .split(",")
        .map((t) => (t ? this.tag(t) : t))
        .join(",")
    if (key === "any_tags")
      return value
        .split(",")
        .map((g) =>
          g
            .split("|")
            .map((t) => this.tag(t))
            .join("|")
        )
        .join(",")
    if (["author", "any_author", "not_author"].includes(key))
      return value
        .split(",")
        .map((v) => this.identity(v))
        .join(",")
    if (key === "cursor") return this.cursor(value)
    if (key === "picture") return this.hex(value)
    if (key === "ids")
      return value
        .split(",")
        .map((v) => this.id(v))
        .join(",")
    if (key === "q") return /\s/.test(value) ? this.text(value) : this.id(value)
    // A hash or version token in a URL (a picture's `?v=`): the file's, so mapped.
    if (/^[0-9a-f]{6,}$/i.test(value) && /\d/.test(value)) return this.hex(value)
    return value
  }

  /** A string value under `key`. */
  string(key: string, value: string, tagged: boolean): string {
    if (value === "") return value
    if (ISO.test(value)) return this.time(value)
    if (KEPT_KEYS.has(key)) return value
    if (SITE_KEYS.has(key) && this.sites.has(value)) return value
    if (tagged || TAG_KEYS.has(key)) return this.tag(value)
    if (["next_cursor", "next", "cursor"].includes(key)) return this.cursor(value)
    if (["author", "any_author", "not_author"].includes(key) && value.includes("/")) return this.identity(value)
    if (/^[0-9a-f]{16,}$/i.test(value)) return this.hex(value)
    if (/^https?:\/\//.test(value)) return this.url(value)
    if (value.startsWith("/") && !/\s/.test(value)) return this.path(value)
    if (/\s/.test(value) || value.length > 64) return this.text(value)
    return this.id(value)
  }

  /** An object key: the API's names kept; one made of a card's slug, hash or name mapped. */
  key(key: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^[0-9a-f]{12,}$/.test(key)) return key
    if (/^\d+$/.test(key)) return key
    if (/^[a-z_]+\.[a-z_]+$/.test(key)) return key
    const colon = key.indexOf(":")
    if (colon > 0 && /^[a-z_]+$/.test(key.slice(0, colon)))
      return `${key.slice(0, colon)}:${this.id(key.slice(colon + 1))}`
    return this.id(key)
  }

  value(value: unknown, key: string, tagged: boolean): unknown {
    // A card's own safety flags and its site's rating describe the real card, not ours.
    if (key === "safety" && value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "boolean" ? false : v]))
    if (key === "rating" && typeof value === "string") return value === "nsfl" ? "nsfw" : value
    if (typeof value === "string") return this.string(key, value, tagged)
    if (typeof value === "number")
      // A site's numeric id (an uploader's, a creator's, a card's) is mapped; a lorebook
      // entry's own small `id` is only its place.
      return Number.isInteger(value) && ((/(_id$|Id$)/.test(key) && value >= 10) || (key === "id" && value >= 1000))
        ? Number(this.digits(String(value)))
        : value
    if (Array.isArray(value)) return value.map((v) => this.value(v, key, tagged || TAG_KEYS.has(key)))
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      // A tag object ({slug, label}) in a list of tags.
      const tagObject =
        (tagged || /tags$/.test(key)) && typeof record.slug === "string" && !("path" in record) && !("url" in record)
      return Object.fromEntries(
        Object.entries(record).map(([k, v]) => {
          if (tagObject && k === "slug") return [k, this.tag(v as string)]
          if (tagObject && (k === "label" || k === "matched_label") && typeof v === "string")
            return [k, this.tagLabel(v, record.slug as string)]
          return [this.key(k), this.value(v, k, false)]
        })
      )
    }
    return value
  }

  header(key: string, value: string) {
    // Weak ETags hash the body, a picture's strong one its file's time and size: all mapped.
    if (key === "etag") return value.replace(/[0-9a-f]{3,}/gi, (hex) => this.hex(hex))
    if (key === "location") return this.path(value)
    if (key === "content-disposition")
      return value.replace(/filename="([^"]*)"/, (_, name: string) => {
        const dot = name.lastIndexOf(".")
        return `filename="${dot > 0 ? `${this.id(name.slice(0, dot))}${name.slice(dot)}` : this.id(name)}"`
      })
    return value
  }
}

/** The fixtures from untouched captures: see the file's comment. */
export function synthesize(raw: ReadonlyArray<Capture>, origin: string): Array<Capture> {
  const capabilities = raw.find((c) => c.name === "capabilities")?.body as
    { filters?: Array<{ name: string; allowed_values?: Array<string> }> } | undefined
  const sites = capabilities?.filters?.find((f) => f.name === "source")?.allowed_values ?? []
  const s = new Synthesizer(origin, sites)
  const out = raw.map((capture): Capture => {
    const verbatim = capture.name === "capabilities"
    const isError =
      capture.status >= 400 &&
      typeof capture.body === "object" &&
      capture.body !== null &&
      "error" in (capture.body as Record<string, unknown>)
    return {
      name: capture.name,
      request: {
        path: s.path(capture.request.path),
        query: Object.fromEntries(Object.entries(capture.request.query).map(([k, v]) => [k, s.param(k, v)]))
      },
      status: capture.status,
      headers: Object.fromEntries(Object.entries(capture.headers).map(([k, v]) => [k, s.header(k, v)])),
      ...(capture.body !== undefined
        ? {
            body: verbatim
              ? capture.body
              : isError
                ? errorBody(s, capture.body as Record<string, unknown>, capture.request.query)
                : s.value(capture.body, "", false)
          }
        : {}),
      ...(capture.bodyInfo ? { bodyInfo: capture.bodyInfo } : {})
    }
  })
  const leaks = leaked(s, out)
  if (leaks.length) throw new Error(`card content would be committed: ${leaks.slice(0, 20).join(", ")}`)
  return out
}

/** An error's code and message are the API's; a value it echoes is mapped like the request's. */
const errorBody = (s: Synthesizer, body: Record<string, unknown>, query: Record<string, string>) => ({
  ...body,
  ...(typeof body.message === "string"
    ? {
        message: body.message.replace(/"([^"]*)"/g, (_, v: string) => {
          const asked = Object.entries(query).find(([, value]) => value === v)
          return `"${asked ? s.param(asked[0], v) : s.id(v)}"`
        })
      }
    : {})
})

/** Words of the original content (5+ letters) that are still in the output. */
function leaked(s: Synthesizer, out: ReadonlyArray<Capture>): Array<string> {
  const ours = new Set([...WORDS, ...TAGS.flatMap((t) => t.split("-")), ...STRUCTURAL, "https", "example"])
  const text = out
    .filter((c) => c.name !== "capabilities")
    .map((c) => JSON.stringify(c))
    .join("\n")
    .toLowerCase()
  const outputWords = new Set(text.match(/[a-z]{5,}/g) ?? [])
  const found = new Set<string>()
  // Our words are all plain ASCII: any other letter came from a card.
  for (const c of out)
    if (c.name !== "capabilities")
      for (const letter of JSON.stringify(c).match(/[^\x00-\x7f]/g) ?? []) found.add(letter)
  for (const original of s.replaced)
    for (const word of original.toLowerCase().match(/[a-z]{5,}/g) ?? [])
      if (!ours.has(word) && outputWords.has(word) && !apiWord(word, out)) found.add(word)
  return [...found]
}

/** A word that is part of the API itself: a key, or a kept value or header. */
let apiWords: Set<string> | null = null
function apiWord(word: string, out: ReadonlyArray<Capture>) {
  if (!apiWords) {
    apiWords = new Set<string>()
    const add = (text: string) => {
      for (const w of text.toLowerCase().match(/[a-z]{5,}/g) ?? []) apiWords!.add(w)
    }
    const walk = (value: unknown, key: string) => {
      if (Array.isArray(value)) for (const v of value) walk(v, key)
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) {
          add(k)
          walk(v, k)
        }
      else if (typeof value === "string" && (KEPT_KEYS.has(key) || key === "message" || SITE_KEYS.has(key))) add(value)
    }
    for (const c of out) {
      add(c.name)
      walk(c.body, "")
      for (const [k, v] of Object.entries(c.headers)) {
        add(k)
        if (!["etag", "location"].includes(k)) add(v.replace(/filename="[^"]*"/, ""))
      }
    }
    walk(out.find((c) => c.name === "capabilities")?.body, "")
    for (const c of out) if (c.name === "capabilities") add(JSON.stringify(c.body))
  }
  return apiWords.has(word)
}

// --- Shapes: what the contract test compares.

/** A JSON value's kind, as the shape records it. */
const kindOf = (value: unknown) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? "integer"
            : "number"
          : typeof value

/** An object key in a shape path: a map's own keys (slugs, numbers) all count as one, `*`. */
const shapeKey = (key: string) => (/^[a-z_][A-Za-z0-9_]*$/.test(key) ? key : "*")

/** Every `path: kind` in a JSON value; a number may stand where an integer was. */
function shapeOf(value: unknown, path = "$", out = new Set<string>()): Set<string> {
  const kind = kindOf(value)
  out.add(`${path}: ${kind}`)
  if (kind === "array") for (const item of value as Array<unknown>) shapeOf(item, `${path}[]`, out)
  if (kind === "object")
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      shapeOf(item, `${path}.${shapeKey(key)}`, out)
  return out
}

/** A capture's shape: its status, its header names, its body. */
export const captureShape = (capture: Capture): Set<string> => {
  const out = capture.body === undefined ? new Set<string>() : shapeOf(capture.body)
  out.add(`status: ${capture.status}`)
  for (const header of Object.keys(capture.headers)) out.add(`header: ${header}`)
  if (capture.bodyInfo) out.add(`body: ${capture.bodyInfo.magic ? "bytes" : "empty"}`)
  return out
}

/** What `actual` lacks of `expected`'s shape (an integer counts as a number). */
const shapeGaps = (expected: ReadonlySet<string>, actual: ReadonlySet<string>) =>
  [...expected].filter(
    (line) => !actual.has(line) && !(line.endsWith(": integer") && actual.has(line.replace(/integer$/, "number")))
  )

/**
 * For `capture.ts --verify`: each line names a capture and a field, header or value the live
 * API has (`live`) that the committed fixtures (`fixtures`) lack, and every difference in the
 * capabilities description, which the fixtures keep verbatim.
 */
export function missingShapes(fixtures: ReadonlyArray<Capture>, live: ReadonlyArray<Capture>): Array<string> {
  const lines: Array<string> = []
  const byName = new Map(fixtures.map((c) => [c.name, c]))
  for (const capture of live) {
    const fixture = byName.get(capture.name)
    if (!fixture) {
      lines.push(`${capture.name}: not in the fixtures`)
      continue
    }
    for (const gap of shapeGaps(captureShape(capture), captureShape(fixture))) lines.push(`${capture.name}: ${gap}`)
    if (capture.name === "capabilities" && JSON.stringify(capture.body) !== JSON.stringify(fixture.body))
      lines.push("capabilities: the description changed")
  }
  return lines
}

/**
 * Which kind of response a capture is: captures of one kind (every search, every card page)
 * are compared together, and the fake builds that kind from all of them. A refusal, a
 * redirect, a picture or a download is a kind of its own.
 */
export const responseKind = (name: string) =>
  name === "batch-missing"
    ? "batch"
    : name.startsWith("error-") ||
        /-missing$|bad-|not-canonical|not-modified|^capabilities$|^image-|^download-(?!json$|lorebook-json$)/.test(name)
      ? name
      : name.startsWith("search-")
        ? "search"
        : name.startsWith("count-")
          ? "count"
          : name.startsWith("tags")
            ? "tags"
            : name.startsWith("authors-suggest")
              ? "authors-suggest"
              : name.startsWith("batch")
                ? "batch"
                : /^card-|-origin$/.test(name)
                  ? "card"
                  : /-versions$/.test(name)
                    ? "versions"
                    : /-forks$/.test(name)
                      ? "forks"
                      : name

/**
 * Several captured values as one: an object with every key any of them has (each the union of
 * its values), a list of one element that unites all their elements, and otherwise the first
 * value that isn't null.
 */
export function unionOf(values: ReadonlyArray<unknown>): unknown {
  const present = values.filter((v) => v !== null && v !== undefined)
  if (present.length === 0) return values.length ? null : undefined
  if (present.every(Array.isArray)) {
    const items = (present as Array<Array<unknown>>).flat()
    return items.length ? [unionOf(items)] : []
  }
  const objects = present.filter((v): v is Record<string, unknown> => typeof v === "object" && !Array.isArray(v))
  if (objects.length === present.length) {
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))]
    return Object.fromEntries(keys.map((key) => [key, unionOf(objects.filter((o) => key in o).map((o) => o[key]))]))
  }
  return present[0]
}
