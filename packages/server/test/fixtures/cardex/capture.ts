// Captures cardex's public API v1 for the fixtures beside this file, then makes them synthetic.
// See README.md.
//
//   node packages/server/test/fixtures/cardex/capture.ts <api-origin> [--raw <dir>]
//   node packages/server/test/fixtures/cardex/capture.ts <api-origin> --verify
//
// The first form fetches every response the fake archive imitates (read-only GETs, one at a
// time, about a second apart), keeps the untouched responses in a directory outside the repo
// (a new temporary one unless `--raw` names one), and writes the synthetic copies here. The
// second fetches the same and writes nothing: it reports every field, parameter or value the
// live API has that the committed fixtures lack, and exits 1 if there is any.
// `--from-raw <dir>` re-synthesizes an earlier capture without fetching anything.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Capture, captureNames, missingShapes, synthesize } from "./synthesize.ts"

/** A JSON body as the API sent it: any shape, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the captured JSON has no static type
type Json = Record<string, any>

const here = dirname(fileURLToPath(import.meta.url))
const GAP_MS = 1100
/** Headers kept from each response: what describes the API, not the CDN in front of it. */
const KEPT_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "location",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "content-disposition",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "accept-ranges",
  "x-content-type-options",
  "vary"
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchAll(origin: string): Promise<Array<Capture>> {
  const captures: Array<Capture> = []
  let last = 0
  const get = async (
    name: string,
    path: string,
    query: Record<string, string> = {},
    options: { binary?: boolean; headers?: Record<string, string> } = {}
  ): Promise<Capture> => {
    const wait = last + GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    const url = new URL(path, origin)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "fixture-capture/1.0", ...options.headers }
    })
    last = Date.now()
    const headers = Object.fromEntries(
      KEPT_HEADERS.flatMap((key) => {
        const value = response.headers.get(key)
        return value === null ? [] : [[key, value]]
      })
    )
    const bytes = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get("content-type") ?? ""
    const json = !options.binary && type.includes("json")
    const capture: Capture = {
      name,
      request: { path, query },
      status: response.status,
      headers,
      ...(json
        ? { body: JSON.parse(bytes.toString("utf8")) as unknown }
        : { bodyInfo: { bytes: bytes.length, magic: bytes.subarray(0, 4).toString("hex") } })
    }
    captures.push(capture)
    console.error(`${response.status} ${name} ${url.pathname}${url.search}`)
    return capture
  }
  const body = (capture: Capture) => capture.body as Json

  const capabilities = await get("capabilities", "/api/v1/capabilities")
  // A conditional request with the ETag it gave.
  if (capabilities.headers.etag)
    await get(
      "capabilities-not-modified",
      "/api/v1/capabilities",
      {},
      { headers: { "if-none-match": capabilities.headers.etag } }
    )
  const first = body(await get("search-default", "/api/v1/search"))
  await get("search-sort-popular", "/api/v1/search", { sort: "popular", limit: "3" })
  for (const sort of [
    "relevance",
    "newest",
    "oldest",
    "created_desc",
    "created_asc",
    "name",
    "name_desc",
    "tokens_asc",
    "tokens_desc"
  ])
    await get(`search-sort-${sort}`, "/api/v1/search", { q: "dragon", sort, limit: "1" })
  await get("search-q", "/api/v1/search", { q: "dragon", limit: "2" })
  for (const fields of ["name", "description", "character", "lorebook"])
    await get(`search-fields-${fields}`, "/api/v1/search", { q: "dragon", fields, limit: "1" })
  for (const nsfw of ["include", "exclude", "only"])
    await get(`search-nsfw-${nsfw}`, "/api/v1/search", { nsfw, limit: "1" })
  const kinds: Record<string, Json> = {}
  for (const kind of ["character", "lorebook", "both", "character_lorebook"])
    kinds[kind] = body(await get(`search-kind-${kind}`, "/api/v1/search", { kind, limit: "2" }))
  await get("search-source", "/api/v1/search", { source: "chub", limit: "1" })
  await get("search-source-two", "/api/v1/search", { source: "chub,risuai", limit: "1" })
  await get("search-not-source", "/api/v1/search", { not_source: "chub", limit: "1" })
  await get("search-tags", "/api/v1/search", { tags: "fantasy", limit: "1" })
  await get("search-not-tags", "/api/v1/search", { not_tags: "fantasy", limit: "1" })
  await get("search-any-tags", "/api/v1/search", { any_tags: "fantasy|magic,adventure|mystery", limit: "1" })
  await get("search-unknown-tag", "/api/v1/search", { tags: "zzqx-no-such-tag", limit: "1" })
  await get("search-min-tokens", "/api/v1/search", { min_tokens: "1000", limit: "1" })
  await get("search-max-tokens", "/api/v1/search", { max_tokens: "2000", limit: "1" })
  await get("search-has-cover-false", "/api/v1/search", { has_cover: "false", limit: "1" })
  const author = first.items.find((item: Json) => item.creator?.source && item.creator?.handle)?.creator
  const others = first.items
    .map((item: Json) => item.creator)
    .filter((c: Json) => c?.source && c?.handle && `${c.source}/${c.handle}` !== `${author.source}/${author.handle}`)
  const identity = `${author.source}/${author.handle}`
  const second = others[0] ? `${others[0].source}/${others[0].handle}` : identity
  await get("search-author", "/api/v1/search", { author: identity, limit: "1" })
  await get("search-author-unknown", "/api/v1/search", { author: "chub/zzqx-no-such-author", limit: "1" })
  await get("search-any-author", "/api/v1/search", { any_author: `${identity},${second}`, limit: "1" })
  await get("search-not-author", "/api/v1/search", { not_author: identity, limit: "1" })
  const picture = /\/t\/([0-9a-f]{64})\./.exec(first.items[0].thumbnail_url ?? "")?.[1]
  if (picture) await get("search-picture", "/api/v1/search", { picture, limit: "1" })
  await get("search-added", "/api/v1/search", { added_after: "2026-01-01", added_before: "2026-06-01", limit: "1" })
  await get("search-created", "/api/v1/search", {
    created_after: "2025-01-01",
    created_before: "2025-06-01",
    limit: "1"
  })
  for (const flag of ["exclude_forks", "deleted_from_source", "deleted_from_any_source"])
    await get(`search-${flag.replaceAll("_", "-")}`, "/api/v1/search", { [flag]: "true", limit: "1" })
  for (const flag of ["chub_verified", "chub_recommended"])
    await get(`search-${flag.replaceAll("_", "-")}`, "/api/v1/search", { source: "chub", [flag]: "true", limit: "1" })
  await get("search-semantic", "/api/v1/search", { q: "dragon", mode: "semantic", limit: "2" })
  await get("search-semantic-page-2", "/api/v1/search", { q: "dragon", mode: "semantic", limit: "2", page: "2" })
  const paged = body(await get("search-limit", "/api/v1/search", { sort: "popular", limit: "2" }))
  if (paged.next_cursor)
    await get("search-cursor", "/api/v1/search", { sort: "popular", limit: "2", cursor: paged.next_cursor })
  await get("search-page-2", "/api/v1/search", { sort: "popular", limit: "2", page: "2" })
  await get("count-default", "/api/v1/search/count")
  await get("count-q", "/api/v1/search/count", { q: "dragon" })
  await get("count-filtered", "/api/v1/search/count", { tags: "fantasy", nsfw: "exclude" })
  // Misuse, each as the archive refuses it.
  await get("error-limit-0", "/api/v1/search", { limit: "0" })
  await get("error-limit-101", "/api/v1/search", { limit: "101" })
  await get("error-cursor", "/api/v1/search", { cursor: "bm90LWEtY3Vyc29y" })
  await get("error-source", "/api/v1/search", { source: "zzqx" })
  await get("error-chub-verified", "/api/v1/search", { chub_verified: "true" })
  await get("error-mode", "/api/v1/search", { mode: "zzqx" })
  await get("error-sort", "/api/v1/search", { sort: "zzqx" })
  await get("error-page-0", "/api/v1/search", { page: "0" })
  await get("error-semantic-cursor", "/api/v1/search", { q: "dragon", mode: "semantic", cursor: "bm90LWEtY3Vyc29y" })
  await get("error-tags-21", "/api/v1/search", {
    tags: Array.from({ length: 21 }, (_, n) => `tag-${n}`).join(",")
  })
  // Suggestions.
  const tags = body(await get("tags", "/api/v1/tags", { limit: "10" }))
  await get("tags-prefix", "/api/v1/tags", { limit: "10", q: "fan" })
  if (tags.next) await get("tags-cursor", "/api/v1/tags", { limit: "10", cursor: tags.next })
  await get("tags-bad-cursor", "/api/v1/tags", { limit: "10", cursor: "bm90LWEtY3Vyc29y" })
  const authors = body(await get("authors-suggest", "/api/v1/search/authors", { limit: "10", q: "a" }))
  if (authors.next)
    await get("authors-suggest-cursor", "/api/v1/search/authors", { limit: "10", q: "a", cursor: authors.next })
  await get("authors-suggest-bad-cursor", "/api/v1/search/authors", { limit: "10", cursor: "bm90LWEtY3Vyc29y" })
  // Cards: a character, one with a lorebook, a standalone lorebook, a forked one, a forked-from one.
  const character = first.items[0].slug as string
  const withBook = (kinds.character_lorebook?.items[0]?.slug as string | undefined) ?? character
  const lorebook = kinds.lorebook?.items[0]?.slug as string | undefined
  const ids = [...new Set([character, withBook])].sort()
  await get("batch", "/api/v1/cards/batch", { ids: ids.join(",") })
  if (lorebook) await get("batch-lorebook", "/api/v1/cards/batch", { ids: lorebook })
  await get("batch-missing", "/api/v1/cards/batch", { ids: [character, "zzqx-no-such-card"].sort().join(",") })
  await get("batch-not-canonical", "/api/v1/cards/batch", { ids: `${ids.at(-1)},${ids[0]},${ids[0]}` })
  const detail = async (name: string, slug: string) =>
    body(await get(name, `/api/v1/cards/${encodeURIComponent(slug)}`))
  const characterDetail = await detail("card-character", character)
  const bookDetail = withBook === character ? characterDetail : await detail("card-character-lorebook", withBook)
  const lorebookDetail = lorebook ? await detail("card-lorebook", lorebook) : null
  await get("card-missing", "/api/v1/cards/zzqx-no-such-card")
  // A popular card is likely to have forks and versions.
  const popular = body(await get("search-forked", "/api/v1/search", { source: "chub", sort: "popular", limit: "48" }))
  const forkedSummary = popular.results?.find((r: Json) => r.fork_count > 0) ?? popular.results?.[0]
  const forkedDetail = forkedSummary ? await detail("card-forked", forkedSummary.slug) : characterDetail
  const originOf = (d: Json | null) => d?.origins?.find((o: Json) => o.source && o.external_id)
  const familyOf = async (prefix: string, d: Json | null) => {
    const origin = originOf(d)
    if (!origin) return null
    const path = `${encodeURIComponent(origin.source)}/${encodeURIComponent(origin.external_id)}`
    await get(`${prefix}-origin`, `/api/v1/origins/${path}`)
    await get(`${prefix}-versions`, `/api/v1/versions/${path}`)
    return body(await get(`${prefix}-forks`, `/api/v1/forks/${path}`))
  }
  const forks = await familyOf("forked", forkedDetail)
  await familyOf("character", characterDetail)
  if (lorebookDetail) await familyOf("lorebook", lorebookDetail)
  const child = forks?.children?.find((c: Json) => c.card?.slug)?.card?.slug as string | undefined
  if (child) await familyOf("fork", await detail("card-fork", child))
  // An earlier version: its own card, superseded by the current one.
  const older = captures
    .filter((c) => c.name.endsWith("-versions") && c.status === 200)
    .flatMap((c) => body(c).items ?? [])
    .find((i: Json) => i.version && !i.version.is_current && i.version.slug)?.version.slug as string | undefined
  if (older) {
    await get("batch-older-version", "/api/v1/cards/batch", { ids: older })
    await detail("card-older-version", older)
  }
  await get("origin-missing", "/api/v1/origins/chub/zzqx-no-such-origin")
  await get("versions-missing", "/api/v1/versions/chub/zzqx-no-such-origin")
  await get("forks-missing", "/api/v1/forks/chub/zzqx-no-such-origin")
  // A creator's profile.
  await get("author", `/api/v1/authors/${encodeURIComponent(author.source)}/${encodeURIComponent(author.handle)}`)
  await get("author-missing", "/api/v1/authors/chub/zzqx-no-such-author")
  // Downloads: the mirrored PNG, self-contained, original as headers; the JSON in full.
  const sha = (d: Json) => (d.files?.find((f: Json) => f.current) ?? d.files?.[0])?.sha256 as string
  const fileSha = sha(bookDetail)
  for (const mode of ["mirrored", "self-contained", "original"])
    await get(`download-${mode}`, `/api/v1/download/${fileSha}`, { mode }, { binary: true })
  await get("download-json", `/api/v1/download/${fileSha}`, { mode: "json" })
  if (lorebookDetail) await get("download-lorebook-json", `/api/v1/download/${sha(lorebookDetail)}`, { mode: "json" })
  await get("download-bad-mode", `/api/v1/download/${fileSha}`, { mode: "zzqx" })
  await get("download-missing", `/api/v1/download/${"0".repeat(64)}`, { mode: "json" })
  // Pictures, headers only.
  const thumb = first.items[0].thumbnail_url as string | null
  const image = first.items[0].image_url as string | null
  if (thumb) {
    const url = new URL(thumb, origin)
    await get("image-thumb-512", url.pathname, Object.fromEntries(url.searchParams), { binary: true })
    await get("image-thumb-64", url.pathname.replace(".512.", ".64."), Object.fromEntries(url.searchParams), {
      binary: true
    })
  }
  if (image) await get("image-full", new URL(image, origin).pathname, {}, { binary: true })
  await get("image-missing", `/t/${"0".repeat(64)}.512.webp`, {}, { binary: true })
  return captures
}

