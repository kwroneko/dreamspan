// Synthetic untrusted media, with no real internet traffic.
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { isPublicAddress } from "../src/net/addresses.ts"
import { makeExternalFetcher } from "../src/net/externalMedia.ts"
import type { NetworkShape, TargetAddresses } from "../src/net/Network.ts"

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)
const PUBLIC = "93.184.216.34"
const controller = () => new AbortController().signal
const fakeNetwork = (
  answer: (url: URL, init: RequestInit) => Promise<Response> = async () =>
    new Response(pixel, { headers: { "content-type": "image/png" } })
) => {
  const requests: Array<{ url: URL; init: RequestInit; addresses: ReadonlyArray<string> | undefined }> = []
  const network: Pick<NetworkShape, "fetchFor"> = {
    fetchFor: (_override, _route, check?: TargetAddresses) =>
      (async (input: string | URL, init: RequestInit = {}) => {
        let url = new URL(input)
        for (let hop = 0; ; hop++) {
          const addresses = await check?.(url)
          requests.push({ url, init, addresses })
          const response = await answer(url, init)
          const location = response.headers.get("location")
          if (!location) return response
          if (hop >= 5) throw new Error("redirect limit")
          await response.body?.cancel()
          url = new URL(location, url)
        }
      }) as typeof fetch
  }
  return { network, requests }
}

const refused = [
  "0.0.0.0",
  "10.0.0.1",
  "100.100.100.200",
  "100.64.0.1",
  "100.127.255.254",
  "127.0.0.1",
  "169.254.169.254",
  "172.31.0.1",
  "192.168.0.1",
  "192.0.0.1",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "168.63.129.16",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "fe80::1",
  "fd00:ec2::254",
  "ff02::1",
  "64:ff9b::7f00:1",
  "64:ff9b:1::a00:1",
  "::ffff:169.254.169.254",
  "::ffff:100.100.100.200",
  "2002:7f00:1::",
  "2001::1",
  "2001:db8::1",
  "not-an-ip"
]
describe("external media address policy", () => {
  for (const ip of refused)
    it(`refuses ${ip} after DNS resolution`, async () => {
      expect(isPublicAddress(ip)).toBe(false)
      const fake = fakeNetwork()
      const get = makeExternalFetcher(fake.network, { resolve: async () => [ip] })
      await expect(get("https://media.invalid/a", controller())).rejects.toThrow()
      expect(fake.requests).toHaveLength(0)
    })
  it("accepts only public answers and passes the exact checked literals to the transport", async () => {
    const fake = fakeNetwork()
    const addresses = [PUBLIC, "2606:4700:4700::1111"]
    await (
      await makeExternalFetcher(fake.network, { resolve: async () => addresses })(
        "https://media.invalid/a",
        controller()
      )
    ).dispose()
    expect(fake.requests[0]?.addresses).toEqual(addresses)
    for (const answers of [[], [PUBLIC, "127.0.0.1"]]) {
      await expect(
        makeExternalFetcher(fake.network, { resolve: async () => answers })("https://media.invalid/a", controller())
      ).rejects.toThrow()
    }
  })
  for (const url of [
    "file:///etc/hosts",
    "ftp://media.invalid/a",
    "data:image/png,a",
    "https://user:pass@media.invalid/a",
    "http://2130706433/a",
    "http://0177.0.0.1/a",
    "http://127.1/a",
    "http://127.0.1/a",
    "http://0/a",
    "http://0xA9FEA9FE/latest",
    "http://[64:ff9b::a9fe:a9fe]/latest",
    "http://0x7f000001/a",
    "http://[::ffff:7f00:1]/a"
  ])
    it(`refuses URL ${url}`, async () => {
      const fake = fakeNetwork()
      await expect(
        makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })(url, controller())
      ).rejects.toThrow()
      expect(fake.requests).toHaveLength(0)
    })
  for (const redirect of [
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest",
    "http://[fd00::1]/",
    "file:///etc/passwd",
    "https://user:pass@media.invalid/private"
  ])
    it(`checks redirected target ${redirect}`, async () => {
      const fake = fakeNetwork(async () => new Response(null, { status: 302, headers: { location: redirect } }))
      await expect(
        makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })(
          "https://media.invalid/start",
          controller()
        )
      ).rejects.toThrow()
      expect(fake.requests).toHaveLength(1)
    })
  it("refuses DNS rebinding between same-origin redirect hops", async () => {
    let lookups = 0
    const fake = fakeNetwork(async () => new Response(null, { status: 302, headers: { location: "/next" } }))
    await expect(
      makeExternalFetcher(fake.network, { resolve: async () => (++lookups === 1 ? [PUBLIC] : ["127.0.0.1"]) })(
        "https://media.invalid/start",
        controller()
      )
    ).rejects.toThrow()
    expect(fake.requests).toHaveLength(1)
  })
})

