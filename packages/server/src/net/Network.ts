// The one place outgoing HTTP leaves the server (spec/PROVIDERS.md §6.2). Every request
// is routed through the instance proxy, a connection's own proxy, or direct, and the
// route taken is reported, never silent. ESLint forbids `fetch` and `undici` elsewhere.
import { lookup } from "node:dns/promises"
import { InvalidNetworkSettings } from "@rp/shared/api.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Agent, type Dispatcher, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from "undici"
import { Reader, Writer } from "../db/Database.ts"
import { Secrets } from "../secrets.ts"
import {
  type BypassList,
  DEFAULT_BYPASS,
  decideRoute,
  displayProxy,
  parseBypass,
  type ProxyOverride,
  proxyUrlProblem,
  type Route
} from "./route.ts"

export type { ProxyOverride, Route } from "./route.ts"
export { InvalidNetworkSettings }

const SETTING_KEY = "network"
const PROXY_BINDING = "app:network:proxy_url"

/** What's stored in app_settings: the proxy URL may hold credentials, so it's encrypted. */
const StoredNetwork = Schema.Struct({
  proxyUrlEnc: Schema.NullOr(Schema.String),
  bypass: Schema.Array(Schema.String)
})

/** The instance's network settings as an admin sees them: credentials never shown. */
export interface NetworkView {
  readonly proxy: string | null
  readonly bypass: ReadonlyArray<string>
}

export interface NetworkShape {
  /**
   * A fetch for one connection's requests. `onRoute` hears the route of every request,
   * for the connection test and the request inspector.
   */
  readonly fetchFor: (override: ProxyOverride, onRoute?: (route: Route, target: URL) => void) => typeof fetch
  readonly route: (target: URL, override: ProxyOverride) => Effect.Effect<Route>
  readonly view: Effect.Effect<NetworkView>
  /** Replaces the instance settings; `proxyUrl` undefined keeps the stored proxy. */
  readonly setInstance: (settings: {
    readonly proxyUrl: string | null | undefined
    readonly bypass: ReadonlyArray<string>
  }) => Effect.Effect<NetworkView, InvalidNetworkSettings | ServerError>
}

export class Network extends Context.Service<Network, NetworkShape>()("rp/Network") {}

interface Current {
  readonly proxyUrl: string | null
  readonly bypassEntries: ReadonlyArray<string>
  readonly bypass: BypassList
}

const resolveHost = async (host: string) => (await lookup(host, { all: true })).map((answer) => answer.address)

const makeDispatcher = (route: Route): Dispatcher => {
  if (route.via === "direct") return new Agent()
  const url = new URL(route.proxy)
  return url.protocol === "socks5:" || url.protocol === "socks5h:"
    ? new Socks5ProxyAgent(url)
    : new ProxyAgent({ uri: url.href })
}

export const layer = Layer.effect(
  Network,
  Effect.gen(function* () {
    const reader = yield* Reader
    const writer = yield* Writer
    const secrets = yield* Secrets

    const load = Effect.gen(function* () {
      const raw = yield* reader.GetAppSetting({ key: SETTING_KEY })
      const stored = raw === null ? null : yield* Schema.decodeUnknownEffect(StoredNetwork)(raw)
      const bypassEntries = stored?.bypass ?? DEFAULT_BYPASS
      const proxyUrl =
        stored?.proxyUrlEnc == null
          ? null
          : yield* secrets.decrypt(Buffer.from(stored.proxyUrlEnc, "base64"), PROXY_BINDING).pipe(
              // An unreadable proxy URL (changed server secret) must not silently turn
              // into "no proxy": requests then fail until an admin re-enters it.
              Effect.catchTag("SecretUnreadable", () => Effect.succeed("unreadable://proxy"))
            )
      return { proxyUrl, bypassEntries, bypass: parseBypass(bypassEntries).list } satisfies Current
    })

    const current = yield* Ref.make(yield* Effect.orDie(load))

    // One dispatcher per route, reused so connections pool; closed with the layer.
    const dispatchers = new Map<string, Dispatcher>()
    const dispatcherFor = (route: Route) => {
      const key = route.via === "direct" ? "direct" : route.proxy
      let dispatcher = dispatchers.get(key)
      if (!dispatcher) {
        dispatcher = makeDispatcher(route)
        dispatchers.set(key, dispatcher)
      }
      return dispatcher
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled([...dispatchers.values()].map((d) => d.close())))
    )

    const routeNow = (target: URL, override: ProxyOverride) => {
      const settings = Ref.getUnsafe(current)
      return decideRoute({
        target,
        override,
        instanceProxy: settings.proxyUrl,
        bypass: settings.bypass,
        resolve: resolveHost
      })
    }

    const fetchFor: NetworkShape["fetchFor"] = (override, onRoute) => {
      const routed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : input.toString())
        const route = await routeNow(target, override)
        if (route.via === "proxy" && proxyUrlProblem(route.proxy) !== null) {
          throw new Error(`The proxy for this request is unusable: ${proxyUrlProblem(route.proxy)}`)
        }
        onRoute?.(route, target)
        return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: dispatcherFor(route)
        })
      }
      return routed as unknown as typeof fetch
    }

    const view = Ref.get(current).pipe(
      Effect.map((settings) => ({
        proxy: settings.proxyUrl === null ? null : displayProxy(settings.proxyUrl),
        bypass: settings.bypassEntries
      }))
    )

    const setInstance: NetworkShape["setInstance"] = ({ proxyUrl, bypass }) =>
      Effect.gen(function* () {
        const problems: Array<string> = []
        const proxyProblem = typeof proxyUrl === "string" ? proxyUrlProblem(proxyUrl) : null
        if (proxyProblem) problems.push(`proxy: ${proxyProblem}`)
        const parsed = parseBypass(bypass)
        for (const entry of parsed.invalid) problems.push(`bypass entry not understood: ${entry}`)
        if (problems.length > 0) return yield* new InvalidNetworkSettings({ problems })

        const before = yield* Ref.get(current)
        const nextProxy = proxyUrl === undefined ? before.proxyUrl : proxyUrl
        const proxyUrlEnc =
          nextProxy === null ? null : Buffer.from(secrets.encrypt(nextProxy, PROXY_BINDING)).toString("base64")
        yield* writer
          .SetAppSetting({ key: SETTING_KEY, value: { proxyUrlEnc, bypass } })
          .pipe(
            Effect.catch((error) =>
              Effect.logError("saving network settings failed", error).pipe(
                Effect.andThen(Effect.fail(new ServerError({ message: "saving network settings failed" })))
              )
            )
          )
        yield* Ref.set(current, { proxyUrl: nextProxy, bypassEntries: bypass, bypass: parsed.list })
        return yield* view
      })

    return Network.of({
      fetchFor,
      route: (target, override) => Effect.promise(() => routeNow(target, override)),
      view,
      setInstance
    })
  })
)
