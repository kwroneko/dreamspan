// Where a card came from: links to the archives and sites it was uploaded to, built from its
// CCv3 `source` entries and the fields sites write into `data.extensions`. Each site is a
// recognizer in a registry, so a plugin can add a site, replace one or disable one.
import { CARDEX_SITE_LABELS } from "@dreamspan/shared/cardSources.ts"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { makeRegistry } from "../../registry.ts"

/** The parts of a card a recognizer reads. */
export type SourceInput = Pick<CardDoc, "source" | "extensions" | "creator" | "creator_notes">

interface SourceLink {
  /** The site's name; a recognizer's own `site` when left out. */
  readonly site?: string
  readonly url: string
  /** Shown in place of the URL: a card's path on the site, say. */
  readonly label?: string
  /** The `source` entry this link stands for, so it isn't listed a second time. */
  readonly from?: string
}

export interface SourceRecognizer {
  readonly id: string
  readonly site: string
  readonly links: (doc: SourceInput) => ReadonlyArray<SourceLink>
}

export type CardSource =
  | { readonly kind: "link"; readonly site: string; readonly url: string; readonly label?: string }
  /** A `source` entry that is an id no recognizer claimed: shown as text, with no link. */
  | { readonly kind: "id"; readonly id: string }

export const sourceRecognizers = makeRegistry<SourceRecognizer>()

