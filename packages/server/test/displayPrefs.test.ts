import { assert, it } from "@effect/vitest"
import { CHAT_WIDTH, DEFAULT_DISPLAY_PREFS, DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { WorkbenchDevice } from "@rp/shared/workbenchApi.ts"
import { Effect, Schema } from "effect"
import { client, testConfig, withServer } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("reads older display rows with colour defaults, merges colour patches and resets one choice", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const session = yield* api.GetSession()
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO user_prefs(user_id,key,value_json) VALUES (?, 'display', ?)",
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

it.live("each device keeps its own workbench layout, and an account keeps its 20 latest devices'", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const phone = JSON.stringify({ frames: "phone" })
    const desktop = JSON.stringify({ frames: "desktop" })
    yield* alice.SetWorkbenchLayout({ device: "phone", layout: phone })
    yield* alice.SetWorkbenchLayout({ device: "desktop", layout: desktop })
    assert.strictEqual(yield* alice.GetWorkbenchLayout({ device: "phone" }), phone)
    assert.strictEqual(yield* alice.GetWorkbenchLayout({ device: "desktop" }), desktop)
    assert.isNull(yield* alice.GetWorkbenchLayout({ device: "tablet" }))
    assert.isNull(yield* bob.GetWorkbenchLayout({ device: "phone" }))
    // Not an object: dropped, the device's layout stays.
    yield* alice.SetWorkbenchLayout({ device: "phone", layout: "[1]" })
    assert.strictEqual(yield* alice.GetWorkbenchLayout({ device: "phone" }), phone)
    // The phone saves again, then 19 new devices: the desktop, saved least recently, goes.
    yield* alice.SetWorkbenchLayout({ device: "phone", layout: phone })
    for (let index = 0; index < 19; index++)
      yield* alice.SetWorkbenchLayout({ device: `other-${index}`, layout: JSON.stringify({ index }) })
    assert.isNull(yield* alice.GetWorkbenchLayout({ device: "desktop" }))
    assert.strictEqual(yield* alice.GetWorkbenchLayout({ device: "phone" }), phone)
    assert.strictEqual(yield* alice.GetWorkbenchLayout({ device: "other-0" }), JSON.stringify({ index: 0 }))
    const reconnect = yield* client({ "Remote-User": "alice" })
    assert.strictEqual(yield* reconnect.GetWorkbenchLayout({ device: "other-18" }), JSON.stringify({ index: 18 }))
    const decode = Schema.decodeUnknownOption(WorkbenchDevice)
    for (const value of ["", "a/b", "x".repeat(65), "a b"]) assert.strictEqual(decode(value)._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
