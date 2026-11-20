// What a request's secret inventory scrubs from errors, captures and the ledger (`requestSecrets`):
// real credentials always, and never ordinary text such as a provider's own link or a word that
// happens to be a non-credential header's value. Synthetic values only.
import { assert, describe, it } from "@effect/vitest"
import { incidentalSecret, makeScrub, requestSecrets } from "../src/providers/Providers.ts"

const providerLink = "Give it once at https://acme.example/consents?model=acme-large-2"

describe("a request's secret inventory", () => {
  it("scrubs a real key, a bearer token, a proxy password and an MCP sign-in token", () => {
    const inventory = requestSecrets()
    const key = "sk-acme-3f9a1c7e5b2d4086"
    const bearer = "acme-bearer-91be44c0aa17"
    const password = "proxy-pass-7Qx2r9Lm"
    const access = "mcp-access-5d1e8f0b2c9a7731"
    const refresh = "mcp-refresh-c4a9e2f17b30d5"
    inventory.add(key)
    inventory.headers({ "X-Gateway": `Bearer ${bearer}` })
    inventory.add(`http://proxyuser42:${encodeURIComponent(password)}@proxy.acme.example:3128`)
    // As McpConnections.prepare does with a user's sign-in.
    inventory.add(access)
    inventory.add(refresh)
    inventory.headers({ Authorization: `Bearer ${access}` })
    const text = `rejected ${key}, ${bearer}, ${password}, ${access}, ${refresh}; ${providerLink}`
    const scrubbed = inventory.scrub(text)
    for (const secret of [key, bearer, password, access, refresh]) assert.notInclude(scrubbed, secret)
    assert.include(scrubbed, providerLink)
  })

  it("scrubs credential headers by name, Basic parts, and a key in an address", () => {
    const inventory = requestSecrets()
    const basicPassword = "basic-secret-p4ss"
    const basic = Buffer.from(`acme-user-0042:${basicPassword}`).toString("base64")
    inventory.headers({
      "x-api-key": "acme-header-key-8812",
      "api-key": "azure-style-key-0f3c",
      "X-Session-Token": "session-tok-77a1b2c3",
      "Proxy-Authorization": `Basic ${basic}`,
      Cookie: "sid=acme-cookie-5512aa"
    })
    inventory.route("https://gw.acme.example/k/acme-route-key-a81f/openai-compatible/v1?access_token=query-tok-19ab")
    const values = [
      "acme-header-key-8812",
      "azure-style-key-0f3c",
      "session-tok-77a1b2c3",
      basic,
      basicPassword,
      "sid=acme-cookie-5512aa",
      "acme-route-key-a81f",
      "query-tok-19ab"
    ]
    const scrubbed = inventory.scrub(values.join(" "))
    for (const value of values) assert.notInclude(scrubbed, value)
    // The address's host and plain route names stay readable.
    assert.strictEqual(
      inventory.scrub("https://gw.acme.example/k/x/openai-compatible/v1"),
      "https://gw.acme.example/k/x/openai-compatible/v1"
    )
  })

  it("leaves a non-credential header's word in a provider's link", () => {
    const inventory = requestSecrets()
    inventory.headers({
      "X-Title": "acme",
      "HTTP-Referer": "https://acme.example",
      Referer: "https://acme.example/app",
      "User-Agent": "AcmeStudioClient/1.4.2 (synthetic)",
      "X-Client-Name": "acme-roleplay-studio"
    })
    assert.strictEqual(inventory.scrub(providerLink), providerLink)
    assert.strictEqual(
      inventory.scrub("AcmeStudioClient/1.4.2 (synthetic) at https://acme.example/app"),
      "AcmeStudioClient/1.4.2 (synthetic) at https://acme.example/app"
    )
  })

  it("always scrubs a credential by where it came from, short or a plain word", () => {
    const inventory = requestSecrets()
    const password = "pw7x2q"
    const key = "acmekeys"
    inventory.add(key)
    inventory.add(`http://proxyuser:${password}@proxy.acme.example:3128`)
    inventory.headers({ "x-api-key": "zeta", Authorization: "Bearer gamma" })
    inventory.route("https://acme.example/v1?api_key=omega")
    inventory.variables({ NOTES_TOKEN: "delta", LOG_LEVEL: "debug", DATA_DIR: "local-notes-archive" })
    const scrubbed = inventory.scrub(
      `proxy proxyuser said ${password}; key ${key}; zeta gamma omega delta; level debug in local-notes-archive`
    )
    for (const secret of [password, key, "proxyuser", "zeta", "gamma", "omega", "delta"])
      assert.notInclude(scrubbed, secret)
    // A variable not named like a credential is kept only if it looks like one.
    assert.include(scrubbed, "level debug in local-notes-archive")
    assert.strictEqual(makeScrub([key])(`the ${key} key`), "the [redacted] key")
  })

  it("never scrubs a 1–3 character fragment, or a plain route name or host of an address", () => {
    const inventory = requestSecrets()
    inventory.add("ab")
    inventory.headers({ "x-api-key": "k9", Authorization: "Bearer xyz" })
    inventory.route("https://acme.example/acme/openai-compatible/v1?model=acme-large")
    assert.strictEqual(inventory.scrub(providerLink), providerLink)
    assert.strictEqual(inventory.scrub("about the xyz k9 tab"), "about the xyz k9 tab")
    assert.strictEqual(makeScrub(["ab", "k9"])(providerLink), providerLink)
  })

  it("judges values that aren't credentials by origin by length and shape", () => {
    assert.isTrue(incidentalSecret("sk-acme-3f9a1c7e5b2d"))
    assert.isTrue(incidentalSecret("acme-route-key-a81f"))
    assert.isFalse(incidentalSecret("eleven-ch4r"))
    assert.isFalse(incidentalSecret("api.acme.example"))
    assert.isFalse(incidentalSecret("Organization"))
    assert.isFalse(incidentalSecret("openai-compatible"))
  })
})
