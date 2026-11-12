// Untrusted message URLs never use the admin's private-host exceptions. Network checks each
// hop with this policy and pins its checked literals on the wire (also through proxies).
import { Resolver } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { fileTypeFromBuffer } from "file-type"
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
/** Sniff a bounded media prefix only. General file detectors also unpack archives;
 * untrusted archive sizes must never reach those parsers, even with an image header.
 * Skip bounded ID3 metadata ourselves so it cannot recurse into a disguised archive. */
const mediaSample = (bytes: Buffer) => {
  let sample = bytes
  for (let tags = 0; sample.subarray(0, 3).toString("ascii") === "ID3"; tags++) {
    if (tags >= 8 || sample.length < 10 || sample.subarray(6, 10).some((byte) => byte > 127))
      throw new ExternalMediaRefused("Invalid audio metadata")
    const size = sample[6]! * 128 ** 3 + sample[7]! * 128 ** 2 + sample[8]! * 128 + sample[9]!
    const footer = sample[3] === 4 && (sample[5]! & 0x10) !== 0 ? 10 : 0
    sample = sample.subarray(10 + size + footer)
  }
  const ascii = (at: number, value: string) => sample.subarray(at, at + value.length).toString("latin1") === value
  const media =
    sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (sample[0] === 255 && sample[1] === 216 && sample[2] === 255) ||
    ascii(0, "GIF87a") ||
    ascii(0, "GIF89a") ||
    (ascii(0, "RIFF") && (ascii(8, "WAVE") || ascii(8, "WEBP"))) ||
    (ascii(4, "ftyp") &&
      sample.length >= 16 &&
      sample.readUInt32BE(0) >= 16 &&
      sample.readUInt32BE(0) <= sample.length) ||
    ascii(0, "OggS") ||
    ascii(0, "fLaC") ||
    (sample[0] === 255 && sample[1] !== undefined && (sample[1] & 0xe0) === 0xe0)
  if (!media) throw new ExternalMediaRefused("Not a supported media signature")
  return sample.subarray(0, 4100)
}
/**
 * A and AAAA answers from c-ares, never getaddrinfo (`dns.lookup`): that runs on libuv's
 * shared pool of four threads (file reads, zlib, scrypt logins) and can't be cancelled, so a
 * message naming hosts whose DNS never answers would hold the pool past the media deadline.
 * Each request has its own resolver, cancelled when the request ends.
 */
const resolveOffPool =
  (servers?: ReadonlyArray<string>) =>
  async (hostname: string, signal: AbortSignal): Promise<ReadonlyArray<string>> => {
    const resolver = new Resolver({ timeout: 2_000, tries: 2 })
    if (servers) resolver.setServers([...servers])
    const cancel = () => resolver.cancel()
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
      return answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []))
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
interface Limits {
  readonly resolve?: (hostname: string, signal: AbortSignal) => Promise<ReadonlyArray<string>>
  /** DNS servers for the default resolver; the system's otherwise. */
  readonly dnsServers?: ReadonlyArray<string>
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

/** Fixed headers only: never cookies, authorization, referrers, ranges or upstream cache validators. */
export const makeExternalFetcher = (network: Pick<NetworkShape, "fetchFor">, limits: Limits = {}) => {
  const resolve = limits.resolve ?? resolveOffPool(limits.dnsServers)
  const maxBytes = limits.maxBytes ?? 16 * 1024 * 1024
  const timeoutMs = limits.timeoutMs ?? 15_000
  return async (url: string, signal: AbortSignal): Promise<ExternalMediaFile> => {
    const controller = new AbortController()
    const fetch = network.fetchFor({ mode: "inherit" }, undefined, async (target) => {
      const bad = !["http:", "https:"].includes(target.protocol) || target.username || target.password
      if (bad || target.href.length > 8192)
        throw new ExternalMediaRefused("Only public HTTP and HTTPS media addresses without credentials are allowed")
      const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1")
      const addresses = isIP(hostname) ? [hostname] : await resolve(hostname, controller.signal)
      if (addresses.length === 0 || addresses.some((ip) => !isPublicMediaAddress(ip)))
        throw new ExternalMediaRefused("This media address is not public")
      return addresses
    })
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
        const bytes = Buffer.concat(chunks)
        const detected = await fileTypeFromBuffer(mediaSample(bytes))
        const normalize = (type: string) => {
          const base = type.split(";")[0]!.trim()
          return base === "image/apng"
            ? "image/png"
            : base === "audio/x-wav"
              ? "audio/wav"
              : base === "audio/x-m4a"
                ? "audio/mp4"
                : base
        }
        const sniffed = detected ? normalize(detected.mime) : ""
        if (!TYPES.has(sniffed) || sniffed !== normalize(mime))
          throw new ExternalMediaRefused("The media bytes do not match a supported image or audio type")
        return { bytes, mime: sniffed }
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