const readRaw = (dir: string): Array<Capture> =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Capture)

const committed = (): Array<Capture> =>
  captureNames(here).map((name) => JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")) as Capture)

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }
  if (!args[0] || args[0].startsWith("--")) {
    console.error("usage: capture.ts <api-origin> [--raw <dir>] [--verify] [--from-raw <dir>]")
    process.exit(2)
  }
  const origin = new URL(args[0]).origin
  const fromRaw = flag("--from-raw")
  const raw = fromRaw ? readRaw(fromRaw) : await fetchAll(origin)
  if (!fromRaw) {
    const dir = flag("--raw") ?? mkdtempSync(join(tmpdir(), "cardex-capture-"))
    mkdirSync(dir, { recursive: true })
    for (const capture of raw) writeFileSync(join(dir, `${capture.name}.json`), `${JSON.stringify(capture, null, 2)}\n`)
    console.error(`untouched responses (never commit them): ${dir}`)
  }
  const synthetic = synthesize(raw, origin)
  if (args.includes("--verify")) {
    const missing = missingShapes(committed(), synthetic)
    for (const line of missing) console.log(line)
    console.error(
      missing.length ? `${missing.length} difference(s) from the fixtures` : "the fixtures match the live API"
    )
    process.exit(missing.length ? 1 : 0)
  }
  for (const name of captureNames(here)) rmSync(join(here, `${name}.json`))
  for (const capture of synthetic)
    writeFileSync(join(here, `${capture.name}.json`), `${JSON.stringify(capture, null, 2)}\n`)
  console.error(`wrote ${synthetic.length} synthetic fixtures to ${here}`)
}

await main()
