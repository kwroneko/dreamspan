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
      "User-Agent": "AcmeStudioClient/1.4.2 (synthetic)"
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
    for (const secret of [password, key, "zeta", "gamma", "omega", "delta"]) assert.notInclude(scrubbed, secret)
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

  it("scrubs a configured custom header's value, whatever its name", () => {
    const inventory = requestSecrets()
    inventory.headers({
      "X-Pass": "s3cr3tvalue123456",
      "X-Session": "s3ss-41",
      "X-Tenant": "acmecorp",
      "X-Retries": "3",
      "X-Debug": "false",
      "X-Callback": "https://hooks.acme.example/cb/hook-9f2e7a1c4b3d8e"
    })
    const scrubbed = inventory.scrub(
      "sent s3cr3tvalue123456 and s3ss-41 for acmecorp to https://hooks.acme.example/cb/hook-9f2e7a1c4b3d8e"
    )
    for (const secret of ["s3cr3tvalue123456", "s3ss-41", "acmecorp", "hook-9f2e7a1c4b3d8e"])
      assert.notInclude(scrubbed, secret)
    // A link's host, a switch and a count stay readable.
    assert.include(scrubbed, "https://hooks.acme.example/cb/")
    assert.strictEqual(inventory.scrub("retry 3 times, debug false"), "retry 3 times, debug false")
  })

  it("matches credential names by whole parts, and never takes a switch or a count for one", () => {
    const inventory = requestSecrets()
    inventory.variables({
      TOKENIZERS_PARALLELISM: "false",
      MAX_TOKENS: "4096",
      AUTH_ENABLED: "true",
      AUTH_MODE: "oauth",
      NOTES_API_KEY: "notes-key-1234",
      NOTES_PIN_TOKEN: "902118"
    })
    inventory.headers({ "X-Auth-Mode": "basic", "X-Api-Key": "acme-xkey-77" })
    inventory.route("https://acme.example/v1?max_tokens=1024&maxTokens=2048&accessToken=acme-qtok-55")
    const text = "max 4096 or 1024 or 2048 tokens, parallel false, auth true via oauth basic"
    assert.strictEqual(inventory.scrub(text), text)
    const scrubbed = inventory.scrub("notes-key-1234 acme-xkey-77 acme-qtok-55 902118")
    // A number under a credential's own name may be a PIN, so it goes.
    for (const secret of ["notes-key-1234", "acme-xkey-77", "acme-qtok-55", "902118"])
      assert.notInclude(scrubbed, secret)
  })

  it("keeps a proxy's or an address's plain username readable, and scrubs its password", () => {
    const inventory = requestSecrets()
    inventory.add("http://user:pr0xy-pw@proxy.acme.example:3128")
    inventory.route("https://assistant:hunter22@acme.example/v1")
    inventory.headers({ "Proxy-Authorization": `Basic ${Buffer.from("user:hunter33").toString("base64")}` })
    inventory.add("http://alice@proxy2.acme.example:3128")
    const text = 'expected "user", "alice" and "assistant"; pass a value'
    assert.strictEqual(inventory.scrub(text), text)
    const scrubbed = inventory.scrub("pr0xy-pw hunter22 hunter33")
    for (const secret of ["pr0xy-pw", "hunter22", "hunter33"]) assert.notInclude(scrubbed, secret)
    // Where it stands as a credential, the username goes too.
    const echoed = inventory.scrub(
      "via http://user:pr0xy-pw@proxy.acme.example:3128, user:hunter33 and http://alice@proxy2.acme.example"
    )
    for (const part of ["user:", "//user", "alice@"]) assert.notInclude(echoed, part)
    assert.include(echoed, "proxy2.acme.example")
    // A username that could be a secret still goes.
    const long = requestSecrets()
    long.add("http://u-8f3a1c9e2b7d4f60:pw12@proxy.acme.example:3128")
    assert.notInclude(long.scrub("as u-8f3a1c9e2b7d4f60"), "u-8f3a1c9e2b7d4f60")
  })

  it("scrubs a long or mixed-case letters-only key in an address", () => {
    const inventory = requestSecrets()
    inventory.route("https://gw.acme.example/AbCdEfGhIjKlMnOpQrStUvWx/v1")
    inventory.route("https://gw.acme.example/qwertzuiopasdfghjklyxcv/v1")
    const scrubbed = inventory.scrub("at /AbCdEfGhIjKlMnOpQrStUvWx/ and /qwertzuiopasdfghjklyxcv/")
    assert.notInclude(scrubbed, "AbCdEfGhIjKlMnOpQrStUvWx")
    assert.notInclude(scrubbed, "qwertzuiopasdfghjklyxcv")
    assert.isTrue(incidentalSecret("abcdefghijklmnopqrst"))
    assert.isTrue(incidentalSecret("route-AbCdEfGhIjKlMn"))
  })

  it("judges values that aren't credentials by origin by length and shape", () => {
    assert.isTrue(incidentalSecret("sk-acme-3f9a1c7e5b2d"))
    assert.isTrue(incidentalSecret("acme-route-key-a81f"))
    assert.isFalse(incidentalSecret("eleven-ch4r"))
    assert.isFalse(incidentalSecret("api.acme.example"))
    assert.isFalse(incidentalSecret("Organization"))
    assert.isFalse(incidentalSecret("openai-compatible"))
    assert.isFalse(incidentalSecret("Organization-Settings"))
    assert.isFalse(incidentalSecret("CONTENT_FILTER"))
  })
})
