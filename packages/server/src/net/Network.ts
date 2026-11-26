// The one place outgoing HTTP leaves the server (spec/PROVIDERS.md §6.2). Every request
// is routed through the instance proxy, a connection's own proxy, or direct, and the
// route taken is reported, never silent. ESLint forbids `fetch` and `undici` elsewhere.
import { lookup as lookupCallback, type LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { isIP, type Socket, type TcpNetConnectOpts } from "node:net"
import { InvalidNetworkSettings } from "@dreamspan/shared/api.ts"
import { ServerError } from "@dreamspan/shared/errors.ts"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  Agent,
  buildConnector,
  DecoratorHandler,
  type Dispatcher,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch
} from "undici"
import { bareHost, isLocalhostName, isPublicAddress } from "./addresses.ts"
import { makeDispatcherPool } from "./dispatcherPool.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Secrets } from "../secrets.ts"
import {
  type BypassList,
  bypasses,
  DEFAULT_BYPASS,
  decideRoute,
  displayProxy,
  parseBypass,
  type ProxyOverride,
  proxyUrlProblem,
  type Route
} from "./route.ts"

export type { ProxyOverride, Route } from "./route.ts"

const SETTING_KEY = "network"
const PROXY_BINDING = "app:network:proxy_url"

/** What's stored in app-scoped settings: the proxy URL may hold credentials, so it's encrypted. */
const StoredNetwork = Schema.Struct({
  proxyUrlEnc: Schema.NullOr(Schema.String),
  bypass: Schema.Array(Schema.String),
  forceProxy: Schema.optionalKey(Schema.Boolean)
})

/** The instance's network settings as an admin sees them: credentials never shown. */
interface NetworkView {
  readonly proxy: string | null
  readonly bypass: ReadonlyArray<string>
  /** Non-admins' connections can't go direct or through their own proxy (owner, 2026-10-11). */
  readonly forceProxy: boolean
}

/** Transport pinned to the settings whose secrets were registered for this request. */
export interface RequestNetwork {
  readonly publicOnly: boolean
  /**
   * `targetAddresses` checks every hop before it connects (redirects included) and pins the
   * connection to the addresses it returns, as `NetworkShape.fetchFor`'s does.
   */
  readonly fetchFor: (onRoute?: (route: Route, target: URL) => void, targetAddresses?: TargetAddresses) => typeof fetch
  readonly route: (target: URL) => Effect.Effect<Route>
  /** Whether a host, by name or IP literal as given, is on the instance's bypass list; never resolved. */
  readonly bypassed: (host: string) => boolean
}

export interface NetworkShape {
  readonly prepare: (
    override: ProxyOverride,
    registerSecret: (value: string) => void,
    options?: { readonly publicOnly: boolean }
  ) => RequestNetwork
  /**
   * A fetch for one connection's requests. `onRoute` hears the route of every request,
   * for the connection test and the request inspector.
   */
  readonly fetchFor: (
    override: ProxyOverride,
    onRoute?: (route: Route, target: URL) => void,
    targetAddresses?: TargetAddresses,
    /**
     * A redirect to another origin is refused unless this accepts it. Only for requests that
     * carry nothing secret (saved card media); each hop is checked by `targetAddresses` too.
     */
    crossOriginRedirect?: (next: URL) => boolean
  ) => typeof fetch
  readonly route: (target: URL, override: ProxyOverride) => Effect.Effect<Route>
  /** Whether non-admins must use the instance proxy. */
  readonly forced: () => boolean
  readonly view: Effect.Effect<NetworkView>
  /** Replaces the instance settings; `proxyUrl` undefined keeps the stored proxy. */
  readonly setInstance: (settings: {
    readonly proxyUrl: string | null | undefined
    readonly bypass: ReadonlyArray<string>
    readonly forceProxy: boolean
  }) => Effect.Effect<NetworkView, InvalidNetworkSettings | ServerError>
}

