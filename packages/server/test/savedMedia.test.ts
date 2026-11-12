// Saved card media (spec/SAVED-MEDIA.md) through real sockets, worker transactions and a local
// HTTP server with synthetic media. Host names resolve through a test resolver; the transport
// forwards each checked request to the local server, refusing redirects to other origins
// unless the fetcher accepts them, as Network does.
import { createServer, type Server } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_MEDIA_HOSTS, mediaKey } from "@rp/shared/savedMedia.ts"
import { Effect } from "effect"
import { SavedMedia, makeSavedMediaFetcher } from "../src/api/savedMedia.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { RedirectRefused, type NetworkShape, type TargetAddresses } from "../src/net/Network.ts"
import { documentMedia } from "../src/savedMedia/extract.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { cardDoc, docFor } from "./support/docs.ts"
import { loreEntry } from "./support/loreFixtures.ts"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)
const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.from([0, 1, 0, 0]), Buffer.alloc(64, 7)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>')
const PUBLIC = "93.184.216.34"

interface Seen {
  readonly host: string
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
}

/** The synthetic media sites, all one local server: the request's Host names the site. */
const mediaServer = () => {
  const seen: Seen[] = []
  const server: Server = createServer((request, response) => {
    const host = String(request.headers["x-test-host"] ?? "")
    const path = request.url ?? "/"
    seen.push({ host, path, headers: request.headers })
    const send = (type: string, body: Buffer) => response.writeHead(200, { "content-type": type }).end(body)
    if (path === "/pixel.png" || path === "/hover.png") send("image/png", PNG)
    else if (path === "/octet.png") send("application/octet-stream", PNG)
    else if (path === "/font.woff2") send("font/woff2", WOFF2)
    else if (path === "/page.html") send("image/png", Buffer.from("<!doctype html><title>not an image</title>"))
    else if (path === "/evil.svg") send("image/svg+xml", SVG)
    else if (path === "/big.png") send("image/png", Buffer.alloc(17 * 1024 * 1024, 1))
    else if (path === "/moved.png") response.writeHead(302, { location: "https://elsewhere.test/pixel.png" }).end()
    else if (path === "/cdn.png") response.writeHead(302, { location: "https://cdn.cards.test/pixel.png" }).end()
    else if (path === "/to-private.png") response.writeHead(302, { location: "https://private.test/pixel.png" }).end()
    else if (path === "/rebind.png") response.writeHead(302, { location: "/pixel.png?again" }).end()
    else response.writeHead(404).end()
  })
  return { server, seen }
}

/** A transport that checks every hop as Network does, then sends it to the local server. */
const forwarding = (port: number): Pick<NetworkShape, "fetchFor"> => ({
  fetchFor: (_override, _route, check?: TargetAddresses, crossOrigin?: (next: URL) => boolean) =>
    (async (input: string | URL, init: RequestInit = {}) => {
      let url = new URL(input)
      for (let hop = 0; ; hop++) {
        await check?.(url)
        const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
          ...init,
          redirect: "manual",
          headers: { ...(init.headers as Record<string, string>), "x-test-host": url.hostname }
        })
        const location = response.headers.get("location")
        if (!location) return response
        await response.body?.cancel()
        const next = new URL(location, url)
        if (next.origin !== url.origin && !crossOrigin?.(next)) throw new RedirectRefused("cross-origin")
        if (hop >= 5) throw new Error("redirect limit")
        url = next
      }
    }) as typeof fetch
})

const greeting = [
  '<img src="https://cards.test/pixel.png">',
  '<img src="https://cards.test/octet.png">',
  "<style>@font-face{font-family:Synth;src:url(https://cards.test/font.woff2)} .door:checked ~ .room{background:url('https://cards.test/hover.png')}</style>",
  "![a map](https://other.test/pixel.png)",
  '<a href="https://cards.test/link-only.png">a link is not media</a>',
  '<img src="https://cards.test/page.html">',
  '<img src="https://cards.test/evil.svg">',
  '<img src="https://cards.test/big.png">',
  '<img src="https://cards.test/moved.png">',
  '<img src="https://cards.test/cdn.png">',
  '<img src="https://cards.test/to-private.png">',
  '<img src="https://private.test/pixel.png">',
  '<img src="https://rebind.test/rebind.png">',
  '<img src="https://cards.test/{{user}}.png">',
  '<img src="https://declined.test/pixel.png">'
].join("\n")

