import { assert, it } from "@effect/vitest"
import { CHAT_WIDTH, DEFAULT_DISPLAY_PREFS, DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { Effect, Schema } from "effect"
import { client, testConfig, withServer } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("model pins, recent choices and sort persist per account and merge independent devices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const phone = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    yield* alice.SetDisplayPrefs({
      prefs: { modelPins: { "router alpha": true }, modelRecent: { "router alpha": 100 } }
    })
    yield* phone.SetDisplayPrefs({
      prefs: { modelPins: { "local beta": true }, modelRecent: { "local beta": 200 }, modelSort: "used" }
    })
    yield* alice.SetDisplayPrefs({ prefs: { modelPins: { "router alpha": false }, coverageRail: true } })
    const saved = yield* phone.GetDisplayPrefs({})
    assert.deepStrictEqual(saved.modelPins, { "router alpha": false, "local beta": true })
    assert.deepStrictEqual(saved.modelRecent, { "local beta": 200, "router alpha": 100 })
    yield* phone.SetDisplayPrefs({ prefs: { modelRecent: { "local beta": 150 } } })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).modelRecent["local beta"], 200)
    assert.strictEqual(saved.modelSort, "used")
    assert.strictEqual(saved.coverageRail, true)
    const separate = yield* bob.GetDisplayPrefs({})
    assert.deepStrictEqual(separate.modelPins, {})
    assert.deepStrictEqual(separate.modelRecent, {})
    assert.strictEqual(separate.modelSort, "name")
    yield* alice.SetDisplayPrefs({
      prefs: { modelRecent: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`studio model-${i}`, i + 300])) }
    })
    const capped = (yield* phone.GetDisplayPrefs({})).modelRecent
    assert.strictEqual(Object.keys(capped).length, 100)
    assert.isUndefined(capped["router alpha"])
    assert.strictEqual(capped["studio model-99"], 399)
    assert.strictEqual(Schema.decodeUnknownOption(DisplayPrefsChange)({ modelRecent: { model: -1 } })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("reads older display rows with colour defaults, merges colour patches and resets one choice", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const session = yield* api.GetSession()
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO settings(scope,scope_id,key,value_json,revision,updated_at) VALUES ('user', ?, 'display', ?, 1, 0)",
        params: [session.user.id, JSON.stringify({ reasoning: "collapsed" })]
      }
    ])
    assert.deepStrictEqual(yield* api.GetDisplayPrefs({}), { ...DEFAULT_DISPLAY_PREFS, reasoning: "collapsed" })
    yield* api.SetDisplayPrefs({ prefs: { mainTextColor: "#123456", italicsTextColor: "#654321" } })
    yield* api.SetDisplayPrefs({ prefs: { quoteTextColor: "#abcdef", underlineTextColor: "#fedcba" } })
    const secondClient = yield* client()
    assert.deepStrictEqual(yield* secondClient.GetDisplayPrefs({}), {
      ...DEFAULT_DISPLAY_PREFS,
      reasoning: "collapsed",
      mainTextColor: "#123456",
      italicsTextColor: "#654321",
      quoteTextColor: "#abcdef",
      underlineTextColor: "#fedcba"
    })
    yield* secondClient.SetDisplayPrefs({ prefs: { quoteTextColor: null } })
    const reset = yield* api.GetDisplayPrefs({})
    assert.isNull(reset.quoteTextColor)
    assert.strictEqual(reset.mainTextColor, "#123456")
    assert.strictEqual(reset.reasoning, "collapsed")
  }).pipe(withServer(config))
})

it("accepts only hex colour values or a reset, keeping CSS out of saved preferences", () => {
  const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
  for (const value of ["red", "#123", "#12345678", "var(--text)", "url(https://example.com/)"])
    assert.strictEqual(decode({ quoteTextColor: value })._tag, "None")
  assert.strictEqual(decode({ quoteTextColor: "#Aa1234" })._tag, "Some")
  assert.strictEqual(decode({ quoteTextColor: null })._tag, "Some")
})

