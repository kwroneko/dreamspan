// IP and CIDR matching, shared by the bypass list (route.ts) and the exposure gate
// (exposure.ts).
import { BlockList, isIP } from "node:net"

/**
 * Adds `entry` (trimmed, lowercase) to `list` if it's an IP or a CIDR range. Returns
 * "added", "invalid" for an address with a malformed prefix, or "other" when it isn't an
 * address at all.
 */
export const addAddressRange = (list: BlockList, entry: string): "added" | "invalid" | "other" => {
  const [address, prefix, ...rest] = entry.split("/")
  const family = isIP(address!)
  if (family === 0) return "other"
  const max = family === 4 ? 32 : 128
  // Number("") is 0: an empty prefix would allow everything.
  if (rest.length > 0 || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return "invalid"
  const bits = prefix === undefined ? max : Number(prefix)
  if (bits > max) return "invalid"
  list.addSubnet(address!, bits, family === 4 ? "ipv4" : "ipv6")
  return "added"
}

/** Whether `ip` is in `list`. BlockList matches IPv4-mapped IPv6 (::ffff:10.0.0.1) against IPv4 ranges. */
export const inAddresses = (list: BlockList, ip: string) => {
  const family = isIP(ip)
  return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6")
}

/** Parses IP and CIDR entries, already trimmed and without blanks. */
export const parseAddresses = (entries: ReadonlyArray<string>) => {
  const list = new BlockList()
  const invalid = entries.filter((entry) => addAddressRange(list, entry.toLowerCase()) !== "added")
  return { list, invalid }
}

export const LOOPBACK: ReadonlyArray<string> = ["127.0.0.0/8", "::1/128"]

const denied = new BlockList()
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  denied.addSubnet(ip, bits, "ipv4")
// Azure's platform virtual address, globally numbered but not an internet destination.
denied.addAddress("168.63.129.16", "ipv4")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
denied.addSubnet("2001::", 23, "ipv6") // protocol assignments, including Teredo and benchmarking
// Documentation and IPv4-embedding/tunnelling must not provide a way back to a local target.
denied.addSubnet("2001:db8::", 32, "ipv6")
denied.addSubnet("2002::", 16, "ipv6")
denied.addSubnet("3fff::", 20, "ipv6")

export const isPublicAddress = (ip: string) => {
  const family = isIP(ip)
  if (family === 4) return !denied.check(ip, "ipv4")
  return family === 6 && globalV6.check(ip, "ipv6") && !denied.check(ip, "ipv6")
}

/** Normalize URL hostnames for address and special-use name checks. */
export const bareHost = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")

/** The name and its subdomains are reserved for loopback. */
export const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost")