/** Validate each hop and return the only addresses it may connect to; undefined leaves DNS unrestricted. */
export type TargetAddresses = (target: URL) => Promise<ReadonlyArray<string> | undefined>

export class Network extends Context.Service<Network, NetworkShape>()("rp/Network") {}

interface Current {
  readonly proxyUrl: string | null
  readonly bypassEntries: ReadonlyArray<string>
  readonly bypass: BypassList
  readonly forceProxy: boolean
}

const MAX_REDIRECTS = 5

/** A redirect to another origin, refused: it would carry the request's secrets there. */
export class RedirectRefused extends Error {
  override readonly name = "RedirectRefused"
}

/** A public-only connection could not establish that its destination is public. */
export class AddressRefused extends Error {
  override readonly name = "AddressRefused"
}

const resolveHost = async (host: string) => (await lookup(host, { all: true })).map((answer) => answer.address)

const publicAddresses = async (
  hostname: string,
  subject: string,
  checked?: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> => {
  const host = bareHost(hostname)
  const refuse = () => new AddressRefused(`${subject} targets a private or local address. Use a public address.`)
  if (isLocalhostName(host)) throw refuse()
  const addresses = checked ?? (isIP(host) ? [host] : await resolveHost(hostname).catch(() => []))
  if (addresses.length === 0) throw new AddressRefused(`Couldn't resolve the address for ${subject.toLowerCase()}.`)
  if (addresses.some((ip) => !isPublicAddress(ip))) throw refuse()
  return addresses
}

/** A connection's own proxy is also a destination. Its socket may only use the checked answers. */
const pinnedLookup = (addresses: ReadonlyArray<string>): TcpNetConnectOpts["lookup"] => {
  const answers = addresses.map((address) => ({ address, family: isIP(address) }))
  return (_hostname, { all, family }, callback) => {
    const allowed = family ? answers.filter((answer) => answer.family === family) : answers
    const first = allowed[0]
    if (first === undefined)
      return callback(new AddressRefused("The proxy has no allowed address for this family."), "")
    if (all) return callback(null, allowed)
    callback(null, first.address, first.family)
  }
}

/**
 * For targets that go direct because their addresses are on the bypass list: the
 * connection may only use those addresses. Without this, the socket's own lookup could
 * answer differently (DNS rebinding) and leave the network the proxy was meant to cover.
 */
export const bypassOnlyLookup =
  (bypass: () => BypassList) =>
  (
    hostname: string,
    options: { readonly all?: boolean; readonly family?: number },
    callback: (error: Error | null, address: string | ReadonlyArray<LookupAddress>, family?: number) => void
  ) =>
    lookupCallback(hostname, { all: true, family: options.family ?? 0 }, (error, answers) => {
      if (error) return callback(error, [])
      const allowed = answers.filter((answer) => bypasses(bypass(), answer.address))
      if (allowed.length === 0) return callback(new Error(`${hostname} no longer resolves to a bypassed address`), [])
      if (options.all) return callback(null, allowed)
      callback(null, allowed[0]!.address, allowed[0]!.family)
    })

/**
 * How long a response may go silent: before its headers, and between body chunks. A local
 * model can spend minutes reading a long prompt before it sends anything, and undici's
 * default of 300 s cut such a request off, only for the retry to start the prompt again.
 * Stopping a generation still aborts at once.
 */
const RESPONSE_IDLE_TIMEOUT_MS = 30 * 60_000

// Set per request, so it applies on every route: proxy agents don't pass their options
// down to the pools they make for each origin.
const idleTimeouts: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) =>
  dispatch({ ...options, headersTimeout: RESPONSE_IDLE_TIMEOUT_MS, bodyTimeout: RESPONSE_IDLE_TIMEOUT_MS }, handler)