it.live("Enter sends patches persist per account and do not reset unrelated display choices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).enterSends, "automatic")
    yield* alice.SetDisplayPrefs({ prefs: { enterSends: "never", coverageRail: true } })
    yield* alice.SetDisplayPrefs({ prefs: { reasoning: "collapsed" } })
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).enterSends, "automatic")
    yield* bob.SetDisplayPrefs({ prefs: { enterSends: "always" } })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.strictEqual(prefs.enterSends, "never")
    assert.strictEqual(prefs.coverageRail, true)
    assert.strictEqual(prefs.reasoning, "collapsed")
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).enterSends, "always")
    assert.strictEqual(Schema.decodeUnknownOption(DisplayPrefsChange)({ enterSends: "sometimes" })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("the chat width persists per account, within its range, without resetting other choices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).chatWidth, CHAT_WIDTH.default)
    yield* alice.SetDisplayPrefs({ prefs: { coverageRail: true } })
    yield* alice.SetDisplayPrefs({ prefs: { chatWidth: 1760 } })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.strictEqual(prefs.chatWidth, 1760)
    assert.strictEqual(prefs.coverageRail, true)
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).chatWidth, CHAT_WIDTH.default)
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    for (const value of [CHAT_WIDTH.min - 1, CHAT_WIDTH.max + 1, 1200.5, "1200px"])
      assert.strictEqual(decode({ chatWidth: value })._tag, "None")
    assert.strictEqual(decode({ chatWidth: CHAT_WIDTH.max })._tag, "Some")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("message spacing is comfortable until chosen, persists per account and keeps other choices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).chatDensity, "comfortable")
    yield* alice.SetDisplayPrefs({ prefs: { chatWidth: 1760 } })
    assert.strictEqual((yield* alice.SetDisplayPrefs({ prefs: { chatDensity: "compact" } })).chatDensity, "compact")
    const prefs = yield* (yield* client({ "Remote-User": "alice" })).GetDisplayPrefs({})
    assert.strictEqual(prefs.chatDensity, "compact")
    assert.strictEqual(prefs.chatWidth, 1760)
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).chatDensity, "comfortable")
    // Another choice written later leaves it.
    assert.strictEqual((yield* alice.SetDisplayPrefs({ prefs: { coverageRail: true } })).chatDensity, "compact")
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    for (const value of ["cosy", "", 1, null]) assert.strictEqual(decode({ chatDensity: value })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("message toolbar choices merge by action id per account, across clients, and stay bounded", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.deepStrictEqual((yield* alice.GetDisplayPrefs({})).messageToolbar, {})
    yield* alice.SetDisplayPrefs({ prefs: { messageToolbar: { "message.edit": false } } })
    // Another device of the same account, writing only its own change.
    const phone = yield* client({ "Remote-User": "alice" })
    yield* phone.SetDisplayPrefs({ prefs: { messageToolbar: { "message.copy-text": true, "plugin.unknown": true } } })
    yield* alice.SetDisplayPrefs({ prefs: { coverageRail: true } })
    assert.deepStrictEqual((yield* alice.GetDisplayPrefs({})).messageToolbar, {
      "message.edit": false,
      "message.copy-text": true,
      "plugin.unknown": true
    })
    yield* phone.SetDisplayPrefs({ prefs: { messageToolbar: { "message.edit": true } } })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).messageToolbar["message.edit"], true)
    assert.deepStrictEqual((yield* bob.GetDisplayPrefs({})).messageToolbar, {})
    // Past the cap the oldest choices go, and the rest of the account's choices still read.
    for (let batch = 0; batch < 3; batch++)
      yield* alice.SetDisplayPrefs({
        prefs: {
          messageToolbar: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`plugin.${batch}.${i}`, true]))
        }
      })
    const capped = yield* alice.GetDisplayPrefs({})
    assert.strictEqual(Object.keys(capped.messageToolbar).length, 200)
    assert.strictEqual(capped.messageToolbar["plugin.2.99"], true)
    assert.isUndefined(capped.messageToolbar["message.edit"])
    assert.strictEqual(capped.coverageRail, true)
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    assert.strictEqual(decode({ messageToolbar: { "message.edit": "yes" } })._tag, "None")
    assert.strictEqual(decode({ messageToolbar: { ["x".repeat(201)]: true } })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("message detail choices merge by detail id, apart from the toolbar's", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    assert.deepStrictEqual((yield* alice.GetDisplayPrefs({})).messageDetails, {})
    yield* alice.SetDisplayPrefs({ prefs: { messageDetails: { "message.tokens": false } } })
    const phone = yield* client({ "Remote-User": "alice" })
    yield* phone.SetDisplayPrefs({ prefs: { messageDetails: { "message.model-icon": false } } })
    yield* phone.SetDisplayPrefs({ prefs: { messageToolbar: { "message.edit": false } } })
    const prefs = yield* alice.GetDisplayPrefs({})
    assert.deepStrictEqual(prefs.messageDetails, { "message.tokens": false, "message.model-icon": false })
    assert.deepStrictEqual(prefs.messageToolbar, { "message.edit": false })
    yield* alice.SetDisplayPrefs({ prefs: { messageDetails: { "message.tokens": true } } })
    assert.deepStrictEqual((yield* phone.GetDisplayPrefs({})).messageDetails, {
      "message.model-icon": false,
      "message.tokens": true
    })
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("explanation dismissals merge by box id and stay within the account", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const phone = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.deepStrictEqual((yield* alice.GetDisplayPrefs({})).dismissedInfo, {})
    yield* alice.SetDisplayPrefs({ prefs: { dismissedInfo: { "snippets.intro": true } } })
    yield* phone.SetDisplayPrefs({ prefs: { dismissedInfo: { "another.intro": true } } })
    yield* phone.SetDisplayPrefs({ prefs: { coverageRail: true } })
    assert.deepStrictEqual((yield* alice.GetDisplayPrefs({})).dismissedInfo, {
      "snippets.intro": true,
      "another.intro": true
    })
    assert.deepStrictEqual((yield* bob.GetDisplayPrefs({})).dismissedInfo, {})
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("message spacing leaves the complete model request byte-identical", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Noted."], {})))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { chat, version, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      greeting: "Synthetic harbor greeting.",
      content: "The tide rose."
    })
    const before = mock
      .requests()
      .filter((r) => r.path.endsWith("/chat/completions"))
      .at(-1)!.raw
    assert.isString(before)
    yield* api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } })
    const row = (yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }))
      .entries[0]!
    assert.strictEqual(row.version.id, version.id)
    const again = yield* api.Regenerate({ slotId: row.slotId, expectedRowVersion: row.rowVersion })
    yield* eventually(() => finished(events, again.version.id) !== undefined)
    assert.strictEqual(
      mock
        .requests()
        .filter((r) => r.path.endsWith("/chat/completions"))
        .at(-1)!.raw,
      before
    )
  }).pipe(Effect.scoped, withServer(testConfig()))
)
