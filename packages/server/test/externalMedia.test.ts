import { createServer } from "node:http"
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
          { headers: { ...(handle ? { "Remote-User": handle } : {}), ...extra } }
        )
      )
    assert.deepStrictEqual(yield* alice.GetExternalMediaPrefs({}), DEFAULT_EXTERNAL_MEDIA)
    assert.strictEqual((yield* get()).status, 403)
    assert.strictEqual((yield* get({}, null)).status, 401)
    assert.strictEqual((yield* get({}, "alice")).status, 400)
    assert.strictEqual((yield* get(undefined, "bob")).status, 404)
    assert.strictEqual(requests, 0)
    yield* alice.SetExternalMedia({ target: { _tag: "Card", id: entityId }, allow: true })
    const first = yield* get()
    assert.strictEqual(first.status, 200)
    assert.deepStrictEqual(new Uint8Array(yield* Effect.promise(() => first.arrayBuffer())), bytes)
    assert.strictEqual(first.headers.get("cache-control"), "no-store")
    assert.strictEqual(first.headers.get("x-content-type-options"), "nosniff")
    assert.isNull(first.headers.get("set-cookie"))
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
    const network = yield* Network
    const authorities: string[] = []
    const hosts: Array<string | undefined> = []
    const sockets = new Set<Socket>()
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://media.invalid")
      authorities.push(url.host.includes(":") ? url.host : `${url.host}:80`)
      hosts.push(request.headers.host)
      if (url.pathname === "/redirect") response.writeHead(302, { location: "/private" }).end()
      else response.writeHead(200, { "content-type": "image/png" }).end("image")
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
        socket.end(
          buffer.startsWith("GET /redirect ")
            ? "HTTP/1.1 302 Found\r\nLocation: /private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            : "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage"
        )
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
    const file = yield* Effect.promise(() => get("http://media.invalid/a.png", new AbortController().signal))
    assert.strictEqual(Buffer.from(file.bytes).toString(), "image")
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