describe("finding media in a document", () => {
  it("reads only places that load something, as the renderer parses them", () => {
    const { media } = documentMedia({
      first_mes: greeting,
      extensions: {
        regex_scripts: [
          { replaceString: '<div style="background-image:url(&quot;https://cards.test/style.png&quot;)">' }
        ]
      },
      avatar: "https://cards.test/not-media.png"
    })
    const urls = media.map((entry) => entry.url)
    assert.include(urls, "https://cards.test/pixel.png")
    assert.include(urls, "https://cards.test/style.png")
    assert.deepStrictEqual(media.find((entry) => entry.url.endsWith("font.woff2"))?.kind, "font")
    assert.include(urls, "https://other.test/pixel.png")
    assert.notInclude(urls, "https://cards.test/link-only.png")
    assert.notInclude(urls, "https://cards.test/not-media.png")
    assert.isFalse(urls.some((url) => url.includes("%7B%7B") || url.includes("{{")))
    assert.strictEqual(mediaKey("https://Cards.TEST/a b.png#frag"), "https://cards.test/a%20b.png")
  })
  it("names audio, video and their posters by their players", () => {
    const { media } = documentMedia(
      '<audio src="https://s.test/a.mp3"></audio><video poster="https://s.test/p.png"><source src="https://s.test/v.mp4"></video>'
    )
    assert.deepStrictEqual(
      media.map((entry) => [entry.url.slice(15), entry.kind]),
      [
        ["a.mp3", "audio"],
        ["p.png", "image"],
        ["v.mp4", "video"]
      ]
    )
  })
})

