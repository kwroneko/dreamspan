// Not an open proxy (spec/CARD-SOURCES.md §6.2). An adapter's requests leave only through
// here: on its own hosts, never to a private or loopback address unless the admin listed the
// host by name on the network bypass list (or the source is a local one), with response caps,
// 15 s to the first byte and 60 s in all, through the `Network` service (its proxy and route).
// Redirects are followed only within the origin (Network.fetchFor).
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { SourceFailed } from "@rp/shared/cardSources.ts"
import { Effect } from "effect"
import type { NetworkShape } from "../net/Network.ts"
import { DEFAULT_BYPASS, parseBypass } from "../net/route.ts"
import type { CardSourceAdapter, ResponseKind, SourceHttp, SourceResponse } from "./adapter.ts"
import type { Limiter } from "./limiter.ts"
import { DEFAULT_RATE } from "./limiter.ts"

const MiB = 1024 * 1024
const RESPONSE_CAPS: Record<ResponseKind, number> = { json: 2 * MiB, card: 64 * MiB, image: 16 * MiB }
const FIRST_BYTE_MS = 15_000
const TOTAL_MS = 60_000
const USER_AGENT = "rp-harness/0.0.0 (self-hosted roleplay app; browses card sources on its user's request)"

/** Every local range: loopback, RFC 1918, link-local, CGNAT, IPv6 ULA and link-local. */
const PRIVATE = parseBypass([
  ...DEFAULT_BYPASS.filter((entry) => entry !== "localhost"),
  // Unspecified destinations can connect to this machine too; they are not proxy bypass defaults.
  "0.0.0.0/8",
  "::/128"
]).list.addresses

export const isPrivateAddress = (ip: string) => {
  const bare = ip.replace(/^\[(.*)\]$/, "$1")
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1]
  const address = mapped ?? bare
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")
}

export interface GuardOptions {
  readonly network: Pick<NetworkShape, "fetchFor">
  readonly limiter: Limiter
  /** The admin's bypass entries: a host named there may resolve to a private address. */
  readonly bypassEntries: () => ReadonlyArray<string>
  readonly resolve?: (host: string) => Promise<ReadonlyArray<string>>
  /** Hears every request that leaves, for tests (`fakeArchive`'s counts are the archive's view). */
  readonly onRequest?: (sourceId: string, url: URL) => void
}

const fail = (sourceId: string, reason: SourceFailed["reason"], message: string, retryAfterMs?: number) =>
  new SourceFailed({ sourceId, reason, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })

/** How much of a refusal's body is read, for its error code. */
const REFUSAL_CAP = 4096

/** A refusal's error code: `{"error": "<code>"}` (cardex v1), `{"error": {"code": ...}}` or `{"code": ...}`. */
const refusalCode = (bytes: Uint8Array) => {
  try {
    const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
    if (typeof body !== "object" || body === null) return undefined
    const { error, code } = body as { error?: unknown; code?: unknown }
    const named =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null
          ? (error as { code?: unknown }).code
          : code
    return typeof named === "string" && /^[a-z0-9_]{1,64}$/.test(named) ? named : undefined
  } catch {
    return undefined
  }
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((answer) => answer.address)

/** Retry-After as seconds or an HTTP date, in milliseconds. */
const retryAfter = (value: string | null) => {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** Reads a body whole, refusing it as it passes the cap. */
const readCapped = async (response: Response, cap: number) => {
  const length = Number(response.headers.get("content-length") ?? "NaN")
  if (Number.isFinite(length) && length > cap) {
    await response.body?.cancel()
    throw new CapExceeded()
  }
  const chunks: Array<Uint8Array> = []
  let total = 0
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > cap) throw new CapExceeded()
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks)
}

class CapExceeded extends Error {}