describe("external media response limits", () => {
  const run = (response: Response, limits = {}) =>
    makeExternalFetcher(fakeNetwork(async () => response).network, { resolve: async () => [PUBLIC], ...limits })(
      "https://media.invalid/a",
      controller()
    )
  for (const mime of [
    "text/html",
    "application/javascript",
    "image/svg+xml",
    "video/mp4",
    "application/octet-stream",
    ""
  ])
    it(`refuses content type ${mime}`, async () => {
      await expect(run(new Response("unsafe", { headers: { "content-type": mime } }))).rejects.toThrow()
    })
  it("caps both declared and streamed sizes", async () => {
    await expect(
      run(new Response("x", { headers: { "content-type": "image/png", "content-length": "100" } }), { maxBytes: 5 })
    ).rejects.toThrow()
    await expect(
      run(new Response("too long", { headers: { "content-type": "image/png" } }), { maxBytes: 5 })
    ).rejects.toThrow()
  })
  it("bounds DNS, headers and a stalled body by one total deadline", async () => {
    const never = () => new Promise<never>(() => {})
    await expect(
      makeExternalFetcher(fakeNetwork().network, { resolve: never, timeoutMs: 10 })(
        "https://media.invalid/a",
        controller()
      )
    ).rejects.toThrow()
    await expect(
      makeExternalFetcher(fakeNetwork(never).network, { resolve: async () => [PUBLIC], timeoutMs: 10 })(
        "https://media.invalid/a",
        controller()
      )
    ).rejects.toThrow()
    await expect(
      run(new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "image/png" } }), {
        timeoutMs: 10
      })
    ).rejects.toThrow()
  })
  it("returns images/audio with only fixed outbound headers and no credentials", async () => {
    const fake = fakeNetwork(
      async () => new Response(pixel, { headers: { "content-type": "image/png", "set-cookie": "secret=1" } })
    )
    const result = await makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })(
      "https://media.invalid/a",
      controller()
    )
    expect(result.mime).toBe("image/png")
    expect(await readFile(result.path)).toEqual(pixel)
    await result.dispose()
    expect(fake.requests[0]?.init.credentials).toBe("omit")
    expect(Object.keys(fake.requests[0]!.init.headers!)).toEqual(["accept", "accept-encoding"])
  })
})

describe("untrusted response bytes", () => {
  for (const body of [
    "<!doctype html><script>alert(1)</script>",
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  ])
    it("refuses active content mislabeled as an image", async () => {
      const fake = fakeNetwork(async () => new Response(body, { headers: { "content-type": "image/png" } }))
      await expect(
        makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })("https://media.invalid/a", controller())
      ).rejects.toThrow()
    })
})

it("requires the declared image type to match the sniffed bytes", async () => {
  const fake = fakeNetwork(async () => new Response(pixel, { headers: { "content-type": "image/jpeg" } }))
  await expect(
    makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })("https://media.invalid/a", controller())
  ).rejects.toThrow()
})

it.each([false, true])(
  "does not let a mislabeled archive allocate beyond the media limit (ID3 wrapper: %s)",
  async (wrapped) => {
    const bytes = Buffer.alloc(38)
    bytes.writeUInt32LE(0x04034b50, 0)
    bytes.writeUInt32LE(32 * 1024 * 1024, 18)
    bytes.writeUInt16LE(8, 26)
    bytes.write("mimetype", 30)
    const Native = globalThis.Uint8Array
    let oversized = false
    try {
      globalThis.Uint8Array = new Proxy(Native, {
        construct(target, args) {
          if (typeof args[0] === "number" && args[0] > 16 * 1024 * 1024) {
            oversized = true
            throw new Error("Prevented synthetic oversized allocation")
          }
          return Reflect.construct(target, args)
        }
      })
      const body = wrapped ? Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), bytes]) : bytes
      const fake = fakeNetwork(async () => new Response(body, { headers: { "content-type": "image/png" } }))
      await expect(
        makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })("https://media.invalid/a", controller())
      ).rejects.toThrow()
    } finally {
      globalThis.Uint8Array = Native
    }
    expect(oversized).toBe(false)
  }
)

// Review 3: public numbering must not widen the proxy into a local service client.
it.each(["http://media.invalid:25/a", "https://media.invalid:6379/a", "https://media.invalid:8080/a"])(
  "refuses non-web port %s before I/O",
  async (url) => {
    const fake = fakeNetwork()
    await expect(
      makeExternalFetcher(fake.network, { resolve: async () => [PUBLIC] })(url, controller())
    ).rejects.toThrow()
    expect(fake.requests).toHaveLength(0)
  }
)
it.each([
  "http://media.invalid:80/a",
  "https://media.invalid:443/a",
  "https://media.invalid:80/a",
  "http://media.invalid:443/a"
])("permits web port %s", async (url) => {
  await (
    await makeExternalFetcher(fakeNetwork().network, { resolve: async () => [PUBLIC] })(url, controller())
  ).dispose()
})
it("refuses every local interface address, including public IPv4 and equivalent IPv6 spellings", async () => {
  const fake = fakeNetwork()
  const interfaces = () =>
    ({
      synthetic: [
        { address: PUBLIC, family: "IPv4", netmask: "", mac: "", internal: false, cidr: null },
        {
          address: "2606:4700:4700:0:0:0:0:1111",
          family: "IPv6",
          netmask: "",
          mac: "",
          internal: false,
          cidr: null,
          scopeid: 0
        }
      ]
    }) as ReturnType<typeof import("node:os").networkInterfaces>
  for (const ip of [PUBLIC, "2606:4700:4700::1111"])
    await expect(
      makeExternalFetcher(fake.network, { interfaces, resolve: async () => [ip] })(
        "https://media.invalid/a",
        controller()
      )
    ).rejects.toThrow()
  expect(fake.requests).toHaveLength(0)
})
