import { Summarizer } from "../../src/lcm/Summarizer.ts"
import * as ContextGenerator from "../../src/chat/ContextGenerator.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppApi, type AppRpcs } from "@rp/shared/api.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import { Effect, Layer, Option } from "effect"
import { HttpServer } from "effect/http"
import { RpcClient, RpcSerialization, type RpcGroup } from "effect/rpc"
import { Socket } from "effect/socket"
import { PasswordCost } from "../../src/auth/passwords.ts"
import { AppConfig, type AppConfigShape } from "../../src/config.ts"
import { serverWith } from "../../src/server.ts"
import { SavedMedia } from "../../src/api/savedMedia.ts"
import { testBundles, testWorkerMode } from "./bundles.ts"
import { tempDir } from "./tempDir.ts"

/**
 * A server on loopback with a fresh data directory. Port 0 makes the kernel pick a free
 * port as the server binds, and `serverPort` reads it back. A port picked before binding
 * could be taken in between: by another test file, another test run on the host, or,
 * across a restart, by anything at all.
 */
export const testConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => ({
  host: "127.0.0.1",
  port: 0,
  dataDir: tempDir("server"),
  dbReaders: 1,
  formatWorkers: 1,
  thumbnailWorkers: 1,
  dbAllowNetworkFs: false,
  // The run's own bundles unless TEST_DB_WORKERS=source (bundles.ts); tests of the source
  // entry points ask for source.
  dbWorkers: testWorkerMode,
  authMode: "single",
  authProxyHeader: "remote-user",
  allowedIps: [],
  trustedProxies: [],
  allowInsecureExposure: false,
  publicOrigins: [],
  loopbackRequiresLogin: true,
  adminUser: Option.none(),
  importStartDir: Option.none(),
  adminPassword: Option.none(),
  adminPasswordFile: Option.none(),
  clientDist: join(tmpdir(), "rp-no-client"),
  secretKey: Option.none(),
  secretKeyFile: Option.none(),
  keyHostBinding: true,
  ...overrides
})

/**
 * Cheap password hashes: about a millisecond instead of a second, so a test's time goes to
 * what it checks. A test with a dozen full-cost hashes took over 30 s at a load average of 75.
 */
const testPasswordCost = Layer.succeed(PasswordCost)({ n: 2 ** 10, r: 8, p: 1 })

/** The test server, with the generator its configuration picks unless one is given. */
export const serverLayer = (
  config: AppConfigShape,
  generator?: typeof ContextGenerator.layer,
  summaries = Summarizer.layer,
  /** The card sources: the fake archive's adapter for cardSources.test.ts. */
  sources?: Parameters<typeof serverWith>[4]
) =>
  // Saved card media never reaches the internet from a test: its transport is off unless a
  // test registers its own (savedMedia.test.ts).
  Layer.effectDiscard(Effect.flatMap(SavedMedia, (saved) => saved.fetchers.disable("media.saved"))).pipe(
    Layer.provideMerge(serverWith(generator ?? ContextGenerator.layer, summaries, undefined, undefined, sources)),
    Layer.provide([Layer.succeed(AppConfig)(config), testPasswordCost, testBundles])
  )

export const withServer = (config: AppConfigShape) => Effect.provide(serverLayer(config))

/** The port the enclosing test server listens on. */
export const serverPort = Effect.map(HttpServer.HttpServer, ({ address }) => {
  if (address._tag === "UnixPathAddress") throw new Error("the test server listens on a Unix socket")
  return address.port
})

/**
 * An RPC client over a real WebSocket to the enclosing test server, living as long as the
 * enclosing scope. Node's WebSocket accepts handshake headers, which stand in for a reverse
 * proxy or a cookie. Connecting to one of this machine's other addresses makes the
 * connection come from it.
 */
const testApi: RpcGroup.RpcGroup<AppRpcs> = AppApi
export const client = (headers: Record<string, string> = {}, address = "127.0.0.1") =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://${address}:${port}/rpc`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) => new WebSocket(url, { headers } as unknown as string[]) as unknown as globalThis.WebSocket
          )
        ),
        Layer.provide(RpcSerialization.layerJson)
      )
    )
    return yield* RpcClient.make(testApi).pipe(Effect.provide(protocol))
  })

/** An HTTP POST to the test server, as JSON unless the headers say otherwise. */
export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      })
    )
  )

/** Logs in, resolving to the status and the `cookie` header for later requests. */
export const login = (handle: string, password: string) =>
  post("/auth/login", { handle, password }).pipe(
    Effect.map((response) => {
      const setCookie = response.headers.get("set-cookie") ?? ""
      return { status: response.status, setCookie, cookie: setCookie.split(";")[0]! }
    })
  )

/** The outcome of an RPC as a short string: "ok", or the error tag and reason. */
/** A send or Generate that must have posted, not queued. */
export const posted = <A extends { readonly _tag: string }, E>(effect: Effect.Effect<A, E>) =>
  Effect.flatMap(effect, (result) =>
    result._tag === "Posted"
      ? Effect.succeed(result as Extract<A, { readonly _tag: "Posted" }>)
      : Effect.die(new Error(`expected it to post, but it was ${result._tag}`))
  )

export const outcome = <A, E>(effect: Effect.Effect<A, E>, show: (a: A) => string = () => "ok") =>
  effect.pipe(
    Effect.map(show),
    Effect.catch((error: E) =>
      Effect.succeed(
        `${(error as { _tag: string })._tag}${(error as { reason?: string }).reason ? `:${(error as { reason: string }).reason}` : ""}`
      )
    )
  )

type Api = Effect.Success<ReturnType<typeof client>>

/** What a send names of the composer draft it took `text` from (chatApi.ts `composer`). */
export const takenFrom = (draft: Draft) => ({
  draftId: draft.id,
  session: draft.session
})

/**
 * Types into the composer of a fork (null: the current one) as the client does: opens it, then saves onto the draft
 * that names (or onto `onto`, a draft read earlier). Returns the draft after the save.
 */
export const typeInto = (api: Api, chatId: ChatId, forkId: ForkId | null, content: string, onto?: Draft) =>
  Effect.gen(function* () {
    const draft = onto ?? (yield* api.OpenComposer({ chatId, forkId }))
    const saved = yield* api.SaveComposer({
      next: false,
      operationId: crypto.randomUUID(),
      chatId,
      draftId: draft.id,
      rowVersion: draft.rowVersion,
      session: draft.session,
      content
    })
    return saved.draft!
  })
