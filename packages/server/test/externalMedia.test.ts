import { createServer } from "node:http"
import { gzipSync } from "node:zlib"
import { vi } from "vitest"
import type { Socket } from "node:net"
import * as NetworkModule from "../src/net/Network.ts"
import * as Database from "../src/db/Database.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"
import { Network } from "../src/net/Network.ts"
import { makeExternalFetcher } from "../src/net/externalMedia.ts"
// Consent, authentication and cache isolation through real sockets and worker transactions.
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DEFAULT_EXTERNAL_MEDIA } from "@rp/shared/externalMedia.ts"
import { ExternalMedia } from "../src/api/externalMedia.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

it.live("checks ownership and consent before fetching, never caches, and stops on revocation", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const user = yield* alice.Whoami()
    const writer = yield* Writer
    const reader = yield* Reader
    const { entityId } = yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Synthetic",
      subtitle: "",
      doc: cardDoc("Synthetic"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const start = yield* alice.StartChat({
      cards: [entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Synthetic media", speakerEntityId: null }
    })
    const chatId = start.chat.id
    const port = yield* serverPort
    const media = yield* ExternalMedia
    let requests = 0
    let revoke = false
    const bytes = new Uint8Array([1, 2, 3])
    yield* media.fetchers.register({
      id: "media.external",
      fetch: async () => {
        requests++
        if (revoke)
          await Effect.runPromise(
            writer.SetExternalMedia({ userId: user.id, target: { _tag: "Chat", id: chatId }, allow: false })
          )
        return { bytes, mime: "image/png" }
      }
    })
    const get = (
      scope = { chat: chatId, card: entityId } as Record<string, string>,
      handle: string | null = "alice",
      extra: Record<string, string> = {}
    ) =>
      Effect.promise(() =>
        fetch(
          `http://127.0.0.1:${port}/media/external?${new URLSearchParams({ url: "https://media.invalid/image.png", ...scope })}`,
          { headers: { "sec-fetch-site": "same-origin", ...(handle ? { "Remote-User": handle } : {}), ...extra } }
        )
      )
    assert.deepStrictEqual(yield* alice.GetExternalMediaPrefs({}), DEFAULT_EXTERNAL_MEDIA)
    assert.strictEqual((yield* get()).status, 403)
    assert.strictEqual((yield* get({}, null)).status, 401)
    assert.strictEqual((yield* get({}, "alice")).status, 400)
    assert.strictEqual((yield* get(undefined, "bob")).status, 404)
    assert.strictEqual(requests, 0)
    yield* alice.SetExternalMedia({ target: { _tag: "Card", id: entityId }, allow: true })
    for (const site of ["cross-site", "same-site"]) {
      assert.strictEqual(
        (yield* get(undefined, "alice", { "sec-fetch-site": site, "sec-fetch-dest": "image" })).status,
        403
      )
    }
    const noMetadata = yield* Effect.promise(() =>
      fetch(
        `http://127.0.0.1:${port}/media/external?${new URLSearchParams({ url: "https://media.invalid/image.png", chat: chatId })}`,
        { headers: { "Remote-User": "alice" } }
      )
    )
    assert.strictEqual(noMetadata.status, 403)
    assert.strictEqual(requests, 0)
    const first = yield* get()
    assert.strictEqual(first.status, 200)
    assert.deepStrictEqual(new Uint8Array(yield* Effect.promise(() => first.arrayBuffer())), bytes)
    assert.strictEqual(first.headers.get("cache-control"), "no-store")
    assert.strictEqual(first.headers.get("x-content-type-options"), "nosniff")
    assert.isNull(first.headers.get("set-cookie"))
    assert.strictEqual(first.headers.get("content-disposition"), "attachment")
    assert.strictEqual(
      first.headers.get("content-security-policy"),
      "sandbox; default-src 'none'; frame-ancestors 'none'"
    )
    assert.strictEqual(first.headers.get("cross-origin-resource-policy"), "same-origin")
    assert.strictEqual(
      (yield* get(undefined, "alice", { "if-none-match": "anything", range: "bytes=0-1" })).status,
      200
    )
    assert.strictEqual(requests, 2)
    yield* alice.SetExternalMedia({ target: { _tag: "Chat", id: chatId }, allow: false })
    assert.strictEqual((yield* get()).status, 403)
    yield* alice.SetExternalMedia({ target: { _tag: "Chat", id: chatId }, allow: null })
    assert.isTrue(yield* reader.CheckExternalMedia({ userId: user.id, chatId, cardId: entityId }))
    yield* alice.SetExternalMedia({ target: { _tag: "Default" }, allow: true })
    yield* alice.SetExternalMedia({ target: { _tag: "Card", id: entityId }, allow: false })
    assert.strictEqual((yield* get()).status, 403)
    yield* alice.SetExternalMedia({ target: { _tag: "Chat", id: chatId }, allow: true })
    revoke = true
    assert.strictEqual((yield* get()).status, 403)
    assert.deepStrictEqual(yield* bob.GetExternalMediaPrefs({}), DEFAULT_EXTERNAL_MEDIA)
    // Disabling the feature's part fails closed, even with consent present.
    yield* alice.SetExternalMedia({ target: { _tag: "Chat", id: chatId }, allow: true })
    yield* media.fetchers.disable("media.external")
    assert.strictEqual((yield* get()).status, 403)
    assert.strictEqual((yield* get(undefined, "alice", { origin: "null" })).status, 403)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
)

it.live("pins public DNS answers through the real Network transport and rechecks same-origin redirects", () =>
  Effect.gen(function* () {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      "base64"
    )
    const network = yield* Network
    const authorities: string[] = []
    const hosts: Array<string | undefined> = []
    const sockets = new Set<Socket>()
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://media.invalid")
      authorities.push(url.host.includes(":") ? url.host : `${url.host}:80`)
      hosts.push(request.headers.host)
      if (url.pathname === "/redirect") response.writeHead(302, { location: "/private" }).end()
      else if (url.pathname === "/loop") response.writeHead(302, { location: "/loop" }).end()
      else if (url.pathname === "/gzip")
        response
          .writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" })
          .end(gzipSync(Buffer.alloc(4096)))
      else response.writeHead(200, { "content-type": "image/png" }).end(pixel)
    })
    proxy.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    proxy.on("connect", (request, socket, head) => {
      authorities.push(request.url ?? "")
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      let buffer = ""
      const receive = (chunk: Buffer) => {
        buffer += chunk.toString()
        if (!buffer.includes("\r\n\r\n")) return
        socket.off("data", receive)
        hosts.push(/^host: (.*)$/im.exec(buffer)?.[1]?.trim())
        const path = buffer.split(" ")[1]
        if (path === "/redirect" || path === "/loop") {
          socket.end(
            `HTTP/1.1 302 Found\r\nLocation: ${path === "/loop" ? "/loop" : "/private"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
          )
        } else {
          const compressed = path === "/gzip"
          const bytes = compressed ? gzipSync(Buffer.alloc(4096)) : pixel
          socket.end(
            Buffer.concat([
              Buffer.from(
                `HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n${compressed ? "Content-Encoding: gzip\r\n" : ""}Content-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`
              ),
              bytes
            ])
          )
        }
      }
      socket.on("data", receive)
      if (head.length) receive(head)
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done))),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((done) => {
              for (const socket of sockets) socket.destroy()
              proxy.close(() => done())
            })
        )
    )
    const address = proxy.address()
    if (address === null || typeof address === "string") throw new Error("No test proxy address")
    yield* network.setInstance({ proxyUrl: `http://127.0.0.1:${address.port}`, bypass: [], forceProxy: false })
    let lookups = 0
    const get = makeExternalFetcher(network, {
      resolve: async () => {
        lookups++
        return ["93.184.216.34"]
      }
    })
    // Explicit dispatchers must ignore ambient proxy variables, even if a process enables them.
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1")
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1")
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:1")
    vi.stubEnv("NODE_USE_ENV_PROXY", "1")
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()))
    const file = yield* Effect.promise(() => get("http://media.invalid/a.png", new AbortController().signal))
    assert.deepStrictEqual(Buffer.from(file.bytes), pixel)
    assert.strictEqual(lookups, 1)
    assert.deepStrictEqual(authorities, ["93.184.216.34:80"])
    assert.deepStrictEqual(hosts, ["media.invalid"])
    let hops = 0
    const rebinding = makeExternalFetcher(network, {
      resolve: async () => (++hops === 1 ? ["93.184.216.34"] : ["127.0.0.1"])
    })
    const refused = yield* Effect.exit(
      Effect.tryPromise(() => rebinding("http://media.invalid/redirect", new AbortController().signal))
    )
    assert.strictEqual(refused._tag, "Failure")
    assert.strictEqual(hops, 2)
    assert.deepStrictEqual(hosts, ["media.invalid", "media.invalid"])
    const beforeLoop = authorities.length
    const loop = yield* Effect.exit(
      Effect.tryPromise(() => get("http://media.invalid/loop", new AbortController().signal))
    )
    assert.strictEqual(loop._tag, "Failure")
    assert.strictEqual(authorities.length - beforeLoop, 6, "at most five redirects")
    const compressed = makeExternalFetcher(network, { resolve: async () => ["93.184.216.34"], maxBytes: 1024 })
    const tooLarge = yield* Effect.exit(
      Effect.tryPromise(() => compressed("http://media.invalid/gzip", new AbortController().signal))
    )
    assert.strictEqual(tooLarge._tag, "Failure", "decompressed bytes exceed the cap despite a small Content-Length")
  }).pipe(
    Effect.scoped,
    Effect.provide(
      NetworkModule.layer.pipe(
        Layer.provide(
          Database.layer({
            dataDir: tempDir("external-media-network"),
            readers: 1,
            allowNetworkFs: false,
            ...testWorkers
          })
        ),
        Layer.provide(Layer.succeed(Secrets)(makeSecrets("synthetic external media test secret")))
      )
    )
  )
)

it.live("bounds simultaneous external downloads per user before opening another connection", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const user = yield* alice.Whoami()
    const writer = yield* Writer
    const { entityId } = yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Synthetic",
      subtitle: "",
      doc: cardDoc("Synthetic"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const chat = yield* alice.StartChat({
      cards: [entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Synthetic media", speakerEntityId: null }
    })
    yield* alice.SetExternalMedia({ target: { _tag: "Chat", id: chat.chat.id }, allow: true })
    const media = yield* ExternalMedia
    const port = yield* serverPort
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    let ready!: () => void
    const started = new Promise<void>((done) => {
      ready = done
    })
    let calls = 0
    yield* media.fetchers.register({
      id: "media.external",
      fetch: async () => {
        calls++
        if (calls === 8) ready()
        if (calls <= 8) await gate
        return { bytes: new Uint8Array([1]), mime: "image/png" }
      }
    })
    yield* Effect.promise(async () => {
      const get = () =>
        fetch(
          `http://127.0.0.1:${port}/media/external?${new URLSearchParams({ chat: chat.chat.id, url: "https://media.invalid/a" })}`,
          { headers: { "Remote-User": "alice", "sec-fetch-site": "same-origin" } }
        )
      const pending = Array.from({ length: 8 }, get)
      try {
        await started
        const excess = await get()
        assert.strictEqual(excess.status, 429)
        assert.strictEqual(calls, 8)
        assert.isNotNull(excess.headers.get("retry-after"))
      } finally {
        release()
        await Promise.all(pending)
      }
      assert.strictEqual((await get()).status, 200)
    })
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
)