/** The URL in its canonical spelling, when it is an http(s) URL; anything else never links. */
const webUrl = (text: string): URL | undefined => {
  if (!/^https?:\/\//i.test(text.trim())) return undefined
  try {
    const url = new URL(text.trim())
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

const hostOf = (url: URL) => url.hostname.replace(/^www\./, "")

/**
 * Every link the enabled recognizers find, in registry order, then the `source` entries none
 * of them stood for: URLs as plain links named by their host, other entries as ids.
 */
export const cardSources = (
  doc: SourceInput,
  recognizers: ReadonlyArray<SourceRecognizer> = sourceRecognizers.list()
): ReadonlyArray<CardSource> => {
  const out: Array<CardSource> = []
  const seen = new Set<string>()
  const claimed = new Set<string>()
  const add = (site: string, url: URL, label?: string) => {
    if (seen.has(url.href)) return
    seen.add(url.href)
    out.push({ kind: "link", site, url: url.href, ...(label ? { label } : {}) })
  }
  for (const recognizer of recognizers) {
    let links: ReadonlyArray<SourceLink>
    try {
      links = recognizer.links(doc)
    } catch {
      continue // a broken recognizer drops its own links, not the list
    }
    for (const link of links) {
      if (link.from !== undefined) claimed.add(link.from)
      const url = webUrl(link.url)
      if (url) add(link.site ?? recognizer.site, url, link.label)
    }
  }
  const ids = new Set<string>()
  for (const entry of doc.source ?? []) {
    if (claimed.has(entry)) continue
    const url = webUrl(entry)
    if (url) add(hostOf(url), url)
    else if (entry.trim() && !ids.has(entry.trim())) {
      ids.add(entry.trim())
      out.push({ kind: "id", id: entry.trim() })
    }
  }
  return out
}

// Built-in recognizers --------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** `source` URLs on one of `hosts` (with or without `www.`), linked as they are. */
const byHost =
  (hosts: ReadonlyArray<string>) =>
  (doc: SourceInput): ReadonlyArray<SourceLink> =>
    (doc.source ?? []).flatMap((entry) => {
      const url = webUrl(entry)
      return url && hosts.includes(hostOf(url)) ? [{ url: url.href, from: entry }] : []
    })

// chub.ai. Cards downloaded from chub carry `extensions.chub` with `full_path`
// ("<creator>/<slug>") and a numeric `id`; seen in chub's public API
// (api.chub.ai/api/characters/<full_path>?full=true → node.definition.extensions.chub), which
// SillyTavern copies verbatim (src/endpoints/content-manager.js, downloadChubCharacter). The
// character page is https://chub.ai/characters/<full_path> and the creator's is
// https://chub.ai/users/<creator>, the links chub's own search API returns in descriptions.
// characterhub.org is chub's former domain (ST's parseChubUrl accepts both).
const CHUB_HOSTS = ["chub.ai", "characterhub.org"]
const chubPath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/")
const chubRecognizer: SourceRecognizer = {
  id: "card-sources.chub",
  site: "Chub",
  links: (doc) => {
    const links: Array<SourceLink> = []
    const fullPath = text(record(doc.extensions["chub"])?.["full_path"])
    if (fullPath && fullPath.split("/").filter(Boolean).length >= 2) {
      links.push({ url: `https://chub.ai/characters/${chubPath(fullPath)}`, label: fullPath })
    }
    for (const entry of doc.source ?? []) {
      const url = webUrl(entry)
      if (!url || !CHUB_HOSTS.includes(hostOf(url))) continue
      const [kind, ...rest] = url.pathname.split("/").filter(Boolean)
      if ((kind === "characters" || kind === "lorebooks") && rest.length >= 2) {
        links.push({
          url: `https://chub.ai/${kind}/${rest.join("/")}`,
          label: decodeURIComponent(rest.join("/")),
          from: entry
        })
      } else links.push({ url: url.href, from: entry })
    }
    const creator = fullPath?.split("/").filter(Boolean)[0]
    if (creator && fullPath!.split("/").filter(Boolean).length >= 2) {
      links.push({ url: `https://chub.ai/users/${encodeURIComponent(creator)}`, label: `Creator: ${creator}` })
    }
    return links
  }
}

// RisuRealm. Character pages are https://realm.risuai.net/character/<id> (SillyTavern's
// parseRisuUrl, src/endpoints/content-manager.js). RisuAI keeps a card's sources in
// `extensions.risuai.source` when it exports V2 and reads them back from there or from
// `source` (RisuAI src/ts/characterCards.ts), so entries there count as sources too: realm
// URLs are named RisuRealm, other URLs are plain links.
const risuRecognizer: SourceRecognizer = {
  id: "card-sources.risurealm",
  site: "RisuRealm",
  links: (doc) => {
    const risuSource = record(doc.extensions["risuai"])?.["source"]
    const extra = Array.isArray(risuSource) ? risuSource.filter((e): e is string => typeof e === "string") : []
    return [...(doc.source ?? []), ...extra].flatMap((entry): ReadonlyArray<SourceLink> => {
      const url = webUrl(entry)
      if (!url) return []
      if (hostOf(url) === "realm.risuai.net") return [{ url: url.href, from: entry }]
      return extra.includes(entry) ? [{ site: hostOf(url), url: url.href, from: entry }] : []
    })
  }
}

// cardex (cardex.zip), a public card archive (its API v1, https://cardex.zip/docs/api). A card's
// page there is https://cardex.zip/c/<slug>, and its page for one site's listing of it is
// https://cardex.zip/<site>/<id> (`site` the site's v1 name, `id` its id there). A card added from
// cardex has its /c/ URL in `source`, or `cardex:<slug>` when cardex gave none
// (spec/CARD-SOURCES.md §4.5). Files cardex serves carry `extensions.cardex`: `url`, the page for
// the listing the file came from (a /<site>/<id> URL), and `origins`, each a page on a site cardex
// found it on (`source` its site's v1 name, `url` the page), linked under that site's name.
const CARDEX_HOST = "cardex.zip"
// First path segments on cardex that aren't a site: pictures, thumbnails, creators, the API, docs.
const CARDEX_NOT_SITES = new Set(["api", "docs", "i", "t", "u"])
const decoded = (part: string) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}
/** The label for a cardex page: a card's slug, or the site and id of a listing's page. */
const cardexLabel = (url: URL) => {
  const [first, ...rest] = url.pathname.split("/").filter(Boolean)
  if (!first || !rest.length) return undefined
  if (first === "c") return rest.length === 1 ? decoded(rest[0]!) : undefined
  if (!/^[a-z0-9_]{1,40}$/.test(first) || CARDEX_NOT_SITES.has(first)) return undefined
  return `${CARDEX_SITE_LABELS[first] ?? first}: ${rest.map(decoded).join("/")}`
}
const cardexRecognizer: SourceRecognizer = {
  id: "card-sources.cardex",
  site: "cardex",
  links: (doc) => {
    const links: Array<SourceLink> = []
    const extension = record(doc.extensions["cardex"])
    const page = webUrl(text(extension?.["url"]) ?? "")
    if (page && hostOf(page) === CARDEX_HOST) {
      const label = cardexLabel(page)
      links.push({ url: page.href, ...(label ? { label } : {}) })
    }
    for (const entry of doc.source ?? []) {
      const id = /^cardex:(.+)$/.exec(entry.trim())?.[1]?.trim()
      if (id) {
        links.push({ url: `https://${CARDEX_HOST}/c/${encodeURIComponent(id)}`, label: id, from: entry })
        continue
      }
      const url = webUrl(entry)
      if (!url || hostOf(url) !== CARDEX_HOST) continue
      const label = cardexLabel(url)
      links.push({ url: url.href, ...(label ? { label } : {}), from: entry })
    }
    const origins = extension?.["origins"]
    for (const origin of Array.isArray(origins) ? origins : []) {
      const found = record(origin)
      const url = webUrl(text(found?.["url"]) ?? "")
      if (!url || hostOf(url) === CARDEX_HOST) continue
      const site = text(found?.["source"])
      links.push({ site: (site && CARDEX_SITE_LABELS[site]) ?? hostOf(url), url: url.href })
    }
    return links
  }
}

// The other sites SillyTavern imports characters from by URL (src/endpoints/content-manager.js,
// the /importURL host checks): a `source` URL on their host gets the site's name. None of them
// writes a field of its own into the card that names its page, so only URLs are recognized.
const hostRecognizer = (id: string, site: string, hosts: ReadonlyArray<string>): SourceRecognizer => ({
  id: `card-sources.${id}`,
  site,
  links: byHost(hosts)
})
export const builtinRecognizers: ReadonlyArray<SourceRecognizer> = [
  chubRecognizer,
  risuRecognizer,
  hostRecognizer("janitorai", "JanitorAI", ["janitorai.com"]),
  hostRecognizer("jannyai", "JannyAI", ["jannyai.com"]),
  hostRecognizer("pygmalion", "Pygmalion", ["pygmalion.chat"]),
  hostRecognizer("aicharactercards", "AI Character Cards", ["aicharactercards.com"]),
  hostRecognizer("perchance", "Perchance", ["perchance.org"]),
  cardexRecognizer
]