/** fetch removes Host overrides, so restore the source's HTTP authority after that boundary. */
const sourceHost =
  (host: string): Dispatcher.DispatcherComposeInterceptor =>
  (dispatch) =>
  (options, handler) => {
    const raw = options.headers
    const entries = Array.isArray(raw)
      ? Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2]!, raw[i * 2 + 1]!])
      : raw != null && Symbol.iterator in raw
        ? raw
        : Object.entries(raw ?? {})
    return dispatch({ ...options, headers: { ...Object.fromEntries(entries), host } }, handler)
  }

const makeDispatcher = (
  route: Route,
  bypass: () => BypassList,
  servername?: string,
  host?: string,
  proxyAddresses?: ReadonlyArray<string>,
  proxyTunnel?: boolean
): Dispatcher => {
  const configure = (agent: Dispatcher) => {
    const timed = agent.compose(idleTimeouts)
    return host === undefined ? timed : timed.compose(sourceHost(host))
  }
  if (route.via === "direct") {
    const agent = new Agent({
      connect: { ...(route.pinned ? { lookup: bypassOnlyLookup(bypass) as never } : {}), servername }
    })
    return configure(agent)
  }
  const url = new URL(route.proxy)
  const lookup = proxyAddresses === undefined ? undefined : pinnedLookup(proxyAddresses)
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    const agent = new Socks5ProxyAgent(url.href.replace(/^socks5h:/, "socks5:"), {
      requestTls: { servername },
      ...(lookup === undefined ? {} : { connect: buildConnector({ lookup }) })
    })
    if (host !== undefined) {
      // The pinned Undici version passes URL.hostname to its SOCKS encoder, which treats
      // bracketed IPv6 as a domain name. Leave only the literal for the numeric encoding.
      const connector = agent as typeof agent & {
        createSocks5Connection: (host: string, port: number) => Promise<Socket>
      }
      const connect = connector.createSocks5Connection.bind(connector)
      connector.createSocks5Connection = (hostname, port) => connect(bareHost(hostname), port)
    }
    return configure(agent)
  }
  return configure(
    new ProxyAgent({
      uri: url.href,
      requestTls: { servername },
      ...(proxyTunnel ? { proxyTunnel: true } : {}),
      ...(lookup === undefined ? {} : { proxyTls: { lookup } })
    })
  )
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
      return {
        proxyUrl,
        bypassEntries,
        bypass: parseBypass(bypassEntries).list,
        forceProxy: stored?.forceProxy ?? false
      } satisfies Current
    })

    const current = yield* Ref.make(yield* Effect.orDie(load))

    // One dispatcher per route, reused so connections pool; closed with the layer.
    const dispatchers = makeDispatcherPool()
    const dispatcherFor = (
      route: Route,
      settings: Current,
      {
        pinnedTarget,
        servername,
        host,
        proxyAddresses,
        proxyTunnel
      }: {
        pinnedTarget: URL | undefined
        servername: string | undefined
        host: string | undefined
        proxyAddresses: ReadonlyArray<string> | undefined
        proxyTunnel: boolean
      }
    ) => {
      const routeKey =
        route.via === "direct" ? `direct:${route.pinned ? JSON.stringify(settings.bypassEntries) : "any"}` : route.proxy
      const key = JSON.stringify([routeKey, pinnedTarget?.origin, servername, host, proxyAddresses, proxyTunnel])
      return dispatchers.get(key, () =>
        makeDispatcher(route, () => settings.bypass, servername, host, proxyAddresses, proxyTunnel)
      )
    }
    yield* Effect.addFinalizer(() => Effect.promise(() => dispatchers.close()))

    const routeNow = (
      target: URL,
      override: ProxyOverride,
      settings: Current = Ref.getUnsafe(current),
      addresses?: ReadonlyArray<string>
    ) => {
      return decideRoute({
        target,
        override,
        instanceProxy: settings.proxyUrl,
        bypass: settings.bypass,
        resolve: addresses === undefined ? resolveHost : async () => addresses
      })
    }

    /**
     * Redirects are followed only within the origin. undici strips just `authorization` and
     * cookies on a cross-origin redirect, so `x-api-key` and custom headers would follow a
     * redirect anywhere: an open redirect on an allowed host would carry the key off. Each
     * hop is routed afresh.
     */
    const fetchFor = (
      override: ProxyOverride,
      onRoute?: (route: Route, target: URL) => void,
      targetAddresses?: TargetAddresses,
      crossOriginRedirect?: (next: URL) => boolean,
      settings?: Current,
      publicOnly = false
    ): typeof fetch => {
      const routed = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        let target = new URL(input instanceof Request ? input.url : input.toString())
        let request: { input: Parameters<typeof fetch>[0]; init: RequestInit } = { input, init }
        for (let hop = 0; ; hop++) {
          const selected = settings ?? Ref.getUnsafe(current)
          const checked = await targetAddresses?.(target)
          const addresses = publicOnly ? await publicAddresses(target.hostname, "This connection", checked) : checked
          const route = await routeNow(target, override, selected, addresses)
          let proxyAddresses: ReadonlyArray<string> | undefined
          if (route.via === "proxy") {
            const problem = proxyUrlProblem(route.proxy)
            if (problem !== null) throw new Error(`The proxy for this request is unusable: ${problem}`)
            if (publicOnly && route.source === "connection") {
              proxyAddresses = await publicAddresses(new URL(route.proxy).hostname, "This connection's proxy")
            }
          }
          onRoute?.(route, target)
          if (addresses !== undefined) {
            if (addresses.length === 0 || addresses.some((ip) => isIP(ip) === 0))
              throw new Error("target has no allowed addresses")
            if (input instanceof Request) throw new Error("address pinning requires a URL request")
          }
          const candidates = addresses ?? [undefined]
          const readOnly = ["GET", "HEAD"].includes(request.init.method?.toUpperCase() ?? "GET")
          const body = request.init.body
          const canRetryConnect = candidates.length > 1 && !readOnly && !(body instanceof ReadableStream)
          let started = false
          const send = (address: string | undefined) => {
            let pinnedTarget: URL | undefined
            let servername: string | undefined
            if (address !== undefined) {
              // Use the checked literal on the wire, including the proxy's CONNECT/SOCKS
              // destination. Keep HTTP Host and TLS identity on the original hostname.
              pinnedTarget = new URL(target)
              // Parse before assigning: the hostname setter silently ignores invalid literals.
              const literal = isIP(address) === 6 ? `[${address}]` : address
              pinnedTarget.hostname = new URL(`http://${literal}`).hostname
              const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1")
              servername = isIP(hostname) === 0 ? hostname : undefined
            }
            const dispatcher = dispatcherFor(route, selected, {
              pinnedTarget,
              servername,
              host: pinnedTarget ? target.host : undefined,
              proxyAddresses,
              // CONNECT makes the checked literal the proxy's tunnel authority even for HTTP.
              proxyTunnel: publicOnly && route.via === "proxy"
            })
            return undiciFetch((pinnedTarget?.href ?? request.input) as Parameters<typeof undiciFetch>[0], {
              ...(request.init as unknown as Parameters<typeof undiciFetch>[1]),
              redirect: "manual",
              dispatcher: canRetryConnect
                ? dispatcher.compose(
                    (dispatch) => (options, handler) =>
                      dispatch(
                        options,
                        Object.assign(new DecoratorHandler(handler), {
                          // Undici calls this after connecting (including tunnels and TLS), just
                          // before sending the origin request. A write may have happened after it.
                          onRequestStart: (
                            ...args: Parameters<NonNullable<Dispatcher.DispatchHandler["onRequestStart"]>>
                          ) => {
                            started = true
                            handler.onRequestStart?.(...args)
                          }
                        })
                      )
                  )
                : dispatcher
            })
          }
          // Try only checked addresses. For writes, fail over only before an origin request
          // could have been sent and only if its body can be used in a new fetch.
          let response: Awaited<ReturnType<typeof undiciFetch>> | undefined
          for (let attempt = 0; attempt < candidates.length; attempt++) {
            try {
              response = await send(candidates[attempt])
              break
            } catch (error) {
              if (
                attempt === candidates.length - 1 ||
                request.init.signal?.aborted ||
                (!readOnly && (!canRetryConnect || started))
              )
                throw error
            }
          }
          if (response === undefined) throw new Error("target has no allowed addresses")
          const location = response.headers.get("location")
          if (response.status < 300 || response.status > 399 || location === null)
            return response as unknown as Response
          await response.body?.cancel()
          const next = new URL(location, target)
          if (next.origin !== target.origin && !crossOriginRedirect?.(next)) {
            throw new RedirectRefused(`refused a redirect from ${target.origin} to ${next.origin}`)
          }
          if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
          if (input instanceof Request) throw new Error("redirects aren't followed for this request")
          // As fetch does: 303, and 301/302 after a POST, become a GET without a body.
          const toGet =
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && request.init.method === "POST")
          if (!toGet && body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
            throw new Error("a redirect would need the request body sent again")
          }
          request = { input: next.href, init: toGet ? { ...request.init, method: "GET", body: null } : request.init }
          target = next
        }
      }
      return routed as unknown as typeof fetch
    }

    const view = Ref.get(current).pipe(
      Effect.map((settings) => ({
        proxy: settings.proxyUrl === null ? null : displayProxy(settings.proxyUrl),
        bypass: settings.bypassEntries,
        forceProxy: settings.forceProxy
      }))
    )

    const setInstance: NetworkShape["setInstance"] = ({ proxyUrl, bypass, forceProxy }) =>
      Effect.gen(function* () {
        const problems: Array<string> = []
        const proxyProblem = typeof proxyUrl === "string" ? proxyUrlProblem(proxyUrl) : null
        if (proxyProblem) problems.push(`proxy: ${proxyProblem}`)
        const parsed = parseBypass(bypass)
        for (const entry of parsed.invalid) problems.push(`bypass entry not understood: ${entry}`)
        const nextProxyUrl = proxyUrl === undefined ? Ref.getUnsafe(current).proxyUrl : proxyUrl
        if (forceProxy && nextProxyUrl === null) problems.push("requiring the proxy needs a proxy to be set")
        if (problems.length > 0) return yield* new InvalidNetworkSettings({ problems })

        const before = yield* Ref.get(current)
        const nextProxy = proxyUrl === undefined ? before.proxyUrl : proxyUrl
        const proxyUrlEnc =
          nextProxy === null ? null : Buffer.from(secrets.encrypt(nextProxy, PROXY_BINDING)).toString("base64")
        yield* writer
          .SetAppSetting({ key: SETTING_KEY, value: { proxyUrlEnc, bypass, forceProxy } })
          .pipe(
            Effect.catch((error) =>
              Effect.logError("saving network settings failed", error).pipe(
                Effect.andThen(Effect.fail(new ServerError({ message: "saving network settings failed" })))
              )
            )
          )
        yield* Ref.set(current, { proxyUrl: nextProxy, bypassEntries: bypass, bypass: parsed.list, forceProxy })
        return yield* view
      })

    return Network.of({
      prepare: (override, registerSecret, options) => {
        const publicOnly = options?.publicOnly ?? false
        const settings = Ref.getUnsafe(current)
        if (settings.proxyUrl !== null) registerSecret(settings.proxyUrl)
        if (override.mode === "custom") registerSecret(override.url)
        return {
          publicOnly,
          fetchFor: (onRoute, targetAddresses) =>
            fetchFor(override, onRoute, targetAddresses, undefined, settings, publicOnly),
          route: (target) => Effect.promise(() => routeNow(target, override, settings)),
          bypassed: (host) => bypasses(settings.bypass, host)
        }
      },
      fetchFor,
      route: (target, override) => Effect.promise(() => routeNow(target, override)),
      forced: () => Ref.getUnsafe(current).forceProxy,
      view,
      setInstance
    })
  })
)