export const makeSourceHttp = (
  adapter: CardSourceAdapter,
  apiKey: string | null,
  options: GuardOptions
): SourceHttp => {
  const scheme = adapter.scheme ?? "https"
  const hosts = new Set(adapter.hosts.map((host) => host.toLowerCase()))
  const resolve = options.resolve ?? defaultResolve

  /** Whether the admin named this host itself on the bypass list (not an address range). */
  const listedByName = (hostname: string) =>
    options.bypassEntries().some((entry) => entry.trim().toLowerCase().replace(/\.$/, "") === hostname)

  const checkTarget = (url: URL) =>
    Effect.gen(function* () {
      if (url.protocol !== `${scheme}:` || !hosts.has(url.host.toLowerCase()) || url.username || url.password) {
        return yield* fail(adapter.id, "bad_response", `${adapter.id} asked for a host it doesn't declare`)
      }
      if (adapter.local) return
      const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1")
      const addresses =
        isIP(hostname) !== 0
          ? [hostname]
          : yield* Effect.tryPromise({
              try: () => resolve(hostname),
              catch: () => fail(adapter.id, "unreachable", `can't resolve ${hostname}`)
            })
      if (addresses.length === 0 || (!listedByName(hostname) && addresses.some(isPrivateAddress))) {
        return yield* fail(adapter.id, "unreachable", `${hostname} is a private address`)
      }
      return addresses
    })

  // Network validates every redirect and connects to these literals, so a later socket
  // lookup (or the proxy's DNS) cannot replace an allowed answer with a private address.
  const fetch = options.network.fetchFor({ mode: "inherit" }, undefined, (url) => Effect.runPromise(checkTarget(url)))

  const get: SourceHttp["get"] = (url, kind, headers = {}) =>
    Effect.gen(function* () {
      yield* checkTarget(url)
      yield* options.limiter.take(adapter.id, adapter.rate ?? DEFAULT_RATE)
      options.onRequest?.(adapter.id, url)
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const controller = new AbortController()
          const abort = () => controller.abort()
          signal.addEventListener("abort", abort)
          const total = setTimeout(abort, TOTAL_MS)
          const first = setTimeout(abort, FIRST_BYTE_MS)
          try {
            const answer = await fetch(url.href, {
              headers: { "user-agent": USER_AGENT, accept: kind === "json" ? "application/json" : "*/*", ...headers },
              signal: controller.signal
            })
            clearTimeout(first)
            if (answer.status < 200 || answer.status > 299) {
              // A refused request's body names what was wrong; only a little of it is read.
              const refused =
                answer.status >= 400 && answer.status < 500 && ![401, 403, 404, 429].includes(answer.status)
              if (!refused) await answer.body?.cancel()
              const bytes = refused
                ? await readCapped(answer, REFUSAL_CAP).catch(() => new Uint8Array())
                : new Uint8Array()
              return { status: answer.status, headers: answer.headers, bytes }
            }
            return {
              status: answer.status,
              headers: answer.headers,
              bytes: await readCapped(answer, RESPONSE_CAPS[kind])
            }
          } finally {
            clearTimeout(first)
            clearTimeout(total)
            signal.removeEventListener("abort", abort)
          }
        },
        catch: (error) =>
          error instanceof CapExceeded
            ? fail(adapter.id, "bad_response", `${adapter.id} sent more than this app reads`)
            : error instanceof Error && error.name === "RedirectRefused"
              ? fail(adapter.id, "bad_response", error.message)
              : fail(adapter.id, "unreachable", `can't reach ${adapter.id}`)
      })
      const status = response.status
      if (status === 429) {
        const delay = options.limiter.limited(adapter.id, retryAfter(response.headers.get("retry-after")))
        return yield* fail(adapter.id, "rate_limited", `${adapter.id} is limiting requests`, delay)
      }
      if (status === 401 || status === 403)
        return yield* (adapter.key ?? "none") === "none"
          ? fail(adapter.id, "refused", `${adapter.id} refused the request`)
          : fail(adapter.id, "unauthorized", `${adapter.id} refused the key`)
      if (status === 451) return yield* fail(adapter.id, "region_unavailable", "not available in your region")
      if (status === 404) return yield* fail(adapter.id, "not_found", "not on the source")
      if (status >= 500) return yield* fail(adapter.id, "unreachable", `${adapter.id} answered ${status}`)
      if (status < 200 || status > 299) {
        const code = refusalCode(response.bytes)
        return yield* new SourceFailed({
          sourceId: adapter.id,
          reason: "bad_response",
          message: `${adapter.id} answered ${status}`,
          ...(code === undefined ? {} : { code })
        })
      }
      options.limiter.passed(adapter.id)
      const bytes = response.bytes
      return {
        status,
        headers: response.headers,
        bytes,
        json: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
      } satisfies SourceResponse
    })

  return { get, apiKey }
}
