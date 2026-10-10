// Route selection for outgoing requests (spec/PROVIDERS.md §6.2): through the instance
// proxy, through a connection's own proxy, or direct. Pure, so every rule is testable
// without a network.
import { BlockList, isIP, isIPv4 } from "node:net"

/**
 * Local ranges go direct by default, so local model servers aren't sent through the
 * proxy (owner, 2026-10-10). The admin can edit the list.
 */
export const DEFAULT_BYPASS: ReadonlyArray<string> = [
  "localhost",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10"
]

export interface BypassList {
  /** Exact hostnames, lowercase. */
  readonly hosts: ReadonlySet<string>
  /** Domain suffixes, lowercase, with the leading dot: ".lan" matches "gpu.lan". */
  readonly suffixes: ReadonlyArray<string>
  readonly addresses: BlockList
  /** Whether the list has address entries, i.e. whether resolving a hostname can matter. */
  readonly hasAddresses: boolean
}

/** Parses bypass entries: hostnames, `*.domain` or `.domain` suffixes, IPs and CIDR ranges. */
export const parseBypass = (entries: ReadonlyArray<string>) => {
  const hosts = new Set<string>()
  const suffixes: Array<string> = []
  const addresses = new BlockList()
  const invalid: Array<string> = []
  let hasAddresses = false
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase()
    if (entry === "") continue
    const [address, prefix] = entry.split("/")
    const family = isIP(address!)
    if (family !== 0) {
      const type = family === 4 ? "ipv4" : "ipv6"
      const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix)
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        invalid.push(raw)
        continue
      }
      addresses.addSubnet(address!, bits, type)
      hasAddresses = true
    } else if (prefix !== undefined || !/^(\*\.|\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/.test(entry)) {
      invalid.push(raw)
    } else if (entry.startsWith("*.") || entry.startsWith(".")) {
      suffixes.push(entry.slice(entry.indexOf(".")))
    } else {
      hosts.add(entry.replace(/\.$/, ""))
    }
  }
  return { list: { hosts, suffixes, addresses, hasAddresses } satisfies BypassList, invalid }
}

/** URL hostnames keep IPv6 brackets; addresses are compared without them. */
export const bareHost = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")

const addressMatches = (list: BypassList, ip: string) => {
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is the IPv4 address.
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip
  if (isIPv4(mapped)) return list.addresses.check(mapped, "ipv4")
  return isIP(ip) === 6 && list.addresses.check(ip, "ipv6")
}

/** Whether `host` is on the list by name or by address; `resolved` are its DNS answers. */
export const bypasses = (list: BypassList, host: string, resolved: ReadonlyArray<string> = []) => {
  const name = bareHost(host)
  if (isIP(name) !== 0) return addressMatches(list, name)
  if (list.hosts.has(name) || list.suffixes.some((suffix) => name.endsWith(suffix))) return true
  return resolved.some((ip) => addressMatches(list, ip))
}

export type ProxyOverride =
  { readonly mode: "inherit" } | { readonly mode: "direct" } | { readonly mode: "custom"; readonly url: string }

export type Route =
  | { readonly via: "direct"; readonly reason: "no_proxy" | "bypass" | "override" }
  | { readonly via: "proxy"; readonly proxy: string; readonly source: "instance" | "connection" }

/**
 * The route for one request. A connection's override wins; otherwise a target on the
 * bypass list goes direct; otherwise the instance proxy, if there is one.
 * `resolve` is only called when the answer depends on the target's addresses.
 */
export const decideRoute = async (options: {
  readonly target: URL
  readonly override: ProxyOverride
  readonly instanceProxy: string | null
  readonly bypass: BypassList
  readonly resolve: (host: string) => Promise<ReadonlyArray<string>>
}): Promise<Route> => {
  const { override, instanceProxy, bypass, target } = options
  if (override.mode === "direct") return { via: "direct", reason: "override" }
  if (override.mode === "custom") return { via: "proxy", proxy: override.url, source: "connection" }
  if (instanceProxy === null) return { via: "direct", reason: "no_proxy" }
  const host = bareHost(target.hostname)
  if (bypasses(bypass, host)) return { via: "direct", reason: "bypass" }
  if (bypass.hasAddresses && isIP(host) === 0) {
    // A failed lookup isn't a reason to go direct: the proxy may resolve what we can't.
    const resolved = await options.resolve(host).catch(() => [])
    if (bypasses(bypass, host, resolved)) return { via: "direct", reason: "bypass" }
  }
  return { via: "proxy", proxy: instanceProxy, source: "instance" }
}

export const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:"]

/** A proxy URL's problem, or null if it's usable. */
export const proxyUrlProblem = (raw: string) => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "not a URL"
  }
  if (!PROXY_SCHEMES.includes(url.protocol)) return "use an http, https or socks5 proxy URL"
  if (url.hostname === "") return "no proxy host"
  return null
}

/** A proxy URL as it may be shown: scheme, host and port, never credentials. */
export const displayProxy = (raw: string) => {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return "(invalid proxy URL)"
  }
}

/** One line on the route a request took, for the connection test and the request inspector. */
export const describeRoute = (route: Route, target: URL) => {
  const host = bareHost(target.hostname)
  if (route.via === "proxy") {
    return `via ${route.source === "connection" ? "this connection's proxy" : "proxy"} ${displayProxy(route.proxy)}`
  }
  switch (route.reason) {
    case "override":
      return "direct: overridden on this connection"
    case "bypass":
      return `direct: ${host} is in the bypass list`
    case "no_proxy":
      return "direct: no proxy configured"
  }
}
