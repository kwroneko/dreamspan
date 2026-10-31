// Exposure safety (spec/DESIGN.md §11): which peers may connect at all. Checked on each
// connection's source address, never on a forwarded header, so it holds in Docker, where
// the host's own requests arrive from the bridge gateway rather than from loopback.
import { isIP } from "node:net"
import { Context, Effect, Layer, Schema } from "effect"
import { AppConfig } from "../config.ts"
import { type AddressSet, makeAddressSet } from "./addressSet.ts"
import { inAddresses, LOOPBACK, parseAddresses } from "./addresses.ts"

const loopback = parseAddresses(LOOPBACK).list

/**
 * ALLOWED_IPS and TRUSTED_PROXIES as live sets, their host names kept resolved
 * (net/addressSet.ts). One instance, so the exposure gate and passwordless login agree.
 */
export class TrustedAddresses extends Context.Service<
  TrustedAddresses,
  { readonly allowedIps: AddressSet; readonly trustedProxies: AddressSet }
>()("rp/TrustedAddresses") {
  static readonly layer = Layer.effect(
    TrustedAddresses,
    Effect.gen(function* () {
      const config = yield* AppConfig
      return {
        allowedIps: yield* makeAddressSet("ALLOWED_IPS", config.allowedIps),
        trustedProxies: yield* makeAddressSet("TRUSTED_PROXIES", config.trustedProxies)
      }
    })
  )
}

/** Whether `ip` is loopback. */
export const isLoopback = (ip: string) => inAddresses(loopback, ip)

export interface ExposureConfig {
  readonly host: string
  readonly authMode: "single" | "proxy"
  readonly allowInsecureExposure: boolean
}

export interface ExposurePolicy {
  /** Whether a connection from `ip` is served. */
  readonly allows: (ip: string | undefined) => boolean
  /**
   * Called for each refused connection: asks for the names to be resolved again, in case
   * the peer is a proxy that just moved, and returns the warning to log, at most once a
   * minute per address.
   */
  readonly refused: (ip: string | undefined, now?: number) => string | undefined
  /** The 403's body. */
  readonly refusal: (ip: string | undefined) => string
  /** One line for the startup log. */
  readonly summary: () => string
}

const isLoopbackHost = (host: string) => {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  return bare === "localhost" || inAddresses(loopback, bare)
}

const FIX =
  "Give the admin a password (ADMIN_PASSWORD_FILE or ADMIN_PASSWORD), set ALLOWED_IPS to the addresses that may " +
  "connect, use AUTH_MODE=proxy with TRUSTED_PROXIES naming your reverse proxy, or set HOST=127.0.0.1. " +
  "ALLOW_INSECURE_EXPOSURE=true serves everyone without protection."

const WARN_EVERY_MS = 60_000
/** Addresses remembered for the warning's rate limit; past this, the oldest are forgotten. */
const WARNED_MAX = 1024

/**
 * The peers allowed in:
 * - single mode: loopback and ALLOWED_IPS. Without ALLOWED_IPS, everyone while an
 *   account has a password (`passwords`), since then everyone has to log in.
 * - proxy mode: TRUSTED_PROXIES only (loopback when unset). Only the proxy may connect,
 *   since anyone who can connect can send the identity header and be any user.
 * Entries may be host names, resolved in the background (net/addressSet.ts), failing closed.
 * Listening beyond loopback with nothing but loopback allowed is a startup error, not a
 * server that silently refuses everyone. Returns the error message on a bad config.
 */