it.live("saves approved media once, serves it locally and leaves the card unchanged", () =>
  Effect.gen(function* () {
    const { server, seen } = mediaServer()
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))),
      () => Effect.promise(() => new Promise<void>((done) => server.close(() => done())))
    )
    const mediaPort = (server.address() as { port: number }).port
    let rebinds = 0
    const saved = yield* SavedMedia
    yield* saved.fetchers.register({
      id: "media.saved",
      fetch: makeSavedMediaFetcher(forwarding(mediaPort), {
        interfaces: () => ({}),
        resolve: async (host) =>
          host === "private.test" ? ["10.0.0.7"] : host === "rebind.test" && rebinds++ > 0 ? ["127.0.0.1"] : [PUBLIC]
      })
    })
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const user = yield* alice.Whoami()
    yield* bob.Whoami()
    const writer = yield* Writer
    const reader = yield* Reader
    const doc = cardDoc("Synthetic media", { first_mes: greeting })
    const { ref, entityId: mainId } = yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Synthetic media",
      subtitle: "",
      doc,
      schemaVersion: 1,
      origin: "import",
      sourcePath: null
    })
    const before = yield* reader.ExportSource({ userId: user.id, refId: ref.id })

    assert.deepStrictEqual(yield* alice.GetMediaHosts(), DEFAULT_MEDIA_HOSTS)
    // Nothing goes to a site the user hasn't approved.
    const asked = yield* alice.ListMediaApproval({ refIds: [ref.id] })
    assert.deepStrictEqual(asked.map((host) => host.host).sort(), [
      "cards.test",
      "declined.test",
      "other.test",
      "private.test",
      "rebind.test"
    ])
    assert.deepStrictEqual(
      asked.find((host) => host.host === "cards.test")?.kinds.find((k) => k.kind === "font")?.files,
      1
    )
    yield* saved.settle
    assert.strictEqual(seen.length, 0)
    assert.deepStrictEqual(yield* bob.ListMediaApproval({ refIds: [ref.id] }), [])

    yield* alice.DecideMediaApproval({
      refIds: [ref.id],
      decisions: [
        { host: "cards.test", choice: "approve-subdomains" },
        { host: "other.test", choice: "once" },
        { host: "private.test", choice: "once" },
        { host: "rebind.test", choice: "once" },
        { host: "declined.test", choice: "decline" }
      ]
    })
    assert.deepStrictEqual((yield* alice.GetMediaHosts()).hosts.at(-1), { host: "cards.test", subdomains: true })
    yield* saved.settle

    const status = yield* alice.GetSavedMediaStatus({ refId: ref.id })
    const reason = (path: string) => status.failed.find((entry) => entry.url.endsWith(path))?.reason
    // pixel, octet (sniffed, not trusted from its header), font, hover, other's pixel, the
    // subdomain redirect.
    assert.strictEqual(status.saved, 6)
    assert.strictEqual(status.declined, 1)
    assert.strictEqual(status.approval, 0)
    assert.strictEqual(reason("page.html"), "It isn't an image, sound, video or font this app keeps.")
    assert.strictEqual(reason("evil.svg"), "It isn't an image, sound, video or font this app keeps.")
    assert.strictEqual(reason("big.png"), "The file is too large.")
    assert.strictEqual(reason("moved.png"), "It moved to a site you haven't approved.")
    assert.strictEqual(reason("cards.test/to-private.png"), "It moved to a site you haven't approved.")
    assert.strictEqual(reason("private.test/pixel.png"), "Its address isn't a public web address.")
    assert.strictEqual(reason("rebind.png"), "Its address isn't a public web address.")
    // The private and declined sites were never contacted; nothing identifying was sent.
    assert.isFalse(seen.some((request) => ["private.test", "declined.test", "elsewhere.test"].includes(request.host)))
    for (const request of seen) {
      assert.isUndefined(request.headers.cookie)
      assert.isUndefined(request.headers.authorization)
      assert.isUndefined(request.headers.referer)
    }
    // Each address is fetched once, whatever entries name it.
    const pixels = seen.filter((request) => request.host === "cards.test" && request.path === "/pixel.png").length
    const copy = yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "A copy",
      subtitle: "",
      doc: cardDoc("A copy", { first_mes: '<img src="https://cards.test/pixel.png">' }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    assert.strictEqual((yield* alice.GetSavedMediaStatus({ refId: copy.ref.id })).saved, 1)
    yield* saved.settle
    assert.strictEqual(
      seen.filter((request) => request.host === "cards.test" && request.path === "/pixel.png").length,
      pixels
    )

    // Shown from here: the lookup maps the address, the route serves it to its owner only.
    const [found] = yield* alice.LookupSavedMedia({
      urls: ["https://cards.test/pixel.png", "https://nowhere.test/x.png"]
    })
    assert.strictEqual(found?.url, "https://cards.test/pixel.png")
    assert.isString(found?.mediaId)
    assert.deepStrictEqual(yield* bob.LookupSavedMedia({ urls: ["https://cards.test/pixel.png"] }), [])
    const port = yield* serverPort
    const get = (handle: string) =>
      Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/media/saved/${found!.mediaId}`, { headers: { "Remote-User": handle } })
      )
    const served = yield* get("alice")
    assert.strictEqual(served.status, 200)
    assert.deepStrictEqual(Buffer.from(yield* Effect.promise(() => served.arrayBuffer())), PNG)
    assert.strictEqual(served.headers.get("content-type"), "image/png")
    assert.strictEqual(served.headers.get("x-content-type-options"), "nosniff")
    assert.strictEqual(served.headers.get("content-disposition"), "attachment")
    assert.strictEqual(served.headers.get("cross-origin-resource-policy"), "same-origin")
    assert.strictEqual(
      served.headers.get("content-security-policy"),
      "sandbox; default-src 'none'; frame-ancestors 'none'"
    )
    assert.strictEqual((yield* get("bob")).status, 404)

    // The card is as it was: same head, same document, same export.
    const after = yield* reader.ExportSource({ userId: user.id, refId: ref.id })
    assert.deepStrictEqual(after, before)

    // Try again fetches the failed ones on approved sites only.
    const retried = yield* alice.RetrySavedMedia({ refId: ref.id })
    assert.isAbove(retried.waiting, 0)
    yield* saved.settle

    // A purged card's media goes once nothing names it.
    const item = yield* writer.DeleteEntity({ userId: user.id, entityId: copy.entityId })
    yield* writer.PurgeBinItem({ userId: user.id, itemId: item.id })
    assert.strictEqual(yield* writer.PruneSavedMedia(), 0)
    const main = yield* writer.DeleteEntity({ userId: user.id, entityId: mainId })
    yield* writer.PurgeBinItem({ userId: user.id, itemId: main.id })
    assert.isAbove(yield* writer.PruneSavedMedia(), 0)
    assert.strictEqual((yield* get("alice")).status, 404)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
)

it.live("lists the site approval list's changes and fetches waiting files once a site is added", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const user = yield* alice.Whoami()
    const writer = yield* Writer
    const { ref } = yield* writer.CreateEntity({
      userId: user.id,
      kind: "lorebook",
      label: "Synthetic book",
      subtitle: "",
      doc: {
        ...docFor("lorebook", "Synthetic book"),
        entries: [loreEntry({ content: "![a](https://i.pics.test/a.png)" }, 0)]
      } as never,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    assert.strictEqual((yield* alice.GetSavedMediaStatus({ refId: ref.id })).approval, 1)
    const removed = yield* alice.ChangeMediaHosts({ remove: "cardex.zip" })
    assert.deepStrictEqual(removed.hosts, [])
    yield* alice.ChangeMediaHosts({ add: { host: "pics.test", subdomains: true } })
    assert.deepStrictEqual((yield* alice.GetMediaHosts()).hosts, [{ host: "pics.test", subdomains: true }])
    const status = yield* alice.GetSavedMediaStatus({ refId: ref.id })
    // The transport is off in tests, so it fails rather than reaching anything.
    assert.strictEqual(status.approval, 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
)
