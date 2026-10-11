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