export const exposurePolicy = (
  config: ExposureConfig,
  lists: { readonly allowedIps: AddressSet; readonly trustedProxies: AddressSet },
  passwords: () => boolean
): ExposurePolicy | string => {
  const { allowedIps, trustedProxies } = lists
  const proxy = config.authMode === "proxy"
  const refusal = (ip: string | undefined) =>
    `${ip ?? "This address"} isn't ${proxy ? "a trusted proxy of" : "allowed to connect to"} this instance.\n`
  if (config.allowInsecureExposure) {
    // A leftover override would silently undo the lists, and in proxy mode let anyone name any user.
    if (allowedIps.entries.length > 0 || trustedProxies.entries.length > 0) {
      return "ALLOW_INSECURE_EXPOSURE can't be combined with ALLOWED_IPS or TRUSTED_PROXIES: it would override them."
    }
    const summary = "ALLOW_INSECURE_EXPOSURE: every address may connect, without protection"
    return { allows: () => true, refused: () => undefined, refusal, summary: () => summary }
  }
  if (proxy && allowedIps.entries.length > 0) {
    return "ALLOWED_IPS doesn't apply in proxy mode, where only the proxy may connect. List the proxy in TRUSTED_PROXIES."
  }
  const set = proxy ? trustedProxies : allowedIps
  const name = proxy ? "TRUSTED_PROXIES" : "ALLOWED_IPS"
  if (set.invalid.length > 0) {
    return `${name} has entries that aren't IPs, CIDR ranges or host names: ${set.invalid.join(", ")}`
  }
  const configured = set.entries.length > 0
  const withLoopback = !(proxy && configured)
  // Checked on every connection: if the last password goes, so does access beyond loopback.
  const byPassword = !proxy && !configured
  if (!configured && !isLoopbackHost(config.host) && !(byPassword && passwords())) {
    return `Refusing to listen on ${config.host} without protection. ${FIX}`
  }
  const accepted = () => [...(withLoopback ? ["loopback"] : []), ...(configured ? [set.describe()] : [])].join(", ")
  const warned = new Map<string, number>()
  return {
    allows: (ip) =>
      ip !== undefined && ((withLoopback && isLoopback(ip)) || set.has(ip) || (byPassword && passwords())),
    refused: (ip, now = Date.now()) => {
      set.refreshSoon()
      const key = ip ?? "unknown"
      const last = warned.get(key)
      if (last !== undefined && now - last < WARN_EVERY_MS) return undefined
      warned.delete(key)
      if (warned.size >= WARNED_MAX) warned.delete(warned.keys().next().value!)
      warned.set(key, now)
      return `Refused a connection from ${key}: AUTH_MODE=${config.authMode} accepts ${accepted()} only (${name}). At most one warning a minute per address.`
    },
    refusal,
    summary: () =>
      `connections accepted from ${accepted()}${byPassword ? ", and from everyone while an account has a password" : ""}`
  }
}

export class UnsafeExposure extends Schema.TaggedError<UnsafeExposure>()("UnsafeExposure", {
  message: Schema.String
}) {}

/** The response to a refused connection, written straight to the socket. */
export const refusedResponse = (body: string) =>
  [
    "HTTP/1.1 403 Forbidden",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body
  ].join("\r\n")

export interface PublicOrigins {
  /** As browsers send them in Origin: scheme, host and port. */
  readonly origins: ReadonlyArray<string>
  readonly hosts: ReadonlySet<string>
}

/**
 * Parses PUBLIC_ORIGINS. An entry must already be an origin: a path, credentials or a
 * wildcard would otherwise be dropped or never match, and the result would be 403s
 * nobody can explain.
 */
export const parsePublicOrigins = (entries: ReadonlyArray<string>) => {
  const origins: Array<string> = []
  const invalid: Array<string> = []
  for (const entry of entries.map((raw) => raw.trim()).filter((raw) => raw !== "")) {
    const origin = URL.parse(entry)?.origin
    const exact = origin === entry.replace(/\/$/, "").toLowerCase() && !entry.includes("*")
    if (origin === undefined || origin === "null" || !exact) invalid.push(entry)
    else origins.push(origin)
  }
  const hosts = new Set(origins.map((origin) => new URL(origin).host))
  return { publicOrigins: { origins, hosts } satisfies PublicOrigins, invalid }
}

/**
 * Browsers let any page open a WebSocket to any address, the user's own loopback
 * included, so a page from another site could otherwise drive every RPC. And a page on
 * an attacker's domain re-resolved to 127.0.0.1 (DNS rebinding) is same-origin with itself.
 * So:
 * - Origin, when present, must be a public origin, or name the Host the request was sent
 *   to when that isn't a public host (so http:// can't stand in for a public https://).
 * - Host must be localhost, an IP literal (rebinding needs a name) or a public host,
 *   except in proxy mode with named proxies: only they can connect, so no rebound page
 *   reaches the server, and proxies often forward their own Host.
 * Clients that send no Origin aren't browsers, so they have no one's session to borrow.
 * Returns why a request is refused, or undefined.
 */
export const crossSiteProblem = (
  headers: { readonly host?: string | undefined; readonly origin?: string | undefined },
  publicOrigins: PublicOrigins,
  checkHost: boolean
) => {
  const host = headers.host === undefined ? undefined : URL.parse(`http://${headers.host}`)
  if (checkHost && headers.host !== undefined) {
    const name = host?.hostname.replace(/^\[(.*)\]$/, "$1")
    if (name === undefined || (name !== "localhost" && isIP(name) === 0 && !publicOrigins.hosts.has(host!.host))) {
      return `Host ${headers.host} isn't one of this instance's addresses. Add its origin to PUBLIC_ORIGINS.`
    }
  }
  if (headers.origin === undefined || publicOrigins.origins.includes(headers.origin)) return undefined
  const origin = URL.parse(headers.origin)
  if (origin === null || host == null || origin.host !== host.host || publicOrigins.hosts.has(origin.host)) {
    return `Origin ${headers.origin} may not use this instance. Add it to PUBLIC_ORIGINS if it's this instance's address.`
  }
  return undefined
}
