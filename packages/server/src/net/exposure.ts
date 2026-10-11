// Exposure safety (spec/DESIGN.md §11): which peers may connect at all. Checked on each
// connection's source address, never on a forwarded header, so it holds in Docker, where
// the host's own requests arrive from the bridge gateway rather than from loopback.
import { isIP } from "node:net"
import { Schema } from "effect"
import { inAddresses, LOOPBACK, parseAddresses } from "./addresses.ts"

const loopback = parseAddresses(LOOPBACK).list

export interface ExposureConfig {
  readonly host: string
  readonly authMode: "single" | "proxy"
  readonly allowedIps: ReadonlyArray<string>
  readonly trustedProxies: ReadonlyArray<string>
  readonly allowInsecureExposure: boolean
}

export interface ExposurePolicy {
  /** Whether a connection from `ip` is served. */
  readonly allows: (ip: string | undefined) => boolean
  /** One line for the startup log. */
  readonly summary: string
}

const isLoopbackHost = (host: string) => {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  return bare === "localhost" || inAddresses(loopback, bare)
}

const FIX =
  "Set ALLOWED_IPS to the addresses that may connect, use AUTH_MODE=proxy with TRUSTED_PROXIES naming your reverse proxy, " +
  "or set HOST=127.0.0.1. ALLOW_INSECURE_EXPOSURE=true serves everyone without protection."

/**
 * The peers allowed in:
 * - single mode: loopback and ALLOWED_IPS.
 * - proxy mode: TRUSTED_PROXIES only (loopback when unset), so the identity header always
 *   comes from the proxy. Anyone else could otherwise send it and be any user.
 * Listening beyond loopback with nothing but loopback allowed is a startup error, not a
 * server that silently refuses everyone. Returns the error message on a bad config.
 */
export const exposurePolicy = (config: ExposureConfig): ExposurePolicy | string => {
  const clean = (entries: ReadonlyArray<string>) => entries.map((entry) => entry.trim()).filter((entry) => entry !== "")
  const allowedIps = clean(config.allowedIps)
  const trustedProxies = clean(config.trustedProxies)
  if (config.allowInsecureExposure) {
    // A leftover override would silently undo the lists, and in proxy mode let anyone name any user.
    if (allowedIps.length > 0 || trustedProxies.length > 0) {
      return "ALLOW_INSECURE_EXPOSURE can't be combined with ALLOWED_IPS or TRUSTED_PROXIES: it would override them."
    }
    return { allows: () => true, summary: "ALLOW_INSECURE_EXPOSURE: every address may connect, without protection" }
  }
  if (config.authMode === "proxy" && allowedIps.length > 0) {
    return "ALLOWED_IPS doesn't apply in proxy mode, where only the proxy may connect. List the proxy in TRUSTED_PROXIES."
  }
  const configured = config.authMode === "proxy" ? trustedProxies : allowedIps
  const name = config.authMode === "proxy" ? "TRUSTED_PROXIES" : "ALLOWED_IPS"
  const entries = config.authMode === "proxy" && configured.length > 0 ? configured : [...LOOPBACK, ...configured]
  const { list, invalid } = parseAddresses(entries)
  if (invalid.length > 0) return `${name} has entries that aren't IPs or CIDR ranges: ${invalid.join(", ")}`
  if (configured.length === 0 && !isLoopbackHost(config.host)) {
    return `Refusing to listen on ${config.host} without protection. ${FIX}`
  }
  return {
    allows: (ip) => ip !== undefined && inAddresses(list, ip),
    summary: `connections accepted from ${entries.join(", ")}`
  }
}

export class UnsafeExposure extends Schema.TaggedError<UnsafeExposure>()("UnsafeExposure", {
  message: Schema.String
}) {}

/** The response to a refused connection, written straight to the socket. */
export const REFUSED_RESPONSE = [
  "HTTP/1.1 403 Forbidden",
  "Content-Type: text/plain; charset=utf-8",
  "Connection: close",
  "",
  "This address may not connect to this instance.\n"
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
