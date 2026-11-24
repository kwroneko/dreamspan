// The fake cardex against the captures of the live API (test/fixtures/cardex, README.md): for
// every capture, the fake answers the same request (with its own cards in place of the
// captured ones) with the same status, the same headers, and every field and kind of value the
// capture had, so the fake can't drift from cardex by hand. Its capabilities and its errors are
// the captured ones exactly. No request leaves this machine; `capture.ts --verify <api-url>`
// checks the captures themselves against the live API.
import { afterAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Capture, captureNames, captureShape, responseKind } from "./fixtures/cardex/synthesize.ts"
import { startFakeCardex } from "./support/fakeCardex.ts"

const dir = fileURLToPath(new URL("./fixtures/cardex/", import.meta.url))
const fixtures = captureNames(dir).map((name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Capture)
const named = (name: string) => fixtures.find((c) => c.name === name)

const fake = await startFakeCardex({ cards: 240 })
afterAll(() => fake.close())

/** What the fake answers, as a capture. */
const ask = async (name: string, path: string, query: Record<string, string>): Promise<Capture> => {
  const url = new URL(path, fake.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const headers: Record<string, string> = {}
  const etag = named("capabilities")?.headers.etag
  if (name === "capabilities-not-modified") {
    const first = await fetch(url)
    await first.arrayBuffer()
    headers["if-none-match"] = first.headers.get("etag") ?? etag ?? ""
  }
  const response = await fetch(url, { redirect: "manual", headers })
  const bytes = Buffer.from(await response.arrayBuffer())
  const type = response.headers.get("content-type") ?? ""
  return {
    name,
    request: { path, query },
    status: response.status,
    headers: Object.fromEntries(
      [...response.headers].filter(
        ([key]) =>
          key !== "date" &&
          key !== "connection" &&
          key !== "keep-alive" &&
          key !== "content-length" &&
          key !== "transfer-encoding"
      )
    ),
    ...(type.includes("json") &&
    (!/^(download|image)-/.test(name) || response.status >= 400 || /^download-(lorebook-)?json$/.test(name))
      ? { body: JSON.parse(bytes.toString("utf8")) as unknown }
      : { bodyInfo: { bytes: bytes.length, magic: bytes.subarray(0, 4).toString("hex") } })
  }
}

// The fake's own cards, standing in for the captured ones.
// Cards with what the captured ones had: a nickname, extra greetings, a creator's picture.
const pictured = (c: (typeof fake.cards)[number]) => c.hasCover && c.creatorKind === "account" && c.creator !== "lumen"
const character = fake.cards.find(
  (c) =>
    !c.hasLorebook &&
    !c.fork &&
    pictured(c) &&
    c.json.includes('"nickname"') &&
    !c.json.includes('"alternate_greetings":[]')
)!
const withBook = fake.cards.find((c) => c.hasLorebook && !c.originalOnly)!
const lorebook = fake.lorebooks[0]!
// A forked card with a fork that has a lorebook, as the captured one had.
const forked =
  fake.cards.find((c) => pictured(c) && fake.cards.some((other) => other.parent === c.slug && other.hasLorebook)) ??
  fake.cards.find((c) => fake.cards.some((other) => other.parent === c.slug))!
const fork = (fake.cards.find((c) => c.parent === forked.slug && c.hasLorebook) ??
  fake.cards.find((c) => c.parent === forked.slug))!
const older = `${fake.cards[1]!.slug}-v09`
const accounts = [
  ...new Set(fake.cards.flatMap((c) => (c.creatorKind === "account" ? [`${c.site}/${c.creator}`] : [])))
]
const origin = (c: { site: string; slug: string }) => `${c.site}/${encodeURIComponent(`ext-${c.slug}`)}`
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake's JSON, read field by field
const json = async (path: string) => (await (await fetch(new URL(path, fake.origin))).json()) as Record<string, any>

/** The fake's request for a capture's: the same endpoint and parameters, the fake's cards and tags. */
async function requestFor(capture: Capture): Promise<{ path: string; query: Record<string, string> }> {
  const { name } = capture
  const query = { ...capture.request.query }
  const keepsValues =
    name.startsWith("error-") || name.endsWith("-missing") || name.endsWith("-unknown") || name.includes("bad-")
  if (!keepsValues) {
    if (query.q !== undefined) query.q = query.mode === "semantic" ? "quiet lantern" : "amber"
    if (query.tags !== undefined && name !== "search-unknown-tag") query.tags = "fantasy"
    if (query.not_tags !== undefined) query.not_tags = "fantasy"
    if (query.any_tags !== undefined) query.any_tags = "fantasy|magic,adventure|mystery"
    if (query.author !== undefined) query.author = accounts[0]!
    if (query.any_author !== undefined) query.any_author = `${accounts[0]},${accounts[1]}`
    if (query.not_author !== undefined) query.not_author = accounts[0]!
    if (query.picture !== undefined) query.picture = character.sha256
  }
  if (name === "search-cursor") query.cursor = (await json("/api/v1/search?sort=popular&limit=2")).next_cursor
  if (name === "tags-cursor") query.cursor = (await json("/api/v1/tags?limit=10")).next
  if (name === "authors-suggest" || name === "authors-suggest-cursor") query.q = "o"
  if (name === "authors-suggest-cursor") query.cursor = (await json("/api/v1/search/authors?limit=10&q=o")).next
  if (name === "tags-prefix") query.q = "fa"
  const ids = [character.slug, withBook.slug].sort()
  if (name === "batch") query.ids = ids.join(",")
  if (name === "batch-lorebook") query.ids = lorebook.slug
  if (name === "batch-missing") query.ids = [character.slug, "zzqx-no-such-card"].sort().join(",")
  if (name === "batch-not-canonical") query.ids = `${ids[1]},${ids[0]},${ids[0]}`
  if (name === "batch-older-version") query.ids = older
  const cardsByName: Record<string, string> = {
    "card-character": character.slug,
    "card-character-lorebook": withBook.slug,
    "card-lorebook": lorebook.slug,
    "card-forked": forked.slug,
    "card-fork": fork.slug,
    "card-older-version": older
  }
  if (cardsByName[name]) return { path: `/api/v1/cards/${cardsByName[name]}`, query }
  const family = /^(forked|character|lorebook|fork)-(origin|versions|forks)$/.exec(name)
  if (family) {
    const card = { forked, character, lorebook, fork }[family[1] as "forked"]
    return { path: `/api/v1/${family[2] === "origin" ? "origins" : family[2]}/${origin(card)}`, query }
  }
  if (name === "author") return { path: `/api/v1/authors/${accounts[0]}`, query }
  if (/^download-(mirrored|self-contained|original|json|bad-mode)$/.test(name))
    return { path: `/api/v1/download/${withBook.sha256}`, query }
  if (name === "download-lorebook-json") return { path: `/api/v1/download/${lorebook.sha256}`, query }
  if (name === "image-thumb-512") return { path: `/t/${character.sha256}.512.webp`, query }
  if (name === "image-thumb-64") return { path: `/t/${character.sha256}.64.webp`, query }
  if (name === "image-full") return { path: `/i/${character.sha256}.png`, query }
  return { path: capture.request.path, query }
}

const answers = new Map<string, Capture>()
for (const capture of fixtures) {
  const { path, query } = await requestFor(capture)
  answers.set(capture.name, await ask(capture.name, path, query))
}

describe("the fake cardex has what the live API had", () => {
  it("captures every endpoint the adapter calls", () => {
    for (const name of [
      "capabilities",
      "search-default",
      "search-semantic",
      "search-cursor",
      "count-default",
      "tags",
      "authors-suggest",
      "batch",
      "batch-not-canonical",
      "card-character",
      "card-lorebook",
      "forked-origin",
      "forked-versions",
      "forked-forks",
      "fork-forks",
      "author",
      "download-mirrored",
      "download-json",
      "image-thumb-512",
      "image-full"
    ])
      expect(named(name), name).toBeDefined()
  })

  it("serves the capabilities description exactly as captured", () => {
    expect(answers.get("capabilities")!.body).toEqual(named("capabilities")!.body)
  })

  it("refuses each misuse with the captured status, code and message", () => {
    for (const capture of fixtures.filter((c) => c.status >= 400 && c.body !== undefined))
      expect({
        name: capture.name,
        status: answers.get(capture.name)!.status,
        body: answers.get(capture.name)!.body
      }).toEqual({
        name: capture.name,
        status: capture.status,
        body: capture.body
      })
  })

  it("answers with each capture's status and headers", () => {
    for (const capture of fixtures) {
      const answer = answers.get(capture.name)!
      expect([capture.name, answer.status]).toEqual([capture.name, capture.status])
      const missing = Object.keys(capture.headers).filter((h) => !(h in answer.headers))
      expect([capture.name, missing]).toEqual([capture.name, []])
      for (const header of ["content-type", "cache-control", "access-control-allow-origin"])
        if (capture.headers[header] !== undefined)
          expect([capture.name, header, answer.headers[header]]).toEqual([
            capture.name,
            header,
            capture.headers[header]
          ])
    }
  })

  /**
   * Each kind of response's `path: kind` lines, from the captures and from the fake's answers.
   * A whole number and a fraction are one kind (a rating can be either). A downloaded file is
   * the card's own, which differs from card to card: only what cardex adds to it counts.
   */
  const byKind = () => {
    const kinds = new Map<string, { captured: Set<string>; fake: Set<string> }>()
    const lines = (kind: string, c: Capture) =>
      [...captureShape(c)]
        .map((line) => line.replace(/: integer$/, ": number").replace(/^(\$\.card\.token_counts\.fields)\.\w+/, "$1.*"))
        .filter(
          (line) =>
            !kind.startsWith("download-") || !line.startsWith("$.") || /^\$\.(data\.)?extensions\.cardex/.test(line)
        )
    for (const capture of fixtures) {
      const kind = responseKind(capture.name)
      const entry = kinds.get(kind) ?? { captured: new Set<string>(), fake: new Set<string>() }
      for (const line of lines(kind, capture)) entry.captured.add(line)
      for (const line of lines(kind, answers.get(capture.name)!)) entry.fake.add(line)
      kinds.set(kind, entry)
    }
    return kinds
  }
  const fieldOf = (line: string) => line.replace(/: \w+$/, "")

  it("has every field of each kind of response, with each kind of value it had besides null", () => {
    const gaps = [...byKind()].flatMap(([kind, { captured, fake }]) => {
      const fields = new Set([...fake].map(fieldOf))
      return [...captured]
        .filter((line) => (line.endsWith(": null") ? !fields.has(fieldOf(line)) : !fake.has(line)))
        .map((line) => `${kind}: ${line}`)
    })
    expect(gaps).toEqual([])
  })

  it("sends no field or kind of value cardex didn't", () => {
    const byKindCache = byKind()
    const extra = [...byKindCache].flatMap(([kind, { captured, fake }]) => {
      // An earlier origin's listing is an origin listing: the captures hold few of them.
      // A creator's picture is the picture an origin's author has.
      const as = (line: string) => [line, line.replace("$.earlier_origins[].listing.", "$.origins[].")]
      const pictures = byKindCache.get("card")?.captured ?? new Set<string>()
      const known = new Set([...captured].map(fieldOf))
      const kindsKnown = (field: string) => [...captured].some((l) => fieldOf(l) === field && !l.endsWith(": null"))
      return [...fake]
        .filter(
          (line) =>
            !(kind === "author" && pictures.has(line.replace("$.author.avatar", "$.origins[].author.avatar"))) &&
            !as(line).some(
              (l) =>
                captured.has(l) ||
                // null, or any kind where cardex only ever sent null, of a field cardex has
                (known.has(fieldOf(l)) && (l.endsWith(": null") || !kindsKnown(fieldOf(l))))
            )
        )
        .map((line) => `${kind}: ${line}`)
    })
    expect(extra).toEqual([])
  })
})
