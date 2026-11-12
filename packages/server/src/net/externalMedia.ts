// Untrusted message URLs never use the admin's private-host exceptions. Network checks each
// hop with this policy and pins its checked literals on the wire (also through proxies).
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import type { NetworkShape } from "./Network.ts"

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

export const isPublicMediaAddress = (ip: string) => {
  const family = isIP(ip)
  if (family === 4) return !denied.check(ip, "ipv4")
  return family === 6 && globalV6.check(ip, "ipv6") && !denied.check(ip, "ipv6")
}

const TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm"
])
interface ExternalMediaFile {
  readonly bytes: Uint8Array
  readonly mime: string
}
class ExternalMediaRefused extends Error {}
interface Limits {
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<string>>
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

/** Fixed headers only: never cookies, authorization, referrers, ranges or upstream cache validators. */
export const makeExternalFetcher = (network: Pick<NetworkShape, "fetchFor">, limits: Limits = {}) => {
  const resolve =
    limits.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map((a) => a.address))
  const maxBytes = limits.maxBytes ?? 16 * 1024 * 1024
  const timeoutMs = limits.timeoutMs ?? 15_000
  const fetch = network.fetchFor({ mode: "inherit" }, undefined, async (url) => {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192)
      throw new ExternalMediaRefused("Only public HTTP and HTTPS media addresses without credentials are allowed")
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1")
    const addresses = isIP(hostname) ? [hostname] : await resolve(hostname)
    if (addresses.length === 0 || addresses.some((ip) => !isPublicMediaAddress(ip)))
      throw new ExternalMediaRefused("This media address is not public")
    return addresses
  })
  return async (url: string, signal: AbortSignal): Promise<ExternalMediaFile> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort()
        reject(new ExternalMediaRefused("The media request took too long"))
      }, timeoutMs)
    })
    const read = async () => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: [...TYPES].join(", "), "accept-encoding": "identity" }
      })
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
      const length = Number(response.headers.get("content-length"))
      if (!response.ok || !TYPES.has(mime) || length > maxBytes) {
        await response.body?.cancel()
        throw new ExternalMediaRefused(
          "The address did not return a supported image or audio file within the size limit"
        )
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        if (reader)
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > maxBytes) throw new ExternalMediaRefused("The media file is too large")
            chunks.push(chunk.value)
          }
        return { bytes: Buffer.concat(chunks), mime }
      } finally {
        await reader?.cancel()
      }
    }
    try {
      return await Promise.race([read(), timeout])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      abort()
    }
  }
}
